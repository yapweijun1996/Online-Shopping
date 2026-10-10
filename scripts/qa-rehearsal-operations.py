#!/usr/bin/env python3
"""Real-compose backups and second-shop migration failure recovery, using only rehearsal artifacts."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'deploy'))
from postgres_backup import OwnerPostgres
from importlib.machinery import SourceFileLoader
restore = SourceFileLoader('restore', str(ROOT / 'deploy/restore-postgres.py')).load_module()
qa = SourceFileLoader('qa', str(ROOT / 'scripts/qa-rehearsal.py')).load_module()
state = json.loads((ROOT / 'output/qa/multi-tenant/rehearsal.json').read_text())
if state['project'] != 'online-shopping-rehearsal': raise RuntimeError('Unexpected rehearsal scope.')
base = Path(state['scratch']); backup_dir = base / 'backups'; backup_dir.mkdir(mode=0o700, exist_ok=True)
postgres, backend = state['project'] + '-postgres-1', state['project'] + '-backend-1'
owner = OwnerPostgres('orbstack', postgres)


def fixture(mode):
    subprocess.run(['docker','--context','orbstack','exec','-e','QA_REHEARSAL=1',backend,'node','scripts/qa-rehearsal-shops.mjs',mode], check=True, timeout=120)


def backup(name):
    manifest = backup_dir / (name + '.json')
    subprocess.run([sys.executable,str(ROOT / 'deploy/backup-postgres.py'),'--env-file',state['env'],'--project',state['project'],
        '--compose-file',str(ROOT / 'compose.production.yaml'),'--compose-file',state['override'],'--directory',str(backup_dir),'--manifest',str(manifest)],check=True,timeout=900)
    return manifest


fixture('seed')
first = backup('two-shops')
manifest = json.loads(first.read_text())
assert len(manifest['databases']) == 4 and manifest['restoreVerified']  # legacy + platform + two isolated shops
fixture('older')
second = backup('before-failed-upgrade')
report_dir = base / 'upgrade'; report_dir.mkdir(mode=0o700, exist_ok=True)
report = report_dir / 'report.json'
command = ['docker','--context','orbstack','run','--rm','--user','0','--network',state['project']+'_private',
    '-v',str(base/'platform')+':/run/secrets/platform:ro','-v',str(base/'keys')+':/run/secrets/integration_keys:ro',
    '-v',str(second)+':/run/backup/manifest.json:ro','-v',str(report_dir)+':/run/upgrade',
    '-v',str(ROOT/'src')+':/app/src:ro','-v',str(ROOT/'scripts/upgrade-platform.mjs')+':/app/scripts/upgrade-platform.mjs:ro',
    '--entrypoint','node',state['backendImage'],'scripts/upgrade-platform.mjs']
result = subprocess.run(command, text=True, capture_output=True, timeout=900)
assert result.returncode != 0, 'Second tenant must fail its real schema upgrade.'
progress = json.loads(report.read_text()); rows = json.loads(owner.query('platform',"SELECT json_agg(r ORDER BY code) FROM (SELECT code,database_name FROM tenant WHERE is_default=0) r;"))
assert progress['attempted'] == [rows[0]['database_name'],rows[1]['database_name']]
assert progress['upgraded'] == [rows[0]['database_name']] and not progress['complete']
assert owner.query(rows[0]['database_name'],'SELECT version FROM schema_meta;') == '24'
assert owner.query(rows[1]['database_name'],'SELECT version FROM schema_meta;') == '23'
assert owner.query(rows[2]['database_name'],'SELECT version FROM schema_meta;') == '23'
restored = restore.restore_failed(owner,json.loads(second.read_text()),report,backend)
assert restored == list(reversed(progress['attempted']))
fixture('verify-failure')
fixture('repair')
print('Rehearsal verified: four-database backup; second-shop failure; transactional restores and proofs.')
(ROOT/'output/qa/multi-tenant/r3-operations.json').write_text(json.dumps({'backupDatabases':len(manifest['databases']),'upgradeAttempted':len(progress['attempted']),'upgradedBeforeFailure':len(progress['upgraded']),'restoredAndVerified':len(restored),'thirdShopUntouched':True},indent=2))
