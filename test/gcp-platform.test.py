#!/usr/bin/env python3
"""Offline platform enablement acceptance; never calls Docker or a network."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('enable', ROOT/'deploy/gcp/enable-platform.py')
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)


class Fake:
    def __init__(self):
        self.roles = []
        self.database = ''
        self.sql = []
        self.commands = []
        self.auth_failure = None
        self.authentications = []
        self.schema = ''
        self.tables = ''
    def __call__(self, argv, sql=None):
        self.commands.append(argv)
        if sql is None:
            if argv[-3:-1] == ['node', '-e']:
                self.authentications.append('backend')
                if self.auth_failure: raise RuntimeError('sensitive-private-password')
                return '{"status":"ready"}'
            raise AssertionError('Unexpected process: migration must not run from the image')
        self.sql.append(sql)
        if sql.startswith("SELECT to_regclass"): return 'schema_meta' if self.schema else ''
        if sql.startswith('SELECT version'): return self.schema
        if sql.startswith('SELECT tablename'):
            assert argv[argv.index('-d') + 1] == 'platform'
            return self.tables
        if sql.startswith('SELECT rolname'): return '\n'.join(sorted(self.roles))
        if sql.startswith('SELECT COALESCE'): return 'createrole_self_grant=set, inherit'
        if sql.startswith('SELECT pg_get'): return self.database
        if 'CREATE ROLE platform_app ' in sql: self.roles.append('platform_app|false|false|false|true')
        elif 'CREATE ROLE platform_provisioner ' in sql: self.roles.append('platform_provisioner|false|true|true|true')
        elif sql.startswith('CREATE DATABASE'): self.database = 'platform_app|false'
        elif sql.startswith('REVOKE'): self.database = 'platform_app|true'
        else: raise AssertionError('Unexpected SQL')
        return ''


class Tests(unittest.TestCase):
    def fixture(self, root):
        root = Path(root)
        (root/'runtime.env').write_text((ROOT/'deploy/gcp/runtime.env.example').read_text().replace('/opt/cloudops/secrets/online-shopping', str(root)))
        runner = Fake()
        p = e.Provisioner(root, runner)
        return p, runner

    def test_fresh_secrets_need_no_stack_and_provision_requires_secrets(self):
        with tempfile.TemporaryDirectory() as root:
            p, runner = self.fixture(root)
            module = e.load_updater()
            module.trusted = lambda path, directory=False: Path(path)
            with patch.object(e, 'load_updater', return_value=module), patch.object(p, 'preflight', side_effect=AssertionError('No stack')), patch.object(e.os, 'fchown'):
                self.assertEqual('ready', p.run(step='secrets')['status'])
            self.assertEqual([], runner.sql)
            for name in ('integration-keys', 'platform-password', 'provisioner-password'):
                self.assertEqual(0o600, (Path(root)/name).stat().st_mode & 0o777)
            (Path(root)/'platform-password').unlink()
            with patch.object(p, 'preflight'), patch.object(p, 'secret', return_value=None):
                with self.assertRaises(ValueError): p.run(step='provision')
            self.assertTrue(all(sql.startswith('SELECT') for sql in runner.sql))

    def test_check_is_read_only_and_reports_missing(self):
        with tempfile.TemporaryDirectory() as root:
            p, runner = self.fixture(root)
            before = set(Path(root).iterdir())
            with patch.object(p, 'preflight'):
                with self.assertRaisesRegex(ValueError, 'readiness failed'): p.run(True)
            self.assertEqual(before, set(Path(root).iterdir()))
            self.assertTrue(all(sql.startswith('SELECT') for sql in runner.sql))

    def test_apply_resume_and_second_apply_do_not_rewrite(self):
        with tempfile.TemporaryDirectory() as root:
            p, runner = self.fixture(root)
            values = {name: 'sensitive-' + name + 'x'*32 for name in ('integration-keys', 'platform-password', 'provisioner-password')}
            def secret(name, check=False):
                if name not in values and not check: values[name] = 'sensitive-' + name + 'x'*32
                return values.get(name)
            output = io.StringIO()
            with patch.object(p, 'preflight'), patch.object(p, 'secret', side_effect=secret), contextlib.redirect_stdout(output):
                self.assertEqual('ready', p.run()['status'])
                first = dict(values)
                runner.sql.clear()
                self.assertEqual('ready', p.run()['status'])
                self.assertTrue(all(sql.startswith('SELECT') for sql in runner.sql))
                self.assertEqual(first, values)
                self.assertFalse(any('scripts/upgrade-platform.mjs' in argv for argv in runner.commands))
                self.assertEqual('ready', p.run(True)['status'])
                self.assertEqual(['backend'] * 3, runner.authentications)
            self.assertNotIn('sensitive', output.getvalue())
            self.assertFalse(any('online_shopping;' in sql for sql in runner.sql))

    def test_claim_schema_provisioning_gate(self):
        for version in ('', '1', '2', '3'):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as root:
                p, runner = self.fixture(root)
                runner.schema = version
                with patch.object(p, 'preflight'), patch.object(p, 'secret', return_value='private'):
                    if version in ('1', '3'):
                        with self.assertRaisesRegex(ValueError, 'private'):
                            p.run()
                        with self.assertRaisesRegex(ValueError, 'private'):
                            p.run(True)
                    else:
                        result = p.run()
                        self.assertEqual('ready', result['status'])
                        self.assertIn('empty' if not version else 'v2', result['claimSchema'])
                        self.assertEqual('ready', p.run(True)['status'])
                self.assertFalse(any('--with-claim' in argv for argv in runner.commands))
                self.assertTrue(any(argv[argv.index('-d') + 1] == 'platform'
                                    for argv in runner.commands if '-d' in argv))

    def test_missing_metadata_requires_zero_public_tables(self):
        for check in (False, True):
            for tables in ('', 'private_existing_table'):
                with self.subTest(check=check, tables=tables), tempfile.TemporaryDirectory() as root:
                    p, runner = self.fixture(root)
                    runner.roles = ['platform_app|false|false|false|true', 'platform_provisioner|false|true|true|true']
                    runner.database = 'platform_app|true'
                    runner.tables = tables
                    with patch.object(p, 'preflight'), patch.object(p, 'secret', return_value='private'):
                        if tables:
                            with self.assertRaisesRegex(ValueError, '^Unsupported platform schema; private reconciliation required$'):
                                p.run(check)
                        else:
                            self.assertEqual('ready', p.run(check)['status'])
                    self.assertTrue(all(sql.startswith('SELECT') for sql in runner.sql))

    def test_credential_mismatch_is_private_and_never_resets_passwords(self):
        for role in ('platform_app', 'platform_provisioner'):
            for check in (False, True):
                with self.subTest(role=role, check=check), tempfile.TemporaryDirectory() as root:
                    p, runner = self.fixture(root)
                    runner.roles = ['platform_app|false|false|false|true', 'platform_provisioner|false|true|true|true']
                    runner.database = 'platform_app|true'
                    runner.auth_failure = role
                    output, errors = io.StringIO(), io.StringIO()
                    with patch.object(p, 'preflight'), patch.object(p, 'secret', return_value='sensitive-private-password'), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                        with self.assertRaisesRegex(ValueError, 'private reconciliation') as failure:
                            p.run(check)
                    self.assertNotIn('sensitive', str(failure.exception) + output.getvalue() + errors.getvalue() + repr(runner.commands))
                    self.assertTrue(all(sql.startswith('SELECT') for sql in runner.sql))
                    self.assertFalse(any('--with-claim' in argv for argv in runner.commands))

    def test_incompatible_objects_and_missing_password_refused(self):
        with tempfile.TemporaryDirectory() as root:
            p, runner = self.fixture(root)
            with patch.object(p, 'preflight'):
                runner.roles = ['platform_app|true|false|false|true']
                with self.assertRaises(ValueError): p.run()
                runner.roles = ['platform_app|false|false|false|true']
                with self.assertRaises(ValueError): p.run()
            self.assertTrue(all(sql.startswith('SELECT') for sql in runner.sql))

    def test_existing_secret_preserved_and_unsafe_refused(self):
        with tempfile.TemporaryDirectory() as root:
            p, _ = self.fixture(root)
            path = Path(root)/'platform-password'
            path.write_text('a'*48+'\n')
            path.chmod(0o600)
            info = path.stat()
            # Simulate deployed node ownership without requiring root locally.
            fake = type('Stat', (), {'st_mode':info.st_mode, 'st_uid':1000})()
            with patch.object(Path, 'lstat', return_value=fake):
                self.assertEqual('a'*48, p.secret('platform-password'))
            self.assertEqual('a'*48+'\n', path.read_text())
            path.chmod(0o644)
            with self.assertRaises(ValueError): p.secret('platform-password')

    def test_failure_output_is_secret_safe(self):
        with patch.object(e.sys, 'platform', 'linux'), patch.object(e.os, 'geteuid', return_value=0), patch.object(e.sys, 'argv', ['enable-platform.py', 'provision']), patch.object(e, 'Provisioner', side_effect=RuntimeError('private-password')):
            output = io.StringIO()
            with contextlib.redirect_stderr(output): self.assertEqual(1, e.main())
            self.assertNotIn('private-password', output.getvalue())

    def test_runtime_defaults_and_invalid_switches(self):
        with tempfile.TemporaryDirectory() as root:
            p, _ = self.fixture(root)
            self.assertEqual('0', p.env['PLATFORM_ENABLED'])
            self.assertEqual('0', p.env['PLATFORM_ADMIN_CLAIM_ENABLED'])
            self.assertEqual('', p.env['INTEGRATION_KEY_FILE'])
            path = Path(root)/'runtime.env'
            good = path.read_text()
            for text in (good.replace('PLATFORM_ENABLED=0','PLATFORM_ENABLED=2'), good.replace('INTEGRATION_KEY_FILE=','INTEGRATION_KEY_FILE=$(bad)'), good.replace('PLATFORM_ENABLED=0','PLATFORM_ENABLED=1')):
                path.write_text(text)
                with self.assertRaises(ValueError): e.Provisioner(root, Fake())

    def test_preflight_rejects_unhealthy_and_wrong_project(self):
        with tempfile.TemporaryDirectory() as root:
            p, _ = self.fixture(root)
            Path(root).chmod(0o700)
            release = Path(root)/'releases'/('a'*40)
            (Path(root)/'images.env').write_text('RELEASE_DIR='+str(release)+'\n')
            rows = [dict(Service=name, Project='online-shopping-gcp', State='running', Health='healthy') for name in ('frontend','backend','postgres')]
            module = e.load_updater()
            module.trusted = lambda path, directory=False: Path(path)
            with patch.object(e, 'load_updater', return_value=module):
                p.runner = lambda argv: json.dumps(rows)
                p.preflight()
                rows[1]['Health'] = 'unhealthy'
                with self.assertRaises(ValueError): p.preflight()
                rows[1]['Health'] = 'healthy'
                rows[0]['Project'] = 'other'
                with self.assertRaises(ValueError): p.preflight()

    def test_inline_probe_password_boundary(self):
        # Execute the actual inline program, replacing only I/O boundaries.
        harness = r"""
