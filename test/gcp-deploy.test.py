#!/usr/bin/env python3
"""Offline acceptance tests: no Docker, GitHub, DB or provider calls."""
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from collections import namedtuple

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gcp_update', ROOT / 'deploy/gcp/update.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
A, B = 'a' * 40, 'b' * 40
BASE = {'protected': {'deploy/init-postgres.sh': 'unchanged'}, 'schema': 24}


def release(sha):
    return {'sha': sha, 'baseline': BASE, **{c: 'ghcr.io/yapweijun1996/online-shopping-' + c + '@sha256:' + ('1' if sha == A else '2') * 64 for c in ('backend', 'frontend')}}


def run(**fields):
    result = dict(id=1, run_attempt=1, head_sha=B, head_branch='main', event='push',
                  path='.github/workflows/verify.yml', repository={'full_name': u.REPO},
                  head_repository={'full_name': u.REPO}, status='completed', conclusion='success')
    result.update(fields)
    return result


class Fake(u.Updater):
    def __init__(self, root):
        super().__init__(root)
        self.calls = []
        self.remote = B
        self.ci = True
        self.baseline = BASE
        self.fail = False
        self.state = dict(current=release(A), previous=None, pending=None, local={})
    def local_fingerprint(self): return {}
    def head(self): return self.remote
    def approved(self, sha): return self.ci
    def source(self, sha): return self.baseline, {}
    def release(self, sha, baseline, content):
        self.calls.append('pull')
        return release(sha)
    def activate(self, item, initial=False): self.calls.append(('activate', item['sha']))
    def health(self, item):
        self.calls.append(('health', item['sha']))
        if self.fail and item['sha'] == B: raise RuntimeError('secret must not escape')


