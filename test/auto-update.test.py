import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import io
import sys
import hashlib
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('auto_update', Path(__file__).resolve().parents[1] / 'deploy/auto-update.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
OLD, NEW = 'a' * 40, 'b' * 40

class Fake(m.Updater):
    def __init__(self):
        self.state = {'current': {'sha': OLD, 'release': '/old'}}
        self.events = []
        self.fail = None
    def render(self, item): self.events.append('render')
    def build(self, item):
        self.events.append('build')
        if self.fail == 'build': raise RuntimeError()
    def backup(self): self.events.append('backup')
    def violations(self, candidate): return self.problems if hasattr(self, 'problems') else []
    def migration_required(self, candidate): return False
    def migrate(self, candidate):
        self.events.append('migrate')
        if self.fail == 'migrate': raise RuntimeError()
        return True
    def remote_head(self): return NEW
    def approved(self, sha): return True
    def save(self, status, **fields):
        self.events.append(status)
        self.state.update(last_status=status, **fields)
    def activate(self, item): self.events.append('activate:' + item['sha'])
    def health(self, item):
        self.events.append('health:' + item['sha'])
        if self.fail == 'health' and item['sha'] == NEW: raise RuntimeError()
        if self.fail == 'rollback': raise RuntimeError()

class Tests(unittest.TestCase):
    def test_backup_manifest_accepts_same_directory_alias_but_not_escape_or_file_symlink(self):
        directory = Path(__file__).resolve().parents[1] / 'deploy'
        sys.path.insert(0, str(directory))
        spec = importlib.util.spec_from_file_location('backup', directory / 'backup-postgres.py')
        backup = importlib.util.module_from_spec(spec); spec.loader.exec_module(backup)
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder).resolve(); private = base / 'private'; private.mkdir()
            alias = base / 'alias'; alias.symlink_to(private, target_is_directory=True)
            self.assertEqual(backup.manifest_path(alias / 'manifest.json', private), private / 'manifest.json')
            with self.assertRaisesRegex(RuntimeError, 'inside'):
                backup.manifest_path(base / 'escaped.json', private)
            (private / 'manifest.json').symlink_to(base / 'escaped.json')
            with self.assertRaisesRegex(RuntimeError, 'inside'):
                backup.manifest_path(alias / 'manifest.json', private)

    def test_setup_recovers_interrupted_revoke_but_refuses_foreign_owner(self):
        directory = Path(__file__).resolve().parents[1] / 'deploy'
        spec = importlib.util.spec_from_file_location('setup', directory / 'setup-platform.py')
        setup = importlib.util.module_from_spec(spec); spec.loader.exec_module(setup)
        for database_owner in ['platform_app', 'unrelated_owner']:
            calls = []; revoked = False
            def query(args, sql, **kwargs):
                nonlocal revoked
                calls.append(sql)
                if 'rolname ||' in sql: return 'platform_app|false|false|false|true\nplatform_provisioner|false|true|true|true'
                if 'pg_get_userbyid' in sql: return database_owner + ('|true' if revoked else '|false')
                if 'rolconfig' in sql: return 'createrole_self_grant=set, inherit'
                if 'SELECT 1 FROM pg_database' in sql: return '1'
                if sql.startswith('REVOKE'): revoked = True
                return ''
            with patch.object(setup, 'query', query), patch.object(setup, 'secret', return_value='fictional'*4), patch.object(sys, 'argv', ['setup']):
                with patch('builtins.print'):
                    result = setup.main()
            self.assertEqual(result, 0 if database_owner == 'platform_app' else 1)
            self.assertEqual(revoked, database_owner == 'platform_app')
            self.assertFalse(any(sql.startswith('CREATE DATABASE') for sql in calls))

    def test_purge_reuses_verified_checkpoint_after_database_drop(self):
        self.purge_checkpoint_case('retry')

    def test_purge_checkpoint_refuses_another_target(self):
        self.purge_checkpoint_case('target')

    def test_purge_checkpoint_refuses_corrupt_or_foreign_archive(self):
        self.purge_checkpoint_case('corrupt')

    def purge_checkpoint_case(self, mode):
        directory = Path(__file__).resolve().parents[1] / 'deploy'
        sys.path.insert(0, str(directory))
        spec = importlib.util.spec_from_file_location('purge', directory / 'purge-tenant.py')
        purge = importlib.util.module_from_spec(spec); spec.loader.exec_module(purge)
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder).resolve()
            row = {'id': 'a'*8+'-'+ 'a'*4+'-'+ 'a'*4+'-'+ 'a'*4+'-'+ 'a'*12,
                   'code': 'fictional', 'revision': 4, 'database_name': 't_fictional_aaaaaaaa',
                   'database_role': 't_fictional_aaaaaaaa', 'delete_after': '2020-01-01T00:00:00Z'}
            target = {'context': 'orbstack', 'container': 'a'*64, 'owner': 'fictional_owner'}
            calls = []
            class Owner:
                def backup(self, database, label, directory):
                    calls.append(database)
                    archive = directory / 'fictional.dump'; archive.write_bytes(b'fictional verified archive'); archive.chmod(0o600)
                    proof = directory / 'fictional.dump.json'
                    purge.private_json(proof, {'database': database, 'restoreVerified': True,
                                              'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest()})
                    return {'database': database, 'archive': str(archive), 'evidence': str(proof)}
                def verify_archive(self, archive, evidence):
                    if hashlib.sha256(archive.read_bytes()).hexdigest() != evidence['archiveSha256']:
                        raise RuntimeError('Archive checksum mismatch.')
            owner = Owner()
            checkpoint = purge.final_backup(owner, row, base, target)
            self.assertEqual(checkpoint.stat().st_mode & 0o777, 0o600)
            if mode == 'retry':
                # The database may now be absent; retry must not invoke a fresh backup.
                owner.backup = lambda *args: self.fail('Retry tried to back up the dropped database.')
                purge.final_backup(owner, row, base, target)
            elif mode == 'target':
                with self.assertRaisesRegex(RuntimeError, 'target'):
                    purge.final_backup(owner, row, base, {**target, 'container': 'b'*64})
            else:
                (base / 'fictional.dump').write_bytes(b'corrupt')
                with self.assertRaisesRegex(RuntimeError, 'checksum'):
                    purge.final_backup(owner, row, base, target)
            self.assertEqual(calls, [row['database_name']])

    def test_snapshot_deadline_also_rejects_buffered_ready_marker(self):
        spec = importlib.util.spec_from_file_location('proof', Path(__file__).resolve().parents[1] / 'deploy/postgres_backup.py')
        proof = importlib.util.module_from_spec(spec); spec.loader.exec_module(proof)
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b'{"snapshot":"fixture"}\n{"schemaVersion":1}\n{"schemaSha256":"fixture"}\nPROOF_READY\n'); os.close(write_fd)
        class Process:
            stdin = io.StringIO()
            stdout = os.fdopen(read_fd, 'r')
            returncode = None
            def poll(self): return self.returncode
            def wait(self, **kwargs): self.returncode = 0; return 0
            def terminate(self): self.returncode = 0
        process = Process(); clock = [0]; original_read = os.read
        def delayed_read(fd, size):
            result = original_read(fd, size); clock[0] = 181; return result
        try:
            with patch.object(proof.subprocess, 'Popen', return_value=process), patch.object(proof.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(proof.os, 'read', side_effect=delayed_read):
                with self.assertRaisesRegex(RuntimeError, 'timed out'):
                    proof.SnapshotLease(proof.OwnerPostgres('orbstack', 'online-shopping-rehearsal-postgres-1'), 'platform')
            self.assertEqual(process.returncode, 0)
        finally: process.stdout.close()

    def test_entrypoint_preserves_terminal_deployment_failure_state(self):
        for status in ['rolled_back', 'rollback_failed', 'build_failed', 'migration_failed', 'migration_restore_failed', 'backup_failed']:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as root:
                u = Fake()
                def poll(retry):
                    u.save(status)
                    raise RuntimeError('fixture failure')
                u.poll = poll
                with patch.object(m, 'Updater', return_value=u), patch.object(m.sys, 'argv', ['auto-update.py', '--state-dir', root]), patch.object(m.sys, 'stderr', io.StringIO()):
                    with self.assertRaises(SystemExit) as error: m.main()
                self.assertEqual(error.exception.code, 1)
                self.assertEqual(u.state['last_status'], status)
                self.assertNotIn('check_failed', u.events)

    def test_maintenance_uses_rendered_project_volume_name(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); (root / 'configs').mkdir()
            path = root / 'configs' / (OLD + '.json')
            config = {'services': {'backend': {'volumes': [{'type': 'volume', 'source': 'deployment_state', 'target': '/run/deployment'}]}},
                      'volumes': {'deployment_state': {'name': m.PROJECT + '_deployment_state'}}}
            path.write_text(json.dumps(config))
            u = Fake(); u.root = root; seen = []
            def run(command, **kwargs):
                seen.append(command)
                return '{"paused":true,"drained":true}\n'
            u.run = run
            u.maintenance(True, {'sha': NEW, 'release': '/new'})
            self.assertIn(m.PROJECT + '_deployment_state:/run/deployment', seen[0])
            for definition in ({'name': 'another-project_deployment_state'}, {'name': m.PROJECT + '_deployment_state', 'external': True}, {}):
                config['volumes']['deployment_state'] = definition; path.write_text(json.dumps(config))
                with self.assertRaisesRegex(RuntimeError, 'belong to this project'):
                    u.maintenance(True, {'sha': NEW, 'release': '/new'})
            self.assertEqual(len(seen), 1)

    def test_docker_config_is_private_and_has_no_credential_helper(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as home:
            for name in ('contexts', 'buildx', 'cli-plugins'): (Path(home) / '.docker' / name).mkdir(parents=True)
            (Path(home) / '.docker/config.json').write_text(json.dumps({'credsStore': 'desktop'}))
            directory = Path(m.isolated_docker_config(root, home))
            config = json.loads((directory / 'config.json').read_text())
            self.assertNotIn('credsStore', config)
            self.assertEqual(config['currentContext'], 'orbstack')
            for name in ('contexts', 'buildx', 'cli-plugins'): self.assertEqual((directory / name).resolve(), (Path(home) / '.docker' / name).resolve())
            self.assertEqual(m.isolated_docker_config(root, home), str(directory))

    def test_run_uses_the_private_docker_config(self):
        with tempfile.TemporaryDirectory() as root:
            u = Fake(); u.root = Path(root)
            seen = u.run([__import__('sys').executable, '-c', 'import os;print(os.environ["DOCKER_CONFIG"])'], capture=True).strip()
            self.assertEqual(seen, str(Path(root) / 'docker-config'))

    def test_ci_requires_exact_successful_main_push(self):
        run = dict(id=1, run_attempt=1, head_sha=NEW, head_branch='main', event='push', path='.github/workflows/verify.yml', status='completed', conclusion='success')
        self.assertTrue(m.ci_passed({'workflow_runs': [run]}, NEW))
        for field, value in [('head_sha', OLD), ('head_branch', 'feature'), ('event', 'pull_request'), ('path', 'other.yml'), ('status', 'in_progress'), ('conclusion', 'failure')]:
            self.assertFalse(m.ci_passed({'workflow_runs': [dict(run, **{field: value})]}, NEW))
        self.assertFalse(m.ci_passed({'workflow_runs': [run, dict(run, id=2, conclusion='failure')]}, NEW))
        self.assertFalse(m.ci_passed({'workflow_runs': [run, dict(run, run_attempt=2, status='in_progress')]}, NEW))
    def test_atomic_state_permissions_and_failed_write(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'state.json'
            m.atomic_json(p, {'value': 1})
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            with patch.object(m.os, 'replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError): m.atomic_json(p, {'value': 2})
            self.assertEqual(json.loads(p.read_text()), {'value': 1})
            self.assertEqual(list(Path(folder).glob('.state-*')), [])
            link = Path(folder) / 'link'
            link.symlink_to(p)
            with self.assertRaises(RuntimeError): m.atomic_json(link, {})
    def test_success_and_backup_before_cutover(self):
        u = Fake()
        u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['current']['sha'], NEW)
        self.assertEqual(u.state['previous']['sha'], OLD)
        self.assertLess(u.events.index('backup'), u.events.index('activate:' + NEW))
    def test_public_failure_restores_previous_without_restoring_database(self):
        u = Fake(); u.fail = 'health'
        with self.assertRaises(RuntimeError): u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertEqual(u.state['failed_sha'], NEW)
        self.assertIsNone(u.state['pending'])
        self.assertEqual(u.events[-1], 'rolled_back')
        self.assertIn('health:' + OLD, u.events)
    def test_failed_rollback_retains_recovery_marker(self):
        u = Fake(); u.fail = 'rollback'
        with self.assertRaises(RuntimeError): u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['pending']['sha'], NEW)
        self.assertEqual(u.state['last_status'], 'rollback_failed')
    def test_failed_build_does_not_cut_over_or_retry_same_release(self):
        u = Fake(); u.fail = 'build'
        with self.assertRaises(RuntimeError): u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['failed_sha'], NEW)
        self.assertNotIn('activate:' + NEW, u.events)
        u.poll()
        self.assertEqual(u.events[-1], 'failed_release_waiting')
    def test_superseded_build_does_not_cut_over(self):
        u = Fake(); u.remote_head = lambda: OLD
        u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertNotIn('activate:' + NEW, u.events)
    def test_interrupted_cutover_restores_recorded_current(self):
        u = Fake(); u.state['pending'] = {'sha': NEW, 'release': '/new'}
        u.recover()
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertEqual(u.state['failed_sha'], NEW)
        self.assertIsNone(u.state['pending'])
    def test_public_checks_identify_monitor_and_validate_revision(self):
        u = object.__new__(m.Updater)
        def response(request, timeout):
            self.assertEqual(request.get_header('User-agent'), 'OnlineShoppingDeploy/1.0')
            status = 'ready' if request.full_url.endswith('/ready') else 'alive'
            return io.BytesIO(json.dumps({'status': status, 'revision': OLD}).encode())
        # Wrong public revision must fail before container inspection.
        with patch.object(m.urllib.request, 'urlopen', side_effect=response):
            with self.assertRaises(RuntimeError): u.health({'sha': NEW})
    def test_pending_ci_keeps_live_release_unchanged(self):
        u = Fake(); u.approved = lambda sha: False
        u.checkout = lambda sha: self.fail('Unapproved checkout attempted')
        u.poll()
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertEqual(u.state['last_status'], 'waiting_for_ci')
        self.assertNotIn('build', u.events)
    def test_infrastructure_change_pauses_release(self):
        u = Fake(); u.checkout = lambda sha: '/new'
        with patch.object(m, 'fingerprint', side_effect=[{'tunnel': 'a'}, {'tunnel': 'b'}]): u.poll()
        self.assertEqual(u.state['last_status'], 'manual_migration_required')
        self.assertNotIn('build', u.events)

    def test_schema_upgrade_runs_after_backup_and_before_cutover(self):
        u = Fake()
        u.deploy({'sha': NEW, 'release': '/new'})
        self.assertLess(u.events.index('backup'), u.events.index('migrate'))
        self.assertLess(u.events.index('migrate'), u.events.index('activate:' + NEW))
        self.assertEqual(u.state['current']['sha'], NEW)

    def test_failed_schema_upgrade_never_cuts_over(self):
        u = Fake(); u.fail = 'migrate'
        with self.assertRaises(RuntimeError): u.deploy({'sha': NEW, 'release': '/new'})
        self.assertNotIn('activate:' + NEW, u.events)
        self.assertEqual(u.state['current']['sha'], OLD)
        self.assertEqual(u.state['last_status'], 'migration_failed')
        self.assertEqual(u.state['failed_sha'], NEW)

    def test_compose_policy_violation_pauses_before_build(self):
        u = Fake(); u.problems = ['service postgres changed']
        u.deploy({'sha': NEW, 'release': '/new'})
        self.assertEqual(u.state['last_status'], 'manual_migration_required')
        self.assertEqual(u.state['reasons'], ['service postgres changed'])
        for event in ('build', 'backup', 'migrate', 'activate:' + NEW): self.assertNotIn(event, u.events)

    def test_schema_version_is_read_from_the_release(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'src').mkdir(); (Path(folder) / 'src/db.js').write_text('export const SCHEMA_VERSION = 18;\n')
            self.assertEqual(m.schema_version(folder), 18)

    def test_migrate_skips_when_the_schema_is_unchanged_and_refuses_downgrades(self):
        with tempfile.TemporaryDirectory() as old, tempfile.TemporaryDirectory() as new:
            for folder, version in ((old, 17), (new, 17)):
                (Path(folder) / 'src').mkdir(); (Path(folder) / 'src/db.js').write_text(f'export const SCHEMA_VERSION = {version};\n')
            u = object.__new__(m.Updater); u.state = {'current': {'sha': OLD, 'release': old}}
            self.assertFalse(u.migrate({'sha': NEW, 'release': new}))
            (Path(new) / 'src/db.js').write_text('export const SCHEMA_VERSION = 16;\n')
            with self.assertRaises(RuntimeError): u.migrate({'sha': NEW, 'release': new})

    def test_migrate_runs_the_candidate_image_as_owner_and_checks_the_version(self):
        with tempfile.TemporaryDirectory() as old, tempfile.TemporaryDirectory() as new, tempfile.TemporaryDirectory() as root:
            for folder, version in ((old, 17), (new, 18)):
                (Path(folder) / 'src').mkdir(); (Path(folder) / 'src/db.js').write_text(f'export const SCHEMA_VERSION = {version};\n')
            (Path(root) / 'runtime.env').write_text('DATABASE_OWNER_PASSWORD_FILE_HOST=/secrets/owner\n')
            u = object.__new__(m.Updater); u.root = Path(root); u.state = {'current': {'sha': OLD, 'release': old}}
            manifest = Path(root) / 'backup.json'; manifest.write_text('{}'); u.deployment_backup = manifest
            seen = []
            version = [18]
            def fake_run(command, **kw):
                seen.append(command)
                if 'create' in command: return 'c' * 64
                if 'start' in command: return json.dumps({'version': version[0]}) + '\n'
                if any(value.endswith('/restore-postgres.py') for value in command): return '{"restoreVerified":true}\n'
                return ''
            u.run = fake_run
            self.assertTrue(u.migrate({'sha': NEW, 'release': new}))
            command = seen[0]
            self.assertIn('online-shopping-backend:' + NEW, command)
            self.assertIn('/secrets/owner:/run/secrets/owner:ro', command)
            self.assertIn(m.PROJECT + '_private', command)
            self.assertEqual(json.loads(Path(u.state['migration']['report']).read_text())['upgraded'], ['online_shopping'])
            version[0] = 17
            with self.assertRaises(RuntimeError): u.migrate({'sha': NEW, 'release': new})

    def test_platform_upgrade_runs_with_unchanged_main_and_restores_before_failure(self):
        with tempfile.TemporaryDirectory() as old, tempfile.TemporaryDirectory() as new, tempfile.TemporaryDirectory() as root:
            for folder in (old,new):
                (Path(folder)/'src').mkdir(); (Path(folder)/'src/db.js').write_text('export const SCHEMA_VERSION = 24;\n')
            root=Path(root)
            (root/'runtime.env').write_text('PLATFORM_ENABLED=1\nPLATFORM_DATABASE_PASSWORD_FILE_HOST=/secrets/platform\nINTEGRATION_KEY_FILE_HOST=/secrets/keys\n')
            manifest=root/'backup.json'; manifest.write_text('{}')
            u=object.__new__(m.Updater); u.root=root; u.state={'current':{'sha':OLD,'release':old}}; u.deployment_backup=manifest
            seen=[]
            def run(command, **kw):
                seen.append(command)
                if 'create' in command:
                    report_file=next(value.split('=',1)[1] for value in command if value.startswith('UPGRADE_REPORT_FILE='))
                    report=root/'migration-reports'/Path(report_file).name
                    m.atomic_json(report, {'format':1,'attempted':['t_alpha_12345678','t_bravo_12345678'],'upgraded':['t_alpha_12345678'],'complete':False})
                    raise RuntimeError('fixture upgrade failed')
                if any(value.endswith('/restore-postgres.py') for value in command): return '{"restoreVerified":true}\n'
                return 'fixture-container\n'
            u.run=run; u.stop_runners=lambda:None
            with self.assertRaisesRegex(RuntimeError,'fixture upgrade failed'): u.migrate({'sha':NEW,'release':new})
            self.assertIn('/secrets/platform:/run/secrets/platform:ro',seen[0])
            self.assertIn('/secrets/keys:/run/secrets/integration_keys:ro',seen[0])
            self.assertTrue(any(value.endswith('/restore-postgres.py') for value in seen[-1]))
            self.assertIn(str(manifest),seen[-1])
            self.assertFalse(any(value.endswith('/upgrade-database.mjs') for command in seen for value in command))

    def test_platform_migration_refuses_missing_deployment_backup(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); (root/'src').mkdir(); (root/'src/db.js').write_text('export const SCHEMA_VERSION = 24;\n')
            (root/'runtime.env').write_text('PLATFORM_ENABLED=1\n')
            u=object.__new__(m.Updater); u.root=root; u.state={'current':{'sha':OLD,'release':str(root)}}
            u.run=lambda *args,**kw:self.fail('Unprotected upgrade attempted')
            with self.assertRaisesRegex(RuntimeError,'deployment backup'): u.migrate({'sha':NEW,'release':str(root)})

    def test_platform_restore_failure_is_not_hidden(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); (root/'src').mkdir(); (root/'src/db.js').write_text('export const SCHEMA_VERSION = 24;\n')
            (root/'runtime.env').write_text('PLATFORM_ENABLED=1\nPLATFORM_DATABASE_PASSWORD_FILE_HOST=/platform\nINTEGRATION_KEY_FILE_HOST=/keys\n')
            manifest=root/'backup.json'; manifest.write_text('{}')
            u=object.__new__(m.Updater); u.root=root; u.state={'current':{'sha':OLD,'release':str(root)}}; u.deployment_backup=manifest
            def run(command,**kw):
                if 'create' in command: raise RuntimeError('upgrade failed')
                if any(value.endswith('/restore-postgres.py') for value in command): raise RuntimeError('restore failed')
                return 'fixture-container\n'
            u.run=run;u.stop_runners=lambda:None
            with self.assertRaisesRegex(RuntimeError,'restore failed'): u.migrate({'sha':NEW,'release':str(root)})

    def test_backup_arguments_reject_injection_and_keep_production_defaults(self):
        spec=importlib.util.spec_from_file_location('backup',Path(__file__).resolve().parents[1]/'deploy/backup-postgres.py')
        import sys
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy'))
        backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)
        args=backup.parse_args([]);self.assertEqual(args.project,m.PROJECT);self.assertIsNone(args.tenant)
        self.assertEqual(backup.parse_args(['--tenant','alpha','--project','online-shopping-rehearsal']).tenant,'alpha')
        with patch('sys.stderr',io.StringIO()):
            with self.assertRaises(SystemExit):backup.parse_args(['--tenant',"alpha';DROP"])

    def test_migration_runner_is_created_before_start_and_stopped_before_restore(self):
        u=object.__new__(m.Updater);u.state={'migration':{'runners':[]}};events=[]
        def run(command,**kw):
            events.append(command)
            if 'create' in command:return 'c'*64
            if 'start' in command:raise RuntimeError('unknown committed outcome')
            if 'ps' in command:return u.state['migration']['runners'][0] if '-a' in command else ''
            return ''
        u.run=run
        with self.assertRaisesRegex(RuntimeError,'unknown committed outcome'):
            u.migration_runner(['docker','--context','orbstack','run','--rm','--network','private','image','node','upgrade'],{'sha':NEW},'main',300)
        self.assertEqual(len(u.state['migration']['runners']),1)
        self.assertIn('--name',events[0]);self.assertIn('create',events[0]);self.assertNotIn('--rm',events[0])
        u.stop_runners()
        self.assertTrue(any('stop' in command for command in events));self.assertIn('rm',events[-1])

    def test_failure_recovery_commits_resume_before_reopening_writes(self):
        u=Fake();u.state['migration']={'candidate':{'sha':NEW,'release':'/new'},'backup':'/verified','report':'/report','paused':True}
        u.restore_migration=lambda candidate:u.events.append('restore')
        def maintenance(enabled,candidate):
            self.assertFalse(enabled);self.assertIsNone(u.state['migration']);self.assertTrue(u.state['maintenance_resume'])
            u.events.append('resume')
            raise RuntimeError('crash after reopening')
        u.maintenance=maintenance
        with self.assertRaisesRegex(RuntimeError,'crash after reopening'):u.recover()
        self.assertEqual(u.events[:3],['restore','migration_recovered','resume'])
        u.restore_migration=lambda candidate:self.fail('Stale snapshot restored after resume')
        u.maintenance=lambda enabled,candidate:u.events.append('resume-again')
        u.recover();self.assertFalse(u.state['maintenance_resume']);self.assertIsNone(u.state['migration'])

    def test_unknown_main_outcome_has_intent_and_restores_before_failure(self):
        with tempfile.TemporaryDirectory() as old,tempfile.TemporaryDirectory() as new,tempfile.TemporaryDirectory() as root:
            for folder,version in [(old,23),(new,24)]:
                (Path(folder)/'src').mkdir();(Path(folder)/'src/db.js').write_text(f'export const SCHEMA_VERSION = {version};\n')
            root=Path(root);(root/'runtime.env').write_text('PLATFORM_ENABLED=0\nDATABASE_OWNER_PASSWORD_FILE_HOST=/owner\n')
            manifest=root/'backup.json';manifest.write_text('{}')
            u=object.__new__(m.Updater);u.root=root;u.state={'current':{'sha':OLD,'release':old}};u.deployment_backup=manifest
            events=[]
            def runner(command,candidate,kind,timeout):
                report=json.loads(Path(u.state['migration']['report']).read_text());self.assertEqual(report['attempted'],['online_shopping'])
                events.append('intent');raise RuntimeError('unknown main outcome')
            u.migration_runner=runner;u.restore_migration=lambda candidate:events.append('restore')
            with self.assertRaisesRegex(RuntimeError,'unknown main outcome'):u.migrate({'sha':NEW,'release':new})
            self.assertEqual(events,['intent','restore'])

    def test_single_shop_upgrade_restores_schema_before_old_images_and_reopens_only_after_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); old = root / 'old'; new = root / 'new'
            for release, version in [(old, 24), (new, 25)]:
                (release / 'src').mkdir(parents=True)
                (release / 'src/db.js').write_text(f'export const SCHEMA_VERSION = {version};\n')
            (root / 'runtime.env').write_text('PLATFORM_ENABLED=0\nDATABASE_OWNER_PASSWORD_FILE_HOST=/fixture/owner\n')
            u = object.__new__(m.Updater); u.root = root
            u.state = {'current': {'sha': OLD, 'release': str(old)}}
            candidate = {'sha': NEW, 'release': str(new)}
            events = []; paused = [False]; schema = [24]
            u.render = lambda item: None; u.build = lambda item: None; u.violations = lambda item: []
            u.remote_head = lambda: NEW; u.approved = lambda sha: True
            def save(status, **fields):
                events.append(status); u.state.update(last_status=status, **fields)
            u.save = save
            def maintenance(enabled, item):
                if not enabled:
                    self.assertIsNone(u.state['migration']); self.assertTrue(u.state['maintenance_resume'])
                paused[0] = enabled; events.append('pause' if enabled else 'resume')
            u.maintenance = maintenance
            def backup():
                self.assertTrue(paused[0]); events.append('backup')
                manifest = root / 'verified-backup.json'; manifest.write_text('{}'); u.deployment_backup = manifest
            u.backup = backup
            def runner(command, item, kind, timeout):
                self.assertTrue(paused[0]); self.assertEqual(kind, 'main')
                self.assertEqual(json.loads(Path(u.state['migration']['report']).read_text())['attempted'], ['online_shopping'])
                schema[0] = 25; events.append('upgrade'); return '{"version":25}\n'
            u.migration_runner = runner; u.stop_runners = lambda: events.append('stop')
            def restore(item):
                self.assertTrue(paused[0]); self.assertEqual(schema[0], 25)
                self.assertTrue(Path(u.state['migration']['backup']).exists())
                schema[0] = 24; events.append('restore')
            u.restore_migration = restore
            def activate(item):
                self.assertEqual(schema[0], 25 if item['sha'] == NEW else 24)
                events.append('activate:' + item['sha'])
            u.activate = activate
            def health(item):
                self.assertTrue(paused[0]); events.append('health:' + item['sha'])
                if item['sha'] == NEW: raise RuntimeError('Synthetic candidate health failure')
            u.health = health
            with self.assertRaisesRegex(RuntimeError, 'previous application images restored'): u.deploy(candidate)
            self.assertEqual(u.state['last_status'], 'rolled_back')
            self.assertEqual(schema[0], 24); self.assertFalse(paused[0]); self.assertEqual(u.state['current']['sha'], OLD)
            self.assertLess(events.index('pause'), events.index('backup'))
            self.assertLess(events.index('restore'), events.index('activate:' + OLD))
            self.assertLess(events.index('health:' + OLD), events.index('resume'))

    def test_single_shop_schema_preflight_and_missing_backup_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); old = root / 'old'; new = root / 'new'
            for release in [old, new]:
                (release / 'src').mkdir(parents=True); (release / 'src/db.js').write_text('export const SCHEMA_VERSION = 24;\n')
            (root / 'runtime.env').write_text('PLATFORM_ENABLED=0\n')
            u = object.__new__(m.Updater); u.root = root; u.state = {'current': {'sha': OLD, 'release': str(old)}}
            candidate = {'sha': NEW, 'release': str(new)}
            self.assertFalse(u.migration_required(candidate))
            (new / 'src/db.js').write_text('export const SCHEMA_VERSION = 25;\n')
            self.assertTrue(u.migration_required(candidate))
            with self.assertRaisesRegex(RuntimeError, 'deployment backup'): u.migrate(candidate)
            (new / 'src/db.js').write_text('export const SCHEMA_VERSION = 23;\n')
            with self.assertRaisesRegex(RuntimeError, 'downgrades'): u.migration_required(candidate)

    def test_single_shop_unverified_restore_keeps_maintenance_and_recovery_intent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); old = root / 'old'; new = root / 'new'
            for release, version in [(old, 24), (new, 25)]:
                (release / 'src').mkdir(parents=True); (release / 'src/db.js').write_text(f'export const SCHEMA_VERSION = {version};\n')
            (root / 'runtime.env').write_text('PLATFORM_ENABLED=0\nDATABASE_OWNER_PASSWORD_FILE_HOST=/fixture/owner\n')
            manifest = root / 'backup.json'; manifest.write_text('{}')
            u = object.__new__(m.Updater); u.root = root; u.state = {'current': {'sha': OLD, 'release': str(old)}}; u.deployment_backup = manifest
            candidate = {'sha': NEW, 'release': str(new)}
            u.state['migration'] = {'candidate': candidate, 'report': str(root / 'report.json'), 'paused': True}
            def runner(*args): raise RuntimeError('Unknown upgrade outcome')
            def restore(*args): raise RuntimeError('Unverified restore')
            u.migration_runner = runner; u.restore_migration = restore
            with self.assertRaises(m.MigrationRestoreError): u.migrate(candidate)
            self.assertTrue(u.state['migration']['paused']); self.assertEqual(u.state['migration']['backup'], str(manifest))

    def test_compose_render_format_changes_do_not_pause_a_release(self):
        R1, R2 = '/r/old', '/r/new'
        mount = lambda release, bind: {'type': 'bind', 'source': release + '/deploy/init.sh', 'target': '/i', 'bind': bind}
        config = lambda release, bind: {'services': {'postgres': {'image': 'pg', 'volumes': [mount(release, bind)]}, 'tunnel': {'image': 'cf'}}}
        # An older Compose printed the default create_host_path; a newer one does not.
        self.assertEqual(m.compose_violations(config(R1, {'create_host_path': True}), config(R2, {}), R1, R2), [])
        # A real change to the mount is still caught, and so is turning the default off.
        self.assertTrue(m.compose_violations(config(R1, {'create_host_path': True}), config(R2, {'create_host_path': False}), R1, R2))
        changed = config(R2, {}); changed['services']['postgres']['volumes'][0]['source'] = '/etc/shadow'
        self.assertTrue(m.compose_violations(config(R1, {}), changed, R1, R2))

    def test_compose_policy(self):
        R1, R2 = '/r/old', '/r/new'
        base = lambda r: {'services': {
            'postgres': {'image': 'pg', 'volumes': [{'type': 'bind', 'source': r + '/deploy/init.sh', 'target': '/i'}]},
            'tunnel': {'image': 'cf'}, 'backend': {'image': 'app', 'environment': {'A': '1'}}},
            'secrets': {'s': {'file': '/secret'}}, 'volumes': {'pg_data': {}}, 'networks': {'private': {'internal': True}}}
        old = base(R1)
        # Application changes, new secrets and a new loopback-only service are fine; release paths are ignored.
        new = base(R2); new['services']['backend']['environment']['B'] = '2'
        new['services']['qr'] = {'image': 'qr', 'ports': [{'host_ip': '127.0.0.1', 'published': '9'}]}
        new['secrets']['extra'] = {'file': '/x'}
        self.assertEqual(m.compose_violations(old, new, R1, R2), [])
        for label, mutate in [
            ('postgres image', lambda c: c['services']['postgres'].update(image='other')),
            ('tunnel removed', lambda c: c['services'].pop('tunnel')),
            ('secret path', lambda c: c['secrets']['s'].update(file='/elsewhere')),
            ('volume removed', lambda c: c['volumes'].pop('pg_data')),
            ('privileged', lambda c: c['services']['backend'].update(privileged=True)),
            ('host network', lambda c: c['services']['backend'].update(network_mode='host')),
            ('docker socket', lambda c: c['services']['backend'].update(volumes=[{'type': 'bind', 'source': '/var/run/docker.sock', 'target': '/s'}])),
            ('public port', lambda c: c['services']['backend'].update(ports=[{'host_ip': '0.0.0.0', 'published': '80'}])),
            ('open port', lambda c: c['services']['backend'].update(ports=[{'published': '80'}])),
        ]:
            bad = base(R2); mutate(bad)
            self.assertTrue(m.compose_violations(old, bad, R1, R2), label)

if __name__ == '__main__': unittest.main()
