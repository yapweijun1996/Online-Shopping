#!/usr/bin/env python3
"""Real-compose backups and second-shop migration failure recovery, using only rehearsal artifacts."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'deploy'))
from postgres_backup import OwnerPostgres
from importlib.machinery import SourceFileLoader
qa = SourceFileLoader('qa', str(ROOT / 'scripts/qa-rehearsal.py')).load_module()
controller = SourceFileLoader('qa_controller', str(ROOT / 'deploy/auto-update.py')).load_module()
state = json.loads((ROOT / 'output/qa/multi-tenant/rehearsal.json').read_text())
if state['project'] != 'online-shopping-rehearsal': raise RuntimeError('Unexpected rehearsal scope.')
base = Path(state['scratch'])
postgres, backend = state['project'] + '-postgres-1', state['project'] + '-backend-1'
owner = OwnerPostgres('orbstack', postgres)
controller.PROJECT = state['project']
updater = object.__new__(controller.Updater)
updater.root = base / 'controller'; updater.root.mkdir(mode=0o700, exist_ok=True)
updater.state_path = updater.root / 'state.json'
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
candidate = {'sha': sha, 'release': str(ROOT)}
updater.state = json.loads(updater.state_path.read_text()) if updater.state_path.exists() else {'current': candidate}
(updater.root / 'runtime.env').write_text(Path(state['env']).read_text()); (updater.root / 'runtime.env').chmod(0o600)
(updater.root / 'configs').mkdir(mode=0o700, exist_ok=True)
rendered = subprocess.check_output(qa.compose(state) + ['config', '--format', 'json'], text=True, timeout=30)
controller.atomic_json(updater.root / 'configs' / (sha + '.json'), json.loads(rendered))


def run_candidate(command, **kwargs):
    # The rehearsal reuses the already-built Node image with the exact candidate source mounted read-only.
    command = [state['backendImage'] if value.startswith('online-shopping-backend:') else value for value in command]
    if command[:3] == ['docker', '--context', 'orbstack'] and command[3] in ('run', 'create'):
        if not any(value.endswith(':/app/src:ro') for value in command):
            command[4:4] = ['-v', str(ROOT / 'src') + ':/app/src:ro']
    return controller.Updater.run(updater, command, **kwargs)


updater.run = run_candidate

# Recover the prior attempt before replacing its durable state or starting any new fixture writer.
if updater.state.get('migration'):
    previous = updater.state['migration']['candidate']
    updater.restore_migration(previous)
    updater.resume('migration_recovered', previous, migration=None)
if updater.state.get('maintenance_resume'):
    updater.maintenance(False, updater.state['current'])
    updater.save('up_to_date', maintenance_resume=False)
updater.state['current'] = candidate
run_dir = Path(tempfile.mkdtemp(prefix='operations-', dir=base))
backup_dir = run_dir / 'backups'; backup_dir.mkdir(mode=0o700)


def prepare(report):
    updater.save('migration_preparing', migration={'candidate': candidate, 'backup': None, 'report': str(report), 'paused': True})
    updater.maintenance(True, candidate)


def checkpoint(manifest):
    updater.state['migration']['backup'] = str(manifest)
    updater.save('migration_running')


def fixture(mode):
    subprocess.run(['docker','--context','orbstack','exec','-e','QA_REHEARSAL=1',backend,'node','scripts/qa-rehearsal-shops.mjs',mode], check=True, timeout=120)


def backup(name):
    manifest = backup_dir / (name + '.json')
    subprocess.run([sys.executable,str(ROOT / 'deploy/backup-postgres.py'),'--env-file',state['env'],'--project',state['project'],
        '--compose-file',str(ROOT / 'compose.production.yaml'),'--compose-file',state['override'],'--directory',str(backup_dir),'--manifest',str(manifest)],check=True,timeout=900)
    return manifest


fixture('seed')
platform_report = run_dir / 'platform-restore.json'
prepare(platform_report)
first = backup('two-shops')
checkpoint(first)
manifest = json.loads(first.read_text())
assert len(manifest['databases']) >= 4 and manifest['restoreVerified']  # legacy + platform + at least two isolated shops
controller.atomic_json(platform_report, {'format': 1, 'attempted': ['platform'], 'upgraded': [], 'complete': False})
owner.query('platform', 'CREATE TABLE fixture_restore_extra (id text PRIMARY KEY);')
updater.restore_migration(candidate)
assert json.loads(platform_report.read_text())['restored'] == ['platform']
assert owner.query('platform', "SELECT to_regclass('public.fixture_restore_extra') IS NULL;") == 't'
updater.resume('migration_recovered', candidate, migration=None)
fixture('older')
report_dir = run_dir / 'upgrade'; report_dir.mkdir(mode=0o700)
report = report_dir / 'report.json'
prepare(report)
second = backup('before-failed-upgrade')
checkpoint(second)
command = ['docker','--context','orbstack','run','--rm','--user','0','--network',state['project']+'_private',
    '-v',str(base/'platform')+':/run/secrets/platform:ro','-v',str(base/'keys')+':/run/secrets/integration_keys:ro',
    '-v',str(second)+':/run/backup/manifest.json:ro','-v',str(report_dir)+':/run/upgrade',
    '-v',str(ROOT/'src')+':/app/src:ro','-v',str(ROOT/'scripts/upgrade-platform.mjs')+':/app/scripts/upgrade-platform.mjs:ro',
    '--entrypoint','node',state['backendImage'],'scripts/upgrade-platform.mjs']
try:
    updater.migration_runner(command, candidate, 'platform', 900)
    raise AssertionError('Second tenant must fail its real schema upgrade.')
except subprocess.CalledProcessError:
    pass
finally:
    updater.stop_runners()
progress = json.loads(report.read_text()); rows = json.loads(owner.query('platform',"SELECT json_agg(r ORDER BY code) FROM (SELECT code,database_name FROM tenant WHERE is_default=0) r;"))
assert progress['attempted'] == [rows[0]['database_name'],rows[1]['database_name']]
assert progress['upgraded'] == [rows[0]['database_name']] and not progress['complete']
assert owner.query(rows[0]['database_name'],'SELECT version FROM schema_meta;') == '24'
assert owner.query(rows[1]['database_name'],'SELECT version FROM schema_meta;') == '23'
assert owner.query(rows[2]['database_name'],'SELECT version FROM schema_meta;') == '23'
owner.query(rows[0]['database_name'], 'CREATE TABLE fixture_failed_upgrade_extra (id text PRIMARY KEY);')
updater.restore_migration(candidate)
restored = json.loads(report.read_text())['restored']
assert restored == list(reversed(progress['attempted']))
assert owner.query(rows[0]['database_name'], "SELECT to_regclass('public.fixture_failed_upgrade_extra') IS NULL;") == 't'
fixture('verify-failure')
updater.resume('migration_failed', candidate, migration=None)
fixture('repair')
print('Rehearsal verified: four-database backup; platform restore; second-shop failure; stopped runners; transactional restores and proofs.')
(ROOT/'output/qa/multi-tenant/r3-operations.json').write_text(json.dumps({'backupDatabases':len(manifest['databases']),'platformRestoreVerified':True,'upgradeAttempted':len(progress['attempted']),'upgradedBeforeFailure':len(progress['upgraded']),'restoredAndVerified':len(restored),'thirdShopUntouched':True,'maintenanceDrained':True,'stoppedNamedRunners':True},indent=2))
