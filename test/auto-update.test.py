import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import io
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('auto_update', Path(__file__).resolve().parents[1] / 'deploy/auto-update.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
OLD, NEW = 'a' * 40, 'b' * 40

class Fake(m.Updater):
    def __init__(self):
        self.state = {'current': {'sha': OLD, 'release': '/old'}}
        self.events = []
        self.fail = None
    def render(self, item): self.events.append('render')
    def build(self, item):
        self.events.append('build')
        if self.fail == 'build': raise RuntimeError()
    def backup(self): self.events.append('backup')
    def violations(self, candidate): return self.problems if hasattr(self, 'problems') else []
    def migrate(self, candidate):
        self.events.append('migrate')
        if self.fail == 'migrate': raise RuntimeError()
        return True
    def remote_head(self): return NEW
    def approved(self, sha): return True
    def save(self, status, **fields):
        self.events.append(status)
        self.state.update(last_status=status, **fields)
    def activate(self, item): self.events.append('activate:' + item['sha'])
    def health(self, item):
        self.events.append('health:' + item['sha'])
        if self.fail == 'health' and item['sha'] == NEW: raise RuntimeError()
        if self.fail == 'rollback': raise RuntimeError()

class Tests(unittest.TestCase):
    def test_docker_config_is_private_and_has_no_credential_helper(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as home:
            for name in ('contexts', 'buildx', 'cli-plugins'): (Path(home) / '.docker' / name).mkdir(parents=True)
            (Path(home) / '.docker/config.json').write_text(json.dumps({'credsStore': 'desktop'}))
            directory = Path(m.isolated_docker_config(root, home))
            config = json.loads((directory / 'config.json').read_text())
            self.assertNotIn('credsStore', config)
            self.assertEqual(config['currentContext'], 'orbstack')
            for name in ('contexts', 'buildx', 'cli-plugins'): self.assertEqual((directory / name).resolve(), (Path(home) / '.docker' / name).resolve())
            self.assertEqual(m.isolated_docker_config(root, home), str(directory))

    def test_run_uses_the_private_docker_config(self):
        with tempfile.TemporaryDirectory() as root:
            u = Fake(); u.root = Path(root)
            seen = u.run([__import__('sys').executable, '-c', 'import os;print(os.environ["DOCKER_CONFIG"])'], capture=True).strip()
            self.assertEqual(seen, str(Path(root) / 'docker-config'))

    def test_ci_requires_exact_successful_main_push(self):
        run = dict(id=1, run_attempt=1, head_sha=NEW, head_branch='main', event='push', path='.github/workflows/verify.yml', status='completed', conclusion='success')
        self.assertTrue(m.ci_passed({'workflow_runs': [run]}, NEW))
        for field, value in [('head_sha', OLD), ('head_branch', 'feature'), ('event', 'pull_request'), ('path', 'other.yml'), ('status', 'in_progress'), ('conclusion', 'failure')]:
            self.assertFalse(m.ci_passed({'workflow_runs': [dict(run, **{field: value})]}, NEW))
        self.assertFalse(m.ci_passed({'workflow_runs': [run, dict(run, id=2, conclusion='failure')]}, NEW))
        self.assertFalse(m.ci_passed({'workflow_runs': [run, dict(run, run_attempt=2, status='in_progress')]}, NEW))
    def test_atomic_state_permissions_and_failed_write(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'state.json'
            m.atomic_json(p, {'value': 1})
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            with patch.object(m.os, 'replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError): m.atomic_json(p, {'value': 2})
            self.assertEqual(json.loads(p.read_text()), {'value': 1})
            self.assertEqual(list(Path(folder).glob('.state-*')), [])
            link = Path(folder) / 'link'
            link.symlink_to(p)
            with self.assertRaises(RuntimeError): m.atomic_json(link, {})
    def test_success_and_backup_before_cutover(self):
        u = Fake()
        u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['current']['sha'], NEW)
        self.assertEqual(u.state['previous']['sha'], OLD)
        self.assertLess(u.events.index('backup'), u.events.index('activate:' + NEW))
    def test_public_failure_restores_previous_without_restoring_database(self):
        u = Fake(); u.fail = 'health'
        with self.assertRaises(RuntimeError): u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertEqual(u.state['failed_sha'], NEW)
        self.assertIsNone(u.state['pending'])
        self.assertEqual(u.events[-1], 'rolled_back')
        self.assertIn('health:' + OLD, u.events)
    def test_failed_rollback_retains_recovery_marker(self):
        u = Fake(); u.fail = 'rollback'
        with self.assertRaises(RuntimeError): u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['pending']['sha'], NEW)
        self.assertEqual(u.state['last_status'], 'rollback_failed')
    def test_failed_build_does_not_cut_over_or_retry_same_release(self):
        u = Fake(); u.fail = 'build'
        with self.assertRaises(RuntimeError): u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['failed_sha'], NEW)
        self.assertNotIn('activate:' + NEW, u.events)
        u.poll()
        self.assertEqual(u.events[-1], 'failed_release_waiting')
    def test_superseded_build_does_not_cut_over(self):
        u = Fake(); u.remote_head = lambda: OLD
        u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertNotIn('activate:' + NEW, u.events)
    def test_interrupted_cutover_restores_recorded_current(self):
        u = Fake(); u.state['pending'] = {'sha': NEW, 'release': '/new'}
        u.recover()
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertEqual(u.state['failed_sha'], NEW)
        self.assertIsNone(u.state['pending'])
    def test_public_checks_identify_monitor_and_validate_revision(self):
        u = object.__new__(m.Updater)
        def response(request, timeout):
            self.assertEqual(request.get_header('User-agent'), 'OnlineShoppingDeploy/1.0')
            status = 'ready' if request.full_url.endswith('/ready') else 'alive'
            return io.BytesIO(json.dumps({'status': status, 'revision': OLD}).encode())
        # Wrong public revision must fail before container inspection.
        with patch.object(m.urllib.request, 'urlopen', side_effect=response):
            with self.assertRaises(RuntimeError): u.health({'sha': NEW})
    def test_pending_ci_keeps_live_release_unchanged(self):
        u = Fake(); u.approved = lambda sha: False
        u.checkout = lambda sha: self.fail('Unapproved checkout attempted')
        u.poll()
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertEqual(u.state['last_status'], 'waiting_for_ci')
        self.assertNotIn('build', u.events)
    def test_infrastructure_change_pauses_release(self):
        u = Fake(); u.checkout = lambda sha: '/new'
        with patch.object(m, 'fingerprint', side_effect=[{'tunnel': 'a'}, {'tunnel': 'b'}]): u.poll()
        self.assertEqual(u.state['last_status'], 'manual_migration_required')
        self.assertNotIn('build', u.events)

    def test_schema_upgrade_runs_after_backup_and_before_cutover(self):
        u = Fake()
        u.deploy({'sha': NEW, 'release': '/new'})
        self.assertLess(u.events.index('backup'), u.events.index('migrate'))
        self.assertLess(u.events.index('migrate'), u.events.index('activate:' + NEW))
        self.assertEqual(u.state['current']['sha'], NEW)

    def test_failed_schema_upgrade_never_cuts_over(self):
        u = Fake(); u.fail = 'migrate'
        with self.assertRaises(RuntimeError): u.deploy({'sha': NEW, 'release': '/new'})
        self.assertNotIn('activate:' + NEW, u.events)
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertEqual(u.state['last_status'], 'migration_failed')
        self.assertEqual(u.state['failed_sha'], NEW)

    def test_compose_policy_violation_pauses_before_build(self):
        u = Fake(); u.problems = ['service postgres changed']
        u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['last_status'], 'manual_migration_required')
        self.assertEqual(u.state['reasons'], ['service postgres changed'])
        for event in ('build', 'backup', 'migrate', 'activate:' + NEW): self.assertNotIn(event, u.events)

    def test_schema_version_is_read_from_the_release(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'src').mkdir(); (Path(folder) / 'src/db.js').write_text('export const SCHEMA_VERSION = 18;\n')
            self.assertEqual(m.schema_version(folder), 18)

    def test_migrate_skips_when_the_schema_is_unchanged_and_refuses_downgrades(self):
        with tempfile.TemporaryDirectory() as old, tempfile.TemporaryDirectory() as new:
            for folder, version in ((old, 17), (new, 17)):
                (Path(folder) / 'src').mkdir(); (Path(folder) / 'src/db.js').write_text(f'export const SCHEMA_VERSION = {version};\n')
            u = object.__new__(m.Updater); u.state = {'current': {'sha': OLD, 'release': old}}
            self.assertFalse(u.migrate({'sha': NEW, 'release': new}))
            (Path(new) / 'src/db.js').write_text('export const SCHEMA_VERSION = 16;\n')
            with self.assertRaises(RuntimeError): u.migrate({'sha': NEW, 'release': new})

    def test_migrate_runs_the_candidate_image_as_owner_and_checks_the_version(self):
        with tempfile.TemporaryDirectory() as old, tempfile.TemporaryDirectory() as new, tempfile.TemporaryDirectory() as root:
            for folder, version in ((old, 17), (new, 18)):
                (Path(folder) / 'src').mkdir(); (Path(folder) / 'src/db.js').write_text(f'export const SCHEMA_VERSION = {version};\n')
            (Path(root) / 'runtime.env').write_text('DATABASE_OWNER_PASSWORD_FILE_HOST=/secrets/owner\n')
            u = object.__new__(m.Updater); u.root = Path(root); u.state = {'current': {'sha': OLD, 'release': old}}
            seen = []
            def fake_run(command, **kw): seen.append(command); return 'noise\n{"version": 18}\n'
            u.run = fake_run
            self.assertTrue(u.migrate({'sha': NEW, 'release': new}))
            command = seen[0]
            self.assertIn('online-shopping-backend:' + NEW, command)
            self.assertIn('/secrets/owner:/run/secrets/owner:ro', command)
            self.assertIn(m.PROJECT + '_private', command)
            u.run = lambda command, **kw: '{"version": 17}\n'
            with self.assertRaises(RuntimeError): u.migrate({'sha': NEW, 'release': new})

    def test_compose_policy(self):
        R1, R2 = '/r/old', '/r/new'
        base = lambda r: {'services': {
            'postgres': {'image': 'pg', 'volumes': [{'type': 'bind', 'source': r + '/deploy/init.sh', 'target': '/i'}]},
            'tunnel': {'image': 'cf'}, 'backend': {'image': 'app', 'environment': {'A': '1'}}},
            'secrets': {'s': {'file': '/secret'}}, 'volumes': {'pg_data': {}}, 'networks': {'private': {'internal': True}}}
        old = base(R1)
        # Application changes, new secrets and a new loopback-only service are fine; release paths are ignored.
        new = base(R2); new['services']['backend']['environment']['B'] = '2'
        new['services']['qr'] = {'image': 'qr', 'ports': [{'host_ip': '127.0.0.1', 'published': '9'}]}
        new['secrets']['extra'] = {'file': '/x'}
        self.assertEqual(m.compose_violations(old, new, R1, R2), [])
        for label, mutate in [
            ('postgres image', lambda c: c['services']['postgres'].update(image='other')),
            ('tunnel removed', lambda c: c['services'].pop('tunnel')),
            ('secret path', lambda c: c['secrets']['s'].update(file='/elsewhere')),
            ('volume removed', lambda c: c['volumes'].pop('pg_data')),
            ('privileged', lambda c: c['services']['backend'].update(privileged=True)),
            ('host network', lambda c: c['services']['backend'].update(network_mode='host')),
            ('docker socket', lambda c: c['services']['backend'].update(volumes=[{'type': 'bind', 'source': '/var/run/docker.sock', 'target': '/s'}])),
            ('public port', lambda c: c['services']['backend'].update(ports=[{'host_ip': '0.0.0.0', 'published': '80'}])),
            ('open port', lambda c: c['services']['backend'].update(ports=[{'published': '80'}])),
        ]:
            bad = base(R2); mutate(bad)
            self.assertTrue(m.compose_violations(old, bad, R1, R2), label)

if __name__ == '__main__': unittest.main()
