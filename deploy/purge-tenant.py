#!/usr/bin/env python3
"""Manual tenant purge after retention and a verified final backup. Never scheduled."""
import argparse
import datetime
import json
from pathlib import Path
import re
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--code', required=True)
    parser.add_argument('--confirm', required=True)
    parser.add_argument('--container', default='online-shopping-production-postgres-1')
    parser.add_argument('--owner', default='online_shopping')
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--directory', default=str(Path.home() / 'Backups/Online-Shopping'))
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9]{3,30}', args.code) or args.confirm != args.code:
        raise SystemExit('Type the exact shop code in --confirm.')
    pg = ['docker', '--context', 'orbstack', 'exec', '-i', args.container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', args.owner, '-d', 'platform', '-At']
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
    backup = Path(__file__).with_name('backup-postgres.py')
    subprocess.run([sys.executable, str(backup), '--env-file', args.env_file, '--directory', args.directory, '--tenant', args.code], check=True, timeout=300)
    # Hold the platform writer lock until both non-transactional drops finish. Console cancellation cannot race a purge.
    lease = subprocess.Popen(pg, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        lease.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(73119,1); SELECT 'PURGE|' || COALESCE((SELECT revision::text FROM tenant WHERE id='" + row['id'] + "' AND status='DELETING' AND revision=" + str(row['revision']) + " AND delete_after <= '" + datetime.datetime.now(datetime.timezone.utc).isoformat() + "' AND is_default=0),'STALE');\n")
        lease.stdin.flush()
        eligible = False
        for _ in range(4):
            line = lease.stdout.readline().strip()
            if line.startswith('PURGE|'): eligible = line == 'PURGE|' + str(row['revision']); break
            if not line and lease.poll() is not None: break
        if not eligible: raise RuntimeError('Shop changed during backup; purge refused.')
        drop = ['docker', '--context', 'orbstack', 'exec', '-i', args.container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', args.owner, '-d', 'postgres', '-At']
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
