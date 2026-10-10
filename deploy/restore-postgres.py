#!/usr/bin/env python3
"""Restore only databases attempted by a failed deployment, from that deployment's verified backup."""
import argparse
import json
from pathlib import Path
from postgres_backup import OwnerPostgres, private_json, IDENTIFIER


def restore_failed(owner, manifest, report_path, backend=None):
    report_path = Path(report_path)
    if not report_path.exists(): return []  # The runner never began a database mutation.
    report = json.loads(report_path.read_text())
    if report.get('format') != 1 or manifest.get('format') != 1 or manifest.get('restoreVerified') is not True:
        raise RuntimeError('Invalid deployment restore evidence.')
    entries = {item['database']: item for item in manifest['databases']}
    restored = []
    for database in reversed(report['attempted']):
        if not IDENTIFIER.fullmatch(database) or database not in entries: raise RuntimeError('Unexpected restore target.')
        item = entries[database]
        archive = Path(item['archive'])
        evidence = json.loads(Path(item['evidence']).read_text())
        if (evidence.get('database') != database and not (item.get('legacy') and database == 'online_shopping')) or evidence.get('restoreVerified') is not True:
            raise RuntimeError('Database archive lacks a verified proof.')
        owner.verify_archive(archive, evidence)
        role = item.get('role') or ('platform_app' if database == 'platform' else 'online_shopping')
        owner.restore(archive, database, role=role, clean=True)
        if item.get('legacy'):
            if not backend: raise RuntimeError('Legacy restore verification needs the running backend.')
            import subprocess
            actual = json.loads(subprocess.check_output(owner.exec[:3] + ['exec', '-e', 'DATABASE_NAME=' + database,
                '-e', 'PLATFORM_ENABLED=0', backend, 'node', 'scripts/database-evidence.js'], text=True))
        else: actual = owner.proof(database)
        owner.same_proof(evidence, actual)
        restored.append(database)
        report['restored'] = restored
        private_json(report_path, report)
    return restored


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', default='orbstack')
    parser.add_argument('--container', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--backend')
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    manifest_path = Path(args.manifest)
    if manifest_path.is_symlink() or manifest_path.stat().st_mode & 0o777 != 0o600: raise RuntimeError('Backup manifest is not private.')
    restored = restore_failed(OwnerPostgres(args.context, args.container), json.loads(manifest_path.read_text()), args.report, args.backend)
    print(json.dumps({'restoreVerified': True, 'databases': restored}))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Deployment restore failed:', type(error).__name__, file=__import__('sys').stderr)
        raise SystemExit(1)
