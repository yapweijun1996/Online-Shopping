#!/usr/bin/env python3
"""Add platform objects without changing existing roles or databases. Passwords go through stdin only."""
import argparse
import json
import os
import re
from pathlib import Path
import stat
import subprocess


def secret(path):
    file = Path(path)
    if file.is_symlink() or not file.is_file() or stat.S_IMODE(file.stat().st_mode) != 0o600:
        raise ValueError('Secret files must be regular files with mode 0600.')
    value = file.read_text().removesuffix('\n')
    if not re.fullmatch(r'[A-Za-z0-9_-]{24,256}', value):
        raise ValueError('Invalid secret file.')
    return value


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def query(args, sql, database='postgres'):
    command = ['docker', '--context', 'orbstack', 'exec', '-i', args.container,
               'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', args.owner, '-d', database, '-At']
    result = subprocess.run(command, input=sql, capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError('Platform setup SQL failed; no credentials are printed.')
    return result.stdout.strip()


def inspect(args):
    roles = query(args, "SELECT rolname || '|' || rolsuper || '|' || rolcreatedb || '|' || rolcreaterole || '|' || rolcanlogin FROM pg_roles WHERE rolname IN ('platform_app','platform_provisioner') ORDER BY rolname;")
    database = query(args, "SELECT pg_get_userbyid(datdba) || '|' || NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(datacl, acldefault('d', datdba))) WHERE grantee=0 AND privilege_type='CONNECT') FROM pg_database WHERE datname='platform';")
    if roles.splitlines() != ['platform_app|false|false|false|true', 'platform_provisioner|false|true|true|true'] or database != 'platform_app|true':
        raise RuntimeError('Platform roles, ownership or PUBLIC privileges do not match the required boundary.')
    settings = query(args, "SELECT COALESCE(array_to_string(rolconfig, ','),'') FROM pg_roles WHERE rolname='platform_provisioner';")
    if 'createrole_self_grant=set, inherit' not in settings:
        raise RuntimeError('Provisioner self-grant setting is missing.')
    return {'roles': ['platform_app', 'platform_provisioner'], 'database': 'platform', 'owner': 'platform_app', 'publicConnect': False, 'provisionerSuperuser': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', default='online-shopping-production-postgres-1')
    parser.add_argument('--owner', default='online_shopping')
    parser.add_argument('--database-password-file', default=os.environ.get('PLATFORM_DATABASE_PASSWORD_FILE_HOST'))
    parser.add_argument('--provisioner-password-file', default=os.environ.get('PLATFORM_PROVISIONER_PASSWORD_FILE_HOST'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        if not args.check:
            app_password = secret(args.database_password_file)
            provisioner_password = secret(args.provisioner_password_file)
            query(args, "SET standard_conforming_strings=on;\nDO $setup$ BEGIN\n"
                  "IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='platform_app') THEN\n"
                  f"CREATE ROLE platform_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD {literal(app_password)};\nEND IF;\n"
                  "IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='platform_provisioner') THEN\n"
                  f"CREATE ROLE platform_provisioner LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION PASSWORD {literal(provisioner_password)};\n"
                  "ALTER ROLE platform_provisioner SET createrole_self_grant = 'set, inherit';\nEND IF;\nEND $setup$;")
            exists = query(args, "SELECT 1 FROM pg_database WHERE datname='platform';")
            if not exists:
                query(args, 'CREATE DATABASE platform OWNER platform_app;')
                query(args, 'REVOKE ALL ON DATABASE platform FROM PUBLIC;')
        print(json.dumps(inspect(args)))
    except Exception as error:
        print('Platform setup failed: ' + type(error).__name__)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
