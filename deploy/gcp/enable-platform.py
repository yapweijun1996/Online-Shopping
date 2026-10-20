#!/usr/bin/env python3
"""Linux root-only additive platform provisioning. SQL credentials use stdin only."""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys


def load_updater():
    spec = importlib.util.spec_from_file_location('gcp_update', Path(__file__).with_name('update.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def command(argv, sql=None):
    result = subprocess.run(argv, input=sql, text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError('Provisioning command failed')
    return result.stdout.strip()


class Provisioner:
    def __init__(self, root, runner=command):
        self.root = Path(root)
        self.runner = runner
        self.updater = load_updater().Updater(root)
        self.env = self.updater.runtime()
        self.compose = ['docker', 'compose', '-p', 'online-shopping-gcp', '--env-file', str(self.root / 'runtime.env'), '--env-file', str(self.root / 'images.env'), '-f', str(self.root / 'compose.yaml')]

    def query(self, sql):
        return self.runner(self.compose + ['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'online_shopping', '-d', 'postgres', '-At'], sql)

    def preflight(self):
        u = load_updater()
        u.trusted(self.root, directory=True)
        for name in ('compose.yaml', 'runtime.env', 'images.env'):
            u.trusted(self.root / name)
        images = dict(line.split('=', 1) for line in (self.root / 'images.env').read_text().splitlines())
        release = u.trusted(images['RELEASE_DIR'], directory=True)
        if release.parent != self.root / 'releases' or not u.SHA.fullmatch(release.name):
            raise ValueError('Invalid release directory')
        u.trusted(self.env['SECRETS_DIR'], directory=True)
        if stat.S_IMODE(Path(self.env['SECRETS_DIR']).stat().st_mode) != 0o700:
            raise ValueError('Secrets directory must have mode 0700')
        rows = self.runner(self.compose + ['ps', '--format', 'json'])
        try:
            rows = json.loads(rows)
            if isinstance(rows, dict): rows = [rows]
        except json.JSONDecodeError:
            rows = [json.loads(row) for row in rows.splitlines()]
        services = {row['Service']: row for row in rows}
        for service in ('frontend', 'backend', 'postgres'):
            row = services[service]
            if row.get('Project') != 'online-shopping-gcp' or row.get('State') != 'running' or (service != 'frontend' and row.get('Health') != 'healthy'):
                raise ValueError('Containers must be running and healthy')

    def inspect(self):
        roles = self.query("SELECT rolname || '|' || rolsuper || '|' || rolcreatedb || '|' || rolcreaterole || '|' || rolcanlogin FROM pg_roles WHERE rolname IN ('platform_app','platform_provisioner') ORDER BY rolname;").splitlines()
        expected = {'platform_app|false|false|false|true', 'platform_provisioner|false|true|true|true'}
        if any(row not in expected for row in roles):
            raise ValueError('Incompatible existing roles')
        if any(row.startswith('platform_provisioner|') for row in roles):
            settings = self.query("SELECT COALESCE(array_to_string(rolconfig, ','),'') FROM pg_roles WHERE rolname='platform_provisioner';")
            if 'createrole_self_grant=set, inherit' not in settings:
                raise ValueError('Incompatible provisioner settings')
        database = self.query("SELECT pg_get_userbyid(datdba) || '|' || NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(datacl, acldefault('d', datdba))) WHERE grantee=0 AND privilege_type='CONNECT') FROM pg_database WHERE datname='platform';")
        if database not in ('', 'platform_app|true', 'platform_app|false'):
            raise ValueError('Incompatible database owner')
        return roles, database

    def secret(self, name, check=False):
        path = Path(self.env['SECRETS_DIR']) / name
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != 1000:
                raise ValueError('Unsafe existing secret')
            value = path.read_text().removesuffix('\n')
            if name == 'integration-keys':
                lines = [line for line in value.splitlines() if line and not line.startswith('#')]
                ids = set()
                for line in lines:
                    key, _, encoded = line.partition('=')
                    if not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', key) or key in ids or len(base64.b64decode(encoded, validate=True)) != 32:
                        raise ValueError('Invalid master key')
                    ids.add(key)
                if not ids: raise ValueError('Empty master key')
            elif not re.fullmatch(r'[A-Za-z0-9_-]{24,256}', value):
                raise ValueError('Invalid password')
            return value
        if check: return None
        value = 'primary=' + base64.b64encode(secrets.token_bytes(32)).decode() if name == 'integration-keys' else secrets.token_urlsafe(48)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as out:
            os.fchown(out.fileno(), 1000, 1000)
            out.write(value + '\n')
            out.flush()
            os.fsync(out.fileno())
        return value

    def run(self, check=False, step='provision'):
        names = ('integration-keys', 'platform-password', 'provisioner-password')
        if step == 'secrets':
            u = load_updater()
            u.trusted(self.env['SECRETS_DIR'], directory=True)
            if stat.S_IMODE(Path(self.env['SECRETS_DIR']).stat().st_mode) != 0o700:
                raise ValueError('Secrets directory must have mode 0700')
            values = {name: self.secret(name, check=True) for name in names}
            if check:
                return {'mode': 'check', 'secretsPresent': sum(value is not None for value in values.values())}
            for name in names:
                if values[name] is None: self.secret(name)
            return {'mode': 'secrets', 'status': 'ready'}
        self.preflight()
        roles, database = self.inspect()
        # Provisioning never creates credentials; run the independent secrets step first.
        # Inspect all existing inputs before creating anything. Never reset a role password.
        values = {name: self.secret(name, check=True) for name in names}
        for role, name in (('platform_app', 'platform-password'), ('platform_provisioner', 'provisioner-password')):
            if any(row.startswith(role + '|') for row in roles) and values[name] is None:
                raise ValueError('Existing role has no matching secret; manual reconciliation required')
        if check:
            return {'mode': 'check', 'rolesPresent': len(roles), 'databasePresent': bool(database), 'secretsPresent': sum(value is not None for value in values.values())}
        if any(value is None for value in values.values()):
            raise ValueError('Run the secrets step before provisioning')
        for role, name, flags in (('platform_app', 'platform-password', 'NOCREATEDB NOCREATEROLE'), ('platform_provisioner', 'provisioner-password', 'CREATEDB CREATEROLE')):
            if not any(row.startswith(role + '|') for row in roles):
                self.query(f"SET standard_conforming_strings=on; CREATE ROLE {role} LOGIN NOSUPERUSER {flags} NOREPLICATION PASSWORD '{values[name]}';" + (" ALTER ROLE platform_provisioner SET createrole_self_grant = 'set, inherit';" if role == 'platform_provisioner' else ''))
        if not database:
            self.query('CREATE DATABASE platform OWNER platform_app;')
        self.inspect()
        if database != 'platform_app|true':
            self.query('REVOKE ALL ON DATABASE platform FROM PUBLIC;')
        _, database = self.inspect()
        if database != 'platform_app|true': raise ValueError('Platform boundary verification failed')
        self.runner(self.compose + ['run', '--rm', '--no-deps', 'backend', 'node', 'scripts/upgrade-platform.mjs', '--with-claim'])
        return {'mode': 'apply', 'status': 'ready'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='/opt/online-shopping-gcp')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('step', choices=('secrets', 'provision'))
    args = parser.parse_args()
    try:
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise ValueError('Linux root required')
        print(json.dumps(Provisioner(args.root).run(args.check, args.step)))
        return 0
    except Exception:
        print('Platform enablement failed; inspect private state, not credentials.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
