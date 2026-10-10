#!/usr/bin/env python3
"""Create a private PostgreSQL archive and prove it restores into a disposable database."""
import argparse
import datetime
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import subprocess
import tempfile

from postgres_backup import OwnerPostgres, private_json

ROOT = Path(__file__).resolve().parent.parent


def legacy_backup(args, postgres, backend, directory, expected_schema):
    exec_pg = ['docker', '--context', args.context, 'exec', postgres]
    name = 'shopping_restore_test_' + secrets.token_hex(8)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    final = directory / f'online-shopping-{stamp}-{secrets.token_hex(3)}.dump'
    fd, temporary = tempfile.mkstemp(prefix='.backup-', dir=directory)
    lease = None
    created = False
    try:
        os.fchmod(fd, 0o600)
        lease = subprocess.Popen(['docker', '--context', args.context, 'exec', '-i', backend,
            'node', 'scripts/database-evidence.js', '--hold-snapshot'], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, text=True)
        evidence = json.loads(lease.stdout.readline())
        if not evidence.get('snapshot') or evidence['schemaVersion'] != expected_schema:
            raise RuntimeError('Source snapshot/schema is unavailable.')
        with os.fdopen(fd, 'wb') as output:
            subprocess.run(exec_pg + ['pg_dump', '-U', 'online_shopping', '-d', 'online_shopping',
                '--format=custom', '--no-owner', '--snapshot=' + evidence['snapshot']], stdout=output, check=True)
            output.flush()
            os.fsync(output.fileno())
        lease.stdin.write('release\n')
        lease.stdin.flush()
        if lease.wait(timeout=15):
            raise RuntimeError('Source snapshot lease failed.')
        with open(temporary, 'rb') as archive:
            subprocess.run(['docker', '--context', args.context, 'exec', '-i', postgres,
                'pg_restore', '--list'], stdin=archive, stdout=subprocess.DEVNULL, check=True)
        subprocess.run(exec_pg + ['createdb', '-U', 'online_shopping', name], check=True)
        created = True
        with open(temporary, 'rb') as archive:
            subprocess.run(['docker', '--context', args.context, 'exec', '-i', postgres,
                'pg_restore', '-U', 'online_shopping', '-d', name, '--single-transaction', '--no-owner'], stdin=archive, check=True)
        restored = json.loads(subprocess.check_output(['docker', '--context', args.context, 'exec',
            '-e', 'DATABASE_NAME=' + name, backend, 'node', 'scripts/database-evidence.js'], text=True))
        for field in ['schemaVersion', 'schemaSha256', 'tables']:
            if evidence[field] != restored[field]:
                raise RuntimeError('Restore verification mismatch: ' + field)
        smoke = "import{readConfig}from'./src/config.js';import{createApp}from'./src/server.js';const c=readConfig();const a=await createApp(c);await new Promise(r=>a.server.listen(0,'127.0.0.1',r));const b='http://127.0.0.1:'+a.server.address().port;for(const p of ['/ready','/api/v1/products']){const r=await fetch(b+p);if(!r.ok)throw Error('Restore smoke failed')}await a.close();"
        subprocess.run(['docker', '--context', args.context, 'exec', '-e', 'DATABASE_NAME=' + name, '-e', 'PLATFORM_ENABLED=0',
            backend, 'node', '--input-type=module', '-e', smoke], check=True)
        if os.stat(temporary).st_mode & 0o777 != 0o600:
            raise RuntimeError('Unexpected archive permissions.')
        os.rename(temporary, final)
        evidence.pop('snapshot')
        evidence['archiveSha256'] = hashlib.sha256(final.read_bytes()).hexdigest()
        evidence['restoreVerified'] = True
        evidence['verifiedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        meta_fd, meta_temp = tempfile.mkstemp(prefix='.evidence-', dir=directory)
        with os.fdopen(meta_fd, 'w') as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(evidence, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.rename(meta_temp, str(final) + '.json')
        print('Backup and isolated restore verified:', final)
        return {'database': 'online_shopping', 'archive': str(final), 'evidence': str(final) + '.json', 'legacy': True}
    finally:
        if lease and lease.poll() is None:
            lease.stdin.close()
            try:
                lease.wait(timeout=15)
            except subprocess.TimeoutExpired:
                lease.terminate()
        if created:
            subprocess.run(exec_pg + ['dropdb', '-U', 'online_shopping', name], check=True)
        if os.path.exists(temporary):
            os.unlink(temporary)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', default='orbstack')
    parser.add_argument('--project', default='online-shopping-production')
    parser.add_argument('--env-file', default=str(ROOT / '.local/production.env'))
    parser.add_argument('--compose-file', action='append')
    parser.add_argument('--directory', default=str(Path.home() / 'Backups/Online-Shopping'))
    parser.add_argument('--tenant')
    parser.add_argument('--manifest', help='Write the verified deployment backup set to this private JSON file.')
    args = parser.parse_args(argv)
    if args.tenant and not re.fullmatch(r'[a-z0-9]{3,30}', args.tenant): parser.error('Unexpected tenant code.')
    return args


def main(argv=None):
    args = parse_args(argv)
    directory = Path(args.directory).expanduser().resolve()
    if directory.is_relative_to(ROOT): raise RuntimeError('Backups must be outside the project folder.')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700); directory.chmod(0o700)
    compose = ['docker', '--context', args.context, 'compose', '-p', args.project, '--env-file', args.env_file]
    for file in args.compose_file or [str(ROOT / 'compose.production.yaml')]: compose += ['-f', file]
    postgres = subprocess.check_output(compose + ['ps', '-q', 'postgres'], text=True).strip()
    backend = subprocess.check_output(compose + ['ps', '-q', 'backend'], text=True).strip()
    if not postgres or not backend: raise RuntimeError('PostgreSQL and backend must be running.')
    owner = OwnerPostgres(args.context, postgres)
    entries = []
    if not args.tenant:
        expected_schema = int(re.search(r'export const SCHEMA_VERSION = (\d+);', (ROOT / 'src/db.js').read_text()).group(1))
        entries.append(legacy_backup(args, postgres, backend, directory, expected_schema))
    if owner.exists('platform'):
        # Empty platform databases (setup completed, activation pending) also receive a verified archive.
        if not args.tenant: entries.append(owner.backup('platform', 'platform', directory))
        has_tenants = owner.query('platform', "SELECT to_regclass('public.tenant') IS NOT NULL;") == 't'
        rows = json.loads(owner.query('platform', "SELECT COALESCE(json_agg(r ORDER BY code),'[]'::json) FROM "
            "(SELECT code,database_name,database_role FROM tenant WHERE is_default=0 "
            "AND status IN ('ACTIVE','SUSPENDED','DELETING')" +
            (" AND code='" + args.tenant + "'" if args.tenant else '') + ") r;")) if has_tenants else []
        if args.tenant and len(rows) != 1: raise RuntimeError('Tenant is not eligible for a verified backup.')
        for row in rows:
            entry = owner.backup(row['database_name'], 'tenant-' + row['code'], directory)
            entry['role'] = row['database_role']; entries.append(entry)
    elif args.tenant: raise RuntimeError('The platform database does not exist.')
    if args.manifest:
        manifest = Path(args.manifest).expanduser().absolute()
        if manifest.parent != directory or manifest.is_symlink(): raise RuntimeError('Backup manifest must be inside the private backup directory.')
        private_json(manifest, {'format': 1, 'restoreVerified': True, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'databases': entries})
        print('Verified backup set:', manifest)
    elif any(entry['database'] != 'online_shopping' for entry in entries):
        manifest = directory / ('backup-set-' + secrets.token_hex(8) + '.json')
        private_json(manifest, {'format': 1, 'restoreVerified': True, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'databases': entries})
        print('Verified backup set:', manifest)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Backup failed:', type(error).__name__, file=__import__('sys').stderr)
        raise SystemExit(1)
