#!/usr/bin/env python3
"""Manual tenant purge after retention and a verified final backup. Never scheduled."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from postgres_backup import OwnerPostgres, private_json

ROOT = Path(__file__).resolve().parent.parent


def final_backup(owner, row, directory, target):
    """Persist the verified archive before either irreversible drop, and reuse it on retry."""
    checkpoint = directory / ('purge-' + row['id'] + '.json')
    identity = {key: row[key] for key in ('id', 'code', 'revision', 'database_name', 'database_role', 'delete_after')}
    if checkpoint.exists():
        if checkpoint.is_symlink() or checkpoint.stat().st_mode & 0o777 != 0o600:
            raise RuntimeError('Purge checkpoint must remain private.')
        saved = json.loads(checkpoint.read_text())
        if saved.get('target') != target or saved.get('tenant') != identity:
            raise RuntimeError('Purge checkpoint target or tenant changed.')
        entry = saved['backup']
    else:
        entry = owner.backup(row['database_name'], 'tenant-' + row['code'], directory)
    if entry.get('database') != row['database_name']:
        raise RuntimeError('Purge archive belongs to another database.')
    archive, proof = Path(entry['archive']), Path(entry['evidence'])
    for path in (archive, proof):
        if path.is_symlink() or not path.is_file() or path.resolve().parent != directory or path.stat().st_mode & 0o777 != 0o600:
            raise RuntimeError('Purge archive/proof escaped its private directory.')
    evidence = json.loads(proof.read_text())
    if not evidence.get('restoreVerified') or evidence.get('database') != row['database_name']:
        raise RuntimeError('Purge archive lacks matching restore proof.')
    owner.verify_archive(archive, evidence)
    if not checkpoint.exists():
        private_json(checkpoint, {'format': 1, 'target': target, 'tenant': identity, 'backup': entry})
    return checkpoint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--code', required=True)
    parser.add_argument('--confirm', required=True)
    parser.add_argument('--container', default='online-shopping-production-postgres-1')
    parser.add_argument('--owner', default='online_shopping')
    parser.add_argument('--env-file', required=True, help='Retained for compatibility; final backup uses the explicit owner/container target.')
    parser.add_argument('--directory', default=str(Path.home() / 'Backups/Online-Shopping'))
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9]{3,30}', args.code) or args.confirm != args.code:
        raise SystemExit('Type the exact shop code in --confirm.')
    container_id = subprocess.check_output(['docker', '--context', 'orbstack', 'inspect', '--format', '{{.Id}}', args.container], text=True, timeout=30).strip()
    if not re.fullmatch(r'[0-9a-f]{64}', container_id): raise RuntimeError('Unexpected PostgreSQL container identity.')
    pg = ['docker', '--context', 'orbstack', 'exec', '-i', container_id, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', args.owner, '-d', 'platform', '-At']
    def query(sql):
        result = subprocess.run(pg, input=sql, capture_output=True, text=True, timeout=60)
        if result.returncode: raise RuntimeError('Purge SQL failed.')
        return result.stdout.strip()
    row_text = query("SELECT row_to_json(t) FROM (SELECT id, code, status, revision, delete_after, is_default, database_name, database_role FROM tenant WHERE code='" + args.code + "') t;")
    if not row_text: raise RuntimeError('Shop not found.')
    row = json.loads(row_text)
    if row['is_default'] or row['status'] != 'DELETING' or not row['delete_after'] or datetime.datetime.fromisoformat(row['delete_after'].replace('Z', '+00:00')) > datetime.datetime.now(datetime.timezone.utc):
        raise RuntimeError('Shop is not eligible for purge.')
    if any(not re.fullmatch(r't_[a-z0-9]{3,30}_[0-9a-f]{8}', row[key]) for key in ['database_name', 'database_role']) or not re.fullmatch(r'[0-9a-f-]{36}', row['id']):
        raise RuntimeError('Unexpected shop identifiers.')
    directory = Path(args.directory).expanduser().resolve()
    if directory.is_relative_to(ROOT): raise RuntimeError('Purge archives must be outside the project folder.')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.stat().st_mode & 0o077: raise RuntimeError('Purge directory must remain private.')
    owner = OwnerPostgres('orbstack', container_id, args.owner)
    lock_path = directory / ('purge-' + row['id'] + '.lock')
    lock = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if os.fstat(lock).st_mode & 0o777 != 0o600: raise RuntimeError('Purge lock must remain private.')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        final_backup(owner, row, directory, {'context': 'orbstack', 'container': container_id, 'owner': args.owner})
        purge_locked(pg, args, row)
    finally:
        os.close(lock)


def purge_locked(pg, args, row):
    # Hold the platform writer lock until both non-transactional drops finish. Console cancellation cannot race a purge.
    lease = subprocess.Popen(pg, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        # An existing reservation also means the static worker has not been retired.
        # Resolve this under the same writer lock as lifecycle/admission, before DROP.
        lease.stdin.write("SET statement_timeout='15s'; BEGIN; SELECT pg_advisory_xact_lock(73119,1); DO $$ BEGIN IF (SELECT version FROM schema_meta WHERE id=1) >= 3 THEN IF EXISTS (SELECT 1 FROM tenant_qr_binding WHERE tenant_id='" + row['id'] + "') THEN RAISE EXCEPTION 'QR cleanup and worker retirement required'; END IF; END IF; END $$;\n")
        lease.stdin.write("SET statement_timeout='15s'; SELECT 'PURGE|' || COALESCE((SELECT revision::text FROM tenant WHERE id='" + row['id'] + "' AND status='DELETING' AND revision=" + str(row['revision']) + " AND delete_after <= '" + datetime.datetime.now(datetime.timezone.utc).isoformat() + "' AND is_default=0),'STALE');\n")
        lease.stdin.flush()
        eligible = False
        for _ in range(6):
            line = lease.stdout.readline().strip()
            if line.startswith('PURGE|'): eligible = line == 'PURGE|' + str(row['revision']); break
            if not line and lease.poll() is not None: break
        if not eligible: raise RuntimeError('Shop changed during backup; purge refused.')
        drop = [*pg]; drop[drop.index('-d') + 1] = 'postgres'
        # No FORCE: a remaining tenant connection is an actionable stop, never silently terminated.
        for sql in [f'DROP DATABASE IF EXISTS "{row["database_name"]}";', f'DROP ROLE IF EXISTS "{row["database_role"]}";']:
            if subprocess.run(drop, input=sql, capture_output=True, text=True, timeout=60).returncode: raise RuntimeError('Purge drop failed; retry manually after closing tenant connections.')
        lease.stdin.write("UPDATE tenant SET status='PURGED', revision=revision+1, updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') WHERE id='" + row['id'] + "' AND status='DELETING' AND revision=" + str(row['revision']) + "; INSERT INTO platform_audit(id,actor,action,tenant_id,detail,created_at) VALUES (gen_random_uuid()::text,'host','TENANT_PURGED','" + row['id'] + "','" + row['code'] + "',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')); COMMIT;\n")
        lease.stdin.close()
        if lease.wait(timeout=15): raise RuntimeError('Purge audit failed.')
        print('Tenant purged after verified backup:', args.code)
    finally:
        if lease.poll() is None:
            lease.terminate(); lease.wait(timeout=15)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Tenant purge failed:', type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