class Tests(unittest.TestCase):
    def test_ci_latest_attempt_and_scope(self):
        self.assertTrue(u.ci_passed({'workflow_runs': [run()]}, B))
        self.assertFalse(u.ci_passed({'workflow_runs': [run(), run(run_attempt=2, conclusion='failure')]}, B))
        self.assertFalse(u.ci_passed({'workflow_runs': [run(), run(id=2, status='in_progress', conclusion=None)]}, B))
        for changed in [dict(head_branch='other'), dict(event='pull_request'), dict(head_sha=A),
                        dict(repository={'full_name': 'evil/repo'}), dict(head_repository={'full_name': 'evil/repo'}),
                        dict(path='other.yml'), dict(run_attempt=None)]:
            self.assertFalse(u.ci_passed({'workflow_runs': [run(**changed)]}, B))
        self.assertFalse(u.ci_passed({'workflow_runs': [run()], 'total_count': 101}, B))

    def test_idempotency_and_ci(self):
        with tempfile.TemporaryDirectory() as root:
            f = Fake(root)
            f.remote = A
            f.poll()
            self.assertEqual([], f.calls)
            f.remote, f.ci = B, False
            f.poll()
            self.assertEqual([], f.calls)
            self.assertEqual('waiting_for_ci', f.state['status'])
            f.ci = True
            f.poll()
            self.assertEqual(B, f.state['current']['sha'])
            self.assertEqual(A, f.state['previous']['sha'])
            count = len(f.calls)
            f.poll()
            self.assertEqual(count, len(f.calls))
            self.assertEqual(B, json.loads(Path(root, 'state.json').read_text())['current']['sha'])

    def test_failed_health_rolls_back_images(self):
        with tempfile.TemporaryDirectory() as root:
            f = Fake(root)
            f.fail = True
            with self.assertRaisesRegex(RuntimeError, '^Application update rolled back$'):
                f.poll()
            self.assertEqual(A, f.state['current']['sha'])
            self.assertEqual('rolled_back', f.state['status'])
            self.assertEqual([('activate', B), ('activate', A)], [c for c in f.calls if isinstance(c, tuple) and c[0] == 'activate'])
            count = len(f.calls)
            f.poll()
            self.assertEqual(count, len(f.calls))

    def test_schema_protected_and_local_changes_stop_before_pull(self):
        for baseline in [dict(BASE, schema=25), dict(BASE, protected={'changed': 'blob'})]:
            with tempfile.TemporaryDirectory() as root:
                f = Fake(root)
                f.baseline = baseline
                f.poll()
                self.assertEqual('manual_release_required', f.state['status'])
                self.assertEqual([], f.calls)
        with tempfile.TemporaryDirectory() as root:
            f = Fake(root)
            f.state['local'] = {'runtime.env': 'changed'}
            f.poll()
            self.assertEqual('manual_config_required', f.state['status'])
            self.assertEqual([], f.calls)

    def test_crash_recovery_and_rollback_failure_preserve_intent(self):
        with tempfile.TemporaryDirectory() as root:
            f = Fake(root)
            f.state['pending'] = release(B)
            f.poll()
            self.assertEqual([('activate', A), ('health', A)], f.calls)
            self.assertIsNone(f.state['pending'])
        with tempfile.TemporaryDirectory() as root:
            f = Fake(root)
            f.fail = True
            with patch.object(f, 'activate', side_effect=RuntimeError('secret')):
                with self.assertRaises(RuntimeError): f.poll()
            self.assertEqual(B, f.state['pending']['sha'])
            self.assertEqual(A, f.state['current']['sha'])

    def test_invalid_revision_images_and_atomic_symlink(self):
        for bad in ['main', '../' + B, 'B' * 40, B + '\n', None]:
            with self.assertRaises(ValueError): u.revision(bad)
        with tempfile.TemporaryDirectory() as root:
            f = Fake(root)
            bad = release(A)
            bad['backend'] = 'evil/image:latest'
            with self.assertRaises(ValueError): f.validate_release(bad)
            target = Path(root, 'secret')
            target.write_text('private')
            link = Path(root, 'state.json')
            link.symlink_to(target)
            with self.assertRaises(ValueError): u.atomic(link, b'new')
            self.assertEqual('private', target.read_text())
            with self.assertRaises(ValueError): u.trusted('relative')
            with self.assertRaises(ValueError): u.trusted(link)

    def test_anonymous_digest_and_label_validation(self):
        with tempfile.TemporaryDirectory() as root:
            f = u.Updater(root)
            info = {'Architecture': 'amd64', 'Os': 'linux', 'Config': {'Labels': {'org.opencontainers.image.revision': A}}, 'RepoDigests': [release(A)['backend']]}
            with patch.object(f, 'docker', side_effect=['', json.dumps(info)]) as docker:
                self.assertEqual(release(A)['backend'], f.image('backend', A))
                self.assertEqual(('pull', '--platform', 'linux/amd64', 'ghcr.io/yapweijun1996/online-shopping-backend:' + A), docker.call_args_list[0].args)
            for label in (B, None):
                info['Config']['Labels']['org.opencontainers.image.revision'] = label
                with patch.object(f, 'docker', side_effect=['', json.dumps(info)]):
                    with self.assertRaises(ValueError): f.image('backend', A)

    @unittest.skipUnless(shutil.which('node'), 'Node is required for the HTTP virtual-host fixture')
    def test_frontend_probe_preserves_host_and_rejects_failure(self):
        # Rewire only the fixed network destination to a local ephemeral fixture;
        # keep the production request's Host/path and actual node:http behavior.
        for status, oversized in ((200, False), (404, False), (200, True)):
            body = json.dumps({'status': 'ready', 'revision': A})
            fixture = (
                "const fixtureHttp=require('node:http');const original=fixtureHttp.get;"
                "const server=fixtureHttp.createServer((req,res)=>{"
                "if(req.headers.host!=='demoonlineshopping.xyz'||req.url!=='/ready')process.exit(9);"
                "res.writeHead(" + str(status) + ");res.end(" + json.dumps('x' * 16385 if oversized else body) + ");"
                "server.close();});server.listen(0,'127.0.0.1',()=>{"
                "fixtureHttp.get=(options,callback)=>original({...options,hostname:'127.0.0.1',port:server.address().port},callback);"
                + u.frontend_probe('demoonlineshopping.xyz') + "});")
            result = subprocess.run(['node', '-e', fixture], capture_output=True, text=True, timeout=8)
            self.assertEqual(0 if status == 200 and not oversized else 1, result.returncode)
            if result.returncode == 0:
                self.assertEqual({'status': 'ready', 'revision': A}, json.loads(result.stdout))
            else:
                self.assertEqual('', result.stdout)

    def test_disk_low_water_blocks_pull(self):
        with tempfile.TemporaryDirectory() as root:
            f = u.Updater(root)
            disk = namedtuple('Disk', 'total used free')(20 * 1024 ** 3, 18 * 1024 ** 3, 2 * 1024 ** 3)
            with patch.object(u.shutil, 'disk_usage', return_value=disk), patch.object(f, 'docker') as docker:
                with self.assertRaisesRegex(RuntimeError, '^Insufficient disk reserve$'):
                    f.image('backend', A)
                docker.assert_not_called()

    def test_no_secret_output_from_command_failure(self):
        with tempfile.TemporaryDirectory() as root:
            f = u.Updater(root)
            with self.assertRaisesRegex(RuntimeError, '^Command failed$') as error:
                f.command(['/bin/sh', '-c', 'echo private-value; exit 1'])
            self.assertNotIn('private-value', str(error.exception))
            self.assertNotIn('shell=True', (ROOT / 'deploy/gcp/update.py').read_text())

    def test_runtime_config_rejects_injection_and_unknown_keys(self):
        with tempfile.TemporaryDirectory() as root:
            f = u.Updater(root)
            path = Path(root, 'runtime.env')
            good = 'SHOP_HOST=demoonlineshopping.xyz\nSELLER_HOST=seller.demoonlineshopping.xyz\nADMIN_USERNAME=owner\nSECRETS_DIR=/opt/cloudops/secrets/online-shopping\n'
            path.write_text(good)
            self.assertEqual('owner', f.runtime()['ADMIN_USERNAME'])
            for size in (3, 64):
                path.write_text(good.replace('ADMIN_USERNAME=owner', 'ADMIN_USERNAME=' + 'a' * size))
                self.assertEqual('a' * size, f.runtime()['ADMIN_USERNAME'])
            for bad in [good.replace('ADMIN_USERNAME=owner', 'ADMIN_USERNAME=ab'),
                        good.replace('ADMIN_USERNAME=owner', 'ADMIN_USERNAME=' + 'a' * 65),
                        good + 'BACKEND_IMAGE=evil\n', good.replace('owner', '$(touch /tmp/pwn)'),
                        good.replace('SECRETS_DIR=/opt', 'SECRETS_DIR=/../opt'),
                        good.replace('seller.demoonlineshopping.xyz', 'demoonlineshopping.xyz'),
                        good.replace('demoonlineshopping.xyz', 'example.com:8000')]:
                path.write_text(bad)
                with self.assertRaises(ValueError): f.runtime()

    def test_immutable_compose_no_public_ports_or_socket(self):
        compose = (ROOT / 'compose.gcp.yaml').read_text()
        self.assertNotIn('ports:', compose)
        self.assertNotIn('docker.sock', compose)
        self.assertNotIn('build:', compose)
        self.assertNotIn('INTEGRATION_KEY', compose)
        self.assertIn('internal: true', compose)
        self.assertIn('PLATFORM_ENABLED: "0"', compose)
        self.assertIn('online_shopping_app', compose)


if __name__ == '__main__': unittest.main()
