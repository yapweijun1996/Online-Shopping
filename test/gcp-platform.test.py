#!/usr/bin/env python3
"""Offline platform enablement acceptance; never calls Docker or a network."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
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
    def __call__(self, argv, sql=None):
        if sql is None: raise AssertionError('Unexpected process')
        self.sql.append(sql)
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

    def test_check_is_read_only_and_reports_missing(self):
        with tempfile.TemporaryDirectory() as root:
            p, runner = self.fixture(root)
            before = set(Path(root).iterdir())
            with patch.object(p, 'preflight'):
                self.assertEqual({'mode':'check','rolesPresent':0,'databasePresent':False,'secretsPresent':0}, p.run(True))
            self.assertEqual(before, set(Path(root).iterdir()))
            self.assertTrue(all(sql.startswith('SELECT') for sql in runner.sql))

    def test_apply_resume_and_second_apply_do_not_rewrite(self):
        with tempfile.TemporaryDirectory() as root:
            p, runner = self.fixture(root)
            values = {}
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
            self.assertNotIn('sensitive', output.getvalue())
            self.assertFalse(any('online_shopping;' in sql for sql in runner.sql))

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
        with patch.object(e.sys, 'platform', 'linux'), patch.object(e.os, 'geteuid', return_value=0), patch.object(e.sys, 'argv', ['enable-platform.py']), patch.object(e, 'Provisioner', side_effect=RuntimeError('private-password')):
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

    def test_structured_route_policy(self):
        text = (ROOT/'deploy/gcp/Caddyfile').read_text()
        shop, seller = text.split('http://{$SHOP_HOST} {',1)[1].split('http://{$SELLER_HOST} {',1)
        # Extract named matcher bodies rather than assert unrelated occurrences.
        def matcher(block, name):
            start = block.index('@'+name)
            end = block.index('handle @'+name, start)
            return block[start:end]
        for path in ('/seller*','/api/v1/seller*','/platform*','/api/v1/platform*'):
            self.assertIn(path, matcher(shop, 'private'))
        for path in ('/shop*','/p/*','/s/*','/api/v1/orders*','/setup*','/api/v1/setup*'):
            self.assertIn(path, matcher(seller, 'private'))
        self.assertIn('not path /shop/tokens.css', matcher(seller,'private'))
        self.assertIn('/demo-assets/*', matcher(shop,'static'))
        self.assertIn('/platform/*', matcher(seller,'static'))
        for path in ('/setup/','/setup/setup.js','/setup/setup.css','/api/v1/setup/status','/api/v1/setup/claim'):
            self.assertIn(path, matcher(shop,'setup'))
        self.assertLess(shop.index('handle @setup'), shop.index('import tenant shop'))
        for block, surface in ((shop,'shop'),(seller,'seller')):
            self.assertIn('import tenant '+surface, block)
            self.assertLess(block.index('handle @tenant_private'), block.index('import tenant '+surface))
            self.assertIn('api/v1/setup', matcher(block,'tenant_private'))
            self.assertIn('respond 404', block)
        self.assertIn('forward_auth backend:3000', text)
        self.assertIn('X-Tenant-Original-Uri', text)
        self.assertIn('api/|{args[0]}/manifest', text)  # Includes root/tenant webhook APIs.
        self.assertNotIn('CF-Connecting-IP', text)
        self.assertEqual(text.count('{'), text.count('}'))

    def test_compose_policy_and_platform_migration_gate(self):
        text = (ROOT/'compose.gcp.yaml').read_text()
        # Parse with the installed Ruby stdlib YAML parser: no Docker/dependency required.
        import subprocess
        result = subprocess.run(['ruby','-rpsych','-rjson','-e','puts JSON.generate(Psych.load_file(ARGV[0]))',str(ROOT/'compose.gcp.yaml')], capture_output=True, text=True, check=True)
        compose = json.loads(result.stdout)
        backend = compose['services']['backend']
        self.assertEqual('${PLATFORM_ENABLED:-0}', backend['environment']['PLATFORM_ENABLED'])
        self.assertEqual('${PLATFORM_ADMIN_CLAIM_ENABLED:-0}', backend['environment']['PLATFORM_ADMIN_CLAIM_ENABLED'])
        self.assertNotIn('PLATFORM_ADMIN_USERNAME',backend['environment'])
        self.assertNotIn('PLATFORM_ADMIN_PASSWORD_FILE',backend['environment'])
        self.assertEqual('384m',backend['mem_limit'])
        self.assertEqual({'admin_password','database_password','integration_keys','platform','provisioner'},set(backend['secrets']))
        self.assertIn('src/platform/',e.load_updater().PROTECTED)
        self.assertNotIn('ports:',text)


if __name__ == '__main__': unittest.main()