const vm = require('node:vm');
const scenario = process.argv[1];
const sentinel = 'sensitive-private-password';
const attempts = [];
let output = '';
class Client {
  constructor(options) { this.options = options; }
  on() {}
  async connect() {
    const o = this.options;
    if (o.host !== 'postgres' || o.port !== 5432) throw Error(sentinel);
    attempts.push([o.user, o.database, o.password === sentinel]);
    if (scenario === 'trust') return;
    if (o.password !== sentinel || (scenario === 'mismatch' && o.user === 'platform_provisioner'))
      throw Object.assign(Error(sentinel), { code: '28P01' });
  }
  async query() {
    return { rows: [{ current_user: this.options.user, current_database: this.options.database }] };
  }
  async end() {}
}
const env = { PLATFORM_DATABASE_PASSWORD_FILE: '/run/secrets/platform',
  PLATFORM_PROVISIONER_PASSWORD_FILE: '/run/secrets/provisioner' };
vm.runInNewContext(process.argv[2], {
  process: { env },
  require(name) {
    if (name === 'pg') return { Client };
    if (name === 'node:crypto') return { randomBytes: () => Buffer.from('wrong') };
    return { readFileSync(path) {
      if (scenario === 'missing') throw Error(sentinel);
      if (scenario === 'empty') return '\n';
      return sentinel + '\n';
    } };
  },
  console: { log(value) { output += value; } },
});
setTimeout(() => console.log(JSON.stringify({ output, attempts })), 20);
"""
        for scenario, status in (
            ('success', 'ready'), ('mismatch', 'credential verification failed'),
            ('trust', 'password authentication not enforced on this path'),
            ('missing', 'mounted credential unavailable'), ('empty', 'mounted credential unavailable'),
        ):
            with self.subTest(scenario=scenario):
                result = subprocess.run(['node', '-e', harness, scenario, e.AUTHENTICATION_PROBE],
                                        capture_output=True, text=True, check=True)
                self.assertNotIn('sensitive-private-password', result.stdout + result.stderr + e.AUTHENTICATION_PROBE)
                receipt = json.loads(result.stdout)
                self.assertEqual({'status': status}, json.loads(receipt['output']))
                if scenario == 'success':
                    self.assertEqual([
                        ['platform_app', 'platform', False], ['platform_app', 'platform', True],
                        ['platform_provisioner', 'postgres', False], ['platform_provisioner', 'postgres', True],
                    ], receipt['attempts'])
                if scenario in ('missing', 'empty'):
                    self.assertEqual([], receipt['attempts'])

    def test_failed_probe_receipts_are_not_ready(self):
        for status in ('mounted credential unavailable', 'password authentication not enforced on this path',
                       'credential verification failed'):
            with tempfile.TemporaryDirectory() as root:
                p, runner = self.fixture(root)
                runner.roles = ['platform_app|false|false|false|true', 'platform_provisioner|false|true|true|true']
                runner.database = 'platform_app|true'
                def run(argv, sql=None):
                    return json.dumps({'status': status}) if sql is None else runner(argv, sql)
                p.runner = run
                with patch.object(p, 'preflight'), patch.object(p, 'secret', return_value='private'):
                    with self.assertRaisesRegex(ValueError, 'private reconciliation'): p.run(True)
                self.assertTrue(all(sql.startswith('SELECT') for sql in runner.sql))


    def test_compose_policy_and_platform_migration_gate(self):
        text = (ROOT/'compose.gcp.yaml').read_text()
        # Parse with the installed Ruby stdlib YAML parser: no Docker/dependency required.
        import subprocess
        result = subprocess.run(['ruby','-rpsych','-rjson','-e','puts JSON.generate(Psych.load_file(ARGV[0]))',str(ROOT/'compose.gcp.yaml')], capture_output=True, text=True, check=True)
        compose = json.loads(result.stdout)
        backend = compose['services']['backend']
        self.assertEqual('${PLATFORM_ENABLED:-0}', backend['environment']['PLATFORM_ENABLED'])
        self.assertEqual('${PLATFORM_ADMIN_CLAIM_ENABLED:-0}', backend['environment']['PLATFORM_ADMIN_CLAIM_ENABLED'])
        self.assertEqual('${MCP_ENABLED:-0}', backend['environment']['MCP_ENABLED'])
        self.assertEqual('${AI_ENABLED:-0}', backend['environment']['AI_ENABLED'])
        self.assertEqual('/run/secrets/ai_api_key', backend['environment']['AI_API_KEY_FILE'])
        self.assertIn('ai_api_key', backend['secrets'])
        self.assertEqual('${MCP_REDIRECT_URIS:-}', backend['environment']['MCP_REDIRECT_URIS'])
        self.assertNotIn('MCP_BROWSER_ORIGINS', backend['environment'])
        self.assertEqual('${WHATSAPP_QR_ENABLED:-0}', backend['environment']['WHATSAPP_QR_ENABLED'])
        qr = compose['services']['whatsapp-qr']
        self.assertEqual(['whatsapp-qr'], qr['profiles'])
        self.assertEqual(['private', 'egress'], qr['networks'])
        self.assertEqual(['whatsapp_qr_token'], qr['secrets'])
        self.assertNotIn('ports', qr); self.assertTrue(qr['read_only']); self.assertEqual(['ALL'], qr['cap_drop'])
        self.assertEqual('384m', qr['mem_limit'])
        self.assertFalse(any('DATABASE' in key or 'INTEGRATION' in key for key in qr['environment']))
        self.assertNotIn('PLATFORM_ADMIN_USERNAME',backend['environment'])
        self.assertNotIn('PLATFORM_ADMIN_PASSWORD_FILE',backend['environment'])
        self.assertEqual('384m',backend['mem_limit'])
        self.assertEqual({'admin_password','database_password','integration_keys','platform','provisioner','whatsapp_qr_token','whatsapp_qr_token_slot1','whatsapp_qr_bindings','ai_api_key'},set(backend['secrets']))
        self.assertEqual('${WHATSAPP_QR_BINDINGS_FILE:-}', backend['environment']['WHATSAPP_QR_BINDINGS_FILE'])
        workers = {name: service for name, service in compose['services'].items() if name.startswith('whatsapp-qr')}
        self.assertEqual({'whatsapp-qr', 'whatsapp-qr-slot1'}, set(workers))
        for name, service in workers.items():
            token = 'whatsapp_qr_token' + ('_slot1' if name.endswith('slot1') else '')
            self.assertEqual([name], service['profiles'])
            self.assertEqual([token], service['secrets'])
            self.assertEqual('/run/secrets/' + token, service['environment']['WHATSAPP_QR_TOKEN_FILE'])
            self.assertEqual('--max-old-space-size=192', service['environment']['NODE_OPTIONS'])
            self.assertEqual('384m', service['mem_limit'])
            self.assertEqual(0.5, service['cpus'])
            self.assertNotIn('ports', service)
            self.assertNotIn('volumes', service)
            self.assertEqual({'NODE_ENV', 'NODE_OPTIONS', 'WHATSAPP_QR_BACKEND_URL', 'WHATSAPP_QR_TOKEN_FILE'}, set(service['environment']))
        self.assertEqual(workers['whatsapp-qr']['image'], workers['whatsapp-qr-slot1']['image'])
        self.assertIn('src/platform/',e.load_updater().PROTECTED)
        self.assertEqual(['database_password', 'database_owner_password'], compose['services']['postgres']['secrets'])
        self.assertEqual(['private', 'egress'], backend['networks'])
        self.assertEqual(['private'], compose['services']['postgres']['networks'])
        self.assertEqual({'edge': {'aliases': ['online-shopping-frontend']}, 'private': None},
                         compose['services']['frontend']['networks'])
        self.assertEqual({'internal': True}, compose['networks']['private'])
        self.assertEqual({'internal': False, 'ipam': {'config': [{'subnet': '192.168.247.0/24'}]}},
                         compose['networks']['egress'])
        self.assertNotIn('ports:',text)


if __name__ == '__main__': unittest.main()
