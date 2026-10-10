#!/usr/bin/env python3
"""Poll trusted GitHub main, deploy CI-verified app images, and roll back failed releases."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import urllib.request

REPOSITORY = 'yapweijun1996/Online-Shopping'
REMOTE = 'https://github.com/' + REPOSITORY + '.git'
PROJECT = 'online-shopping-production'
SHA = re.compile(r'^[0-9a-f]{40}$')
# Files whose change always needs the operator: the tunnel definition and database initialisation.
PROTECTED = ('deploy/cloudflared.yml', 'deploy/init-postgres.sh')
# Compose services whose definition must not change automatically (the database and the tunnel).
# Everything else in compose.production.yaml may change, within compose_violations() below.
GATED_SERVICES = ('postgres', 'tunnel')


def atomic_json(path, value):
    path = Path(path)
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise RuntimeError('State target must be a regular file.')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(value, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def isolated_docker_config(root, home=None):
    """Return a private DOCKER_CONFIG directory without a credential helper.

    The global ~/.docker/config.json may name Docker Desktop's credential helper. When that helper
    stalls, every build hangs while resolving public base images, even though the stack runs on
    OrbStack. This private config keeps the shared contexts, builders and plugins but has no
    credsStore, so public images are pulled anonymously and nothing depends on Docker Desktop.
    """
    directory = Path(root) / 'docker-config'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    atomic_json(directory / 'config.json', {'currentContext': 'orbstack'})
    source = Path(home or Path.home()) / '.docker'
    for name in ('contexts', 'buildx', 'cli-plugins'):
        link, target = directory / name, source / name
        if target.exists() and not link.is_symlink() and not link.exists():
            link.symlink_to(target)
    return str(directory)


def ci_passed(payload, revision):
    runs = [run for run in payload.get('workflow_runs', [])
            if run.get('head_sha') == revision and run.get('head_branch') == 'main'
            and run.get('event') == 'push' and run.get('path') == '.github/workflows/verify.yml']
    if not runs:
        return False
    latest = max(runs, key=lambda run: (run.get('id', 0), run.get('run_attempt', 0)))
    return latest.get('status') == 'completed' and latest.get('conclusion') == 'success'


def fingerprint(release):
    result = {}
    for name in PROTECTED:
        path = Path(release) / name
        if path.is_symlink() or not path.is_file():
            raise RuntimeError('Protected deployment file is missing or a symlink.')
        result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def schema_version(release):
    text = (Path(release) / 'src/db.js').read_text()
    version = re.search(r'export const SCHEMA_VERSION = (\d+);', text)
    if not version:
        raise RuntimeError('Schema version is unavailable.')
    return int(version.group(1))


def _without_render_noise(value):
    """Drops settings that only describe how a given Docker Compose version prints a mount.

    Newer Compose versions stop printing `bind.create_host_path: true` (its default), which made an unchanged
    database service look changed and paused every release. The setting only decides whether Docker creates a
    missing host directory, so it cannot grant access to anything.
    """
    if isinstance(value, dict):
        return {key: _without_render_noise(item) for key, item in value.items() if not (key == 'create_host_path' and item is True)}
    if isinstance(value, list):
        return [_without_render_noise(item) for item in value]
    return value


def _normalised(value, release):
    # Rendered compose files embed the release directory in bind-mount paths; ignore that part.
    return json.dumps(_without_render_noise(value), sort_keys=True).replace(str(release), '<release>')


def compose_violations(current, candidate, current_release, candidate_release):
    """Reasons a rendered compose change must wait for the operator (empty list: safe to deploy).

    The database and tunnel services and every existing secret and volume must be unchanged. Other
    services (the application, and new ones such as a WhatsApp QR worker) may change, but may not gain
    host privileges, host-wide bind mounts or ports published beyond the loopback interface.
    """
    problems = []
    old, new = current.get('services', {}), candidate.get('services', {})
    for name in GATED_SERVICES:
        if name in old and _normalised(old[name], current_release) != _normalised(new.get(name), candidate_release):
            problems.append(f'service {name} changed')
    for section in ('secrets', 'volumes', 'networks'):
        for key, definition in current.get(section, {}).items():
            if _normalised(definition, current_release) != _normalised(candidate.get(section, {}).get(key), candidate_release):
                problems.append(f'{section[:-1]} {key} changed')
    for name, service in new.items():
        if name in GATED_SERVICES:
            continue
        if service.get('privileged') or service.get('cap_add') or service.get('devices'):
            problems.append(f'service {name} requests host privileges')
        if service.get('network_mode') == 'host' or service.get('pid') == 'host' or service.get('ipc') == 'host':
            problems.append(f'service {name} shares a host namespace')
        for volume in service.get('volumes', []):
            source = str(volume.get('source', ''))
            if volume.get('type') == 'bind' and not source.startswith(str(candidate_release) + '/'):
                problems.append(f'service {name} mounts a host path outside the release')
        for port in service.get('ports', []):
            if port.get('host_ip') not in ('127.0.0.1', '::1'):
                problems.append(f'service {name} publishes a port beyond loopback')
    return problems


class MigrationRestoreError(RuntimeError):
    pass


class Updater:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.state_path = self.root / 'state.json'
        self.state = json.loads(self.state_path.read_text())
        self.config = json.loads((self.root / 'config.json').read_text())
        if self.config.get('repository') != REPOSITORY:
            raise RuntimeError('Unexpected repository scope.')
        for item in [self.state['current'], self.state.get('previous'), self.state.get('pending')]:
            if item and (not SHA.fullmatch(item['sha']) or Path(item['release']).resolve() != self.root / 'releases' / item['sha']):
                raise RuntimeError('Invalid release state.')

    def run(self, command, *, capture=False, timeout=120, env=None):
        env = dict(os.environ if env is None else env, DOCKER_CONFIG=isolated_docker_config(self.root))
        return subprocess.run(command, check=True, text=True, capture_output=capture,
                              timeout=timeout, env=env).stdout

    def save(self, status, **fields):
        self.state.update(last_status=status, checked_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), **fields)
        atomic_json(self.state_path, self.state)
        print(status, fields.get('sha', self.state['current']['sha']), flush=True)

    def remote_head(self):
        value = self.run(['git', 'ls-remote', REMOTE, 'refs/heads/main'], capture=True, timeout=45).strip().split()
        if len(value) != 2 or value[1] != 'refs/heads/main' or not SHA.fullmatch(value[0]):
            raise RuntimeError('Invalid remote main reference.')
        return value[0]

    def approved(self, sha):
        endpoint = f'repos/{REPOSITORY}/actions/workflows/verify.yml/runs?branch=main&head_sha={sha}&event=push&per_page=20'
        payload = json.loads(self.run(['gh', 'api', endpoint], capture=True, timeout=45))
        return ci_passed(payload, sha)

    def checkout(self, sha):
        release = self.root / 'releases' / sha
        mirror = self.root / 'mirror.git'
        if not mirror.exists():
            self.run(['git', 'init', '--bare', str(mirror)])
        self.run(['git', '--git-dir', str(mirror), 'fetch', '--no-tags', REMOTE,
                  '+refs/heads/main:refs/heads/main'], timeout=120)
        fetched = self.run(['git', '--git-dir', str(mirror), 'rev-parse', 'refs/heads/main'], capture=True).strip()
        if fetched != sha:
            raise RuntimeError('Main changed while preparing the release; defer to the next poll.')
        self.run(['git', '--git-dir', str(mirror), 'merge-base', '--is-ancestor', self.state['current']['sha'], sha])
        if release.exists():
            if release.is_symlink() or self.run(['git', '-C', str(release), 'rev-parse', 'HEAD'], capture=True).strip() != sha:
                raise RuntimeError('Release path does not match its commit.')
            if self.run(['git', '-C', str(release), 'status', '--porcelain'], capture=True).strip():
                raise RuntimeError('Release checkout was modified.')
        else:
            self.run(['git', 'clone', '--no-checkout', '--shared', str(mirror), str(release)])
            self.run(['git', '-C', str(release), 'checkout', '--detach', sha])
        return release

    def compose(self, item):
        return ['docker', '--context', 'orbstack', 'compose', '-p', PROJECT,
                '-f', str(self.root / 'configs' / (item['sha'] + '.json'))]

    def render(self, item):
        env = dict(os.environ, DEPLOY_IMAGE_TAG=item['sha'])
        payload = json.loads(self.run(['docker', '--context', 'orbstack', 'compose', '-p', PROJECT,
             '--env-file', str(self.root / 'runtime.env'), '--project-directory', item['release'],
             '-f', str(Path(item['release']) / 'compose.production.yaml'), 'config', '--format', 'json'],
             capture=True, env=env))
        atomic_json(self.root / 'configs' / (item['sha'] + '.json'), payload)

    def backup(self):
        item = self.state['current']
        directory = Path.home() / 'Backups/Online-Shopping'
        manifest = directory / ('deployment-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(4) + '.json')
        script = Path(item['release']) / 'deploy/backup-postgres.py'
        command = [sys.executable, str(script), '--env-file', str(self.root / 'runtime.env')]
        if '--manifest' in script.read_text(): command += ['--manifest', str(manifest)]
        self.run(command, timeout=900)
        self.deployment_backup = manifest if manifest.exists() else None

    def build(self, item):
        self.run(self.compose(item) + ['build', 'frontend', 'backend'], timeout=900)
        self.run(['docker', '--context', 'orbstack', 'run', '--rm', '--entrypoint', 'caddy',
                  '-v', str(Path(item['release']) / 'deploy/Caddyfile.production') + ':/etc/caddy/Caddyfile:ro',
                  'online-shopping-frontend:' + item['sha'], 'validate', '--config', '/etc/caddy/Caddyfile'])

    def services(self, item):
        config = json.loads((self.root / 'configs' / (item['sha'] + '.json')).read_text())
        return config.get('services', {})

    def violations(self, candidate):
        current = self.state['current']
        old = json.loads((self.root / 'configs' / (current['sha'] + '.json')).read_text())
        new = json.loads((self.root / 'configs' / (candidate['sha'] + '.json')).read_text())
        return compose_violations(old, new, current['release'], candidate['release'])

    def runtime(self):
        path = self.root / 'runtime.env' if hasattr(self, 'root') else None
        return dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line) if path and path.exists() else {}

    def migration_required(self, candidate):
        if self.runtime().get('PLATFORM_ENABLED') != '1': return False
        version = int(re.search(r'PLATFORM_SCHEMA_VERSION = (\d+)', (Path(candidate['release']) / 'src/platform/platform-db.js').read_text()).group(1))
        postgres = self.run(self.compose(self.state['current']) + ['ps', '-q', 'postgres'], capture=True).strip()
        output = self.run([sys.executable, str(Path(candidate['release']) / 'deploy/needs-upgrade.py'),
                          '--container', postgres, '--shop-version', str(schema_version(candidate['release'])),
                          '--platform-version', str(version)], capture=True)
        return json.loads(output.strip().splitlines()[-1])['required']

    def maintenance(self, enabled, candidate):
        config = json.loads((self.root / 'configs' / (self.state['current']['sha'] + '.json')).read_text())
        volumes = config.get('services', {}).get('backend', {}).get('volumes', [])
        matches = [volume for volume in volumes if volume.get('target') == '/run/deployment' and volume.get('type') == 'volume']
        if len(matches) != 1:
            raise RuntimeError('Durable deployment maintenance volume is required.')
        definition = config.get('volumes', {}).get(matches[0].get('source'), {})
        name = definition.get('name', '')
        if definition.get('external') or not re.fullmatch(PROJECT + r'_[a-z0-9_]+', name):
            raise RuntimeError('Deployment maintenance volume must belong to this project.')
        script = Path(candidate['release']) / 'scripts/deployment-maintenance.mjs'
        output = self.run(['docker', '--context', 'orbstack', 'run', '--rm', '--user', '0', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', PROJECT + '_private',
            '-v', name + ':/run/deployment', '-v', str(script) + ':/app/scripts/deployment-maintenance.mjs:ro',
            '-e', 'DEPLOYMENT_STATE_DIR=/run/deployment', '-e', 'MAINTENANCE_HEALTH_URL=http://backend:3000/health',
            '--entrypoint', 'node', 'online-shopping-backend:' + candidate['sha'], '/app/scripts/deployment-maintenance.mjs',
            'enter' if enabled else 'exit'], capture=True, timeout=210)
        proof = json.loads(output.strip().splitlines()[-1])
        if proof.get('paused') != enabled or (enabled and proof.get('drained') is not True):
            raise RuntimeError('Deployment maintenance was not verified.')

    def migration_report(self, candidate):
        directory = self.root / 'migration-reports'; directory.mkdir(mode=0o700, exist_ok=True); directory.chmod(0o700)
        return directory / (candidate['sha'] + '-' + secrets.token_hex(4) + '.json')

    def migration_runner(self, command, candidate, kind, timeout):
        progress = self.state['migration']
        name = PROJECT + '-upgrade-' + candidate['sha'][:12] + '-' + secrets.token_hex(4) + '-' + kind
        progress.setdefault('runners', []).append(name)
        if hasattr(self, 'state_path'): self.save('migration_running')
        create = list(command); create[create.index('run')] = 'create'; create.remove('--rm')
        create[4:4] = ['--name', name, '--label', 'com.online-shopping.operation=database-upgrade']
        # Create before start: a lost create response can leave an inert container, never an untracked writer.
        identity = self.run(create, capture=True, timeout=120).strip()
        if not re.fullmatch(r'[a-f0-9]{64}', identity): raise RuntimeError('Invalid migration container identity.')
        return self.run(['docker', '--context', 'orbstack', 'start', '--attach', name], capture=True, timeout=timeout)

    def stop_runners(self):
        for name in self.state.get('migration', {}).get('runners', []):
            if not re.fullmatch(PROJECT + r'-upgrade-[a-f0-9]{12}-[a-f0-9]{8}-(main|platform)', name):
                raise RuntimeError('Unexpected migration runner scope.')
            query = ['docker', '--context', 'orbstack', 'ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.Names}}']
            found = self.run(query, capture=True).strip()
            if not found: continue
            if found != name: raise RuntimeError('Ambiguous migration runner identity.')
            self.run(['docker', '--context', 'orbstack', 'stop', '--time', '30', name], timeout=60)
            if self.run([value for value in query if value != '-a'], capture=True).strip():
                raise RuntimeError('Migration writer is still running.')
            self.run(['docker', '--context', 'orbstack', 'rm', name])

    def restore_migration(self, candidate):
        progress = self.state.get('migration')
        if not progress: return
        self.stop_runners()
        if not progress.get('backup'): return
        postgres = self.run(self.compose(self.state['current']) + ['ps', '-q', 'postgres'], capture=True).strip()
        backend = self.run(self.compose(self.state['current']) + ['ps', '-q', 'backend'], capture=True).strip()
        output = self.run([sys.executable, str(Path(candidate['release']) / 'deploy/restore-postgres.py'),
            '--container', postgres, '--backend', backend, '--manifest', progress['backup'], '--report', progress['report']], capture=True, timeout=900)
        if json.loads(output.strip().splitlines()[-1]).get('restoreVerified') is not True:
            raise RuntimeError('Deployment database restore is unverified.')

    def migrate(self, candidate):
        """Main upgrade first, then platform and isolated shops; every attempted database has durable intent."""
        before, after = schema_version(self.state['current']['release']), schema_version(candidate['release'])
        if after < before: raise RuntimeError('Schema downgrades are never automatic.')
        runtime = self.runtime(); enabled = runtime.get('PLATFORM_ENABLED') == '1'
        if after == before and not enabled: return False
        report = None
        if enabled:
            manifest = getattr(self, 'deployment_backup', None)
            if not manifest or not manifest.exists(): raise RuntimeError('Platform upgrade requires this deployment backup.')
            progress = self.state.get('migration') or {'candidate': candidate, 'report': str(self.migration_report(candidate)), 'paused': False}
            progress['backup'] = str(manifest); self.state['migration'] = progress
            report = Path(progress['report']); directory = report.parent
        main_ran = False
        try:
            if after != before:
                if report: atomic_json(report, {'format': 1, 'attempted': ['online_shopping'], 'upgraded': [], 'complete': False})
                owner = runtime['DATABASE_OWNER_PASSWORD_FILE_HOST']
                script = Path(candidate['release']) / 'scripts/upgrade-database.mjs'
                command = ['docker', '--context', 'orbstack', 'run', '--rm', '--network', PROJECT + '_private',
                    '-v', owner + ':/run/secrets/owner:ro', '-v', str(script) + ':/app/scripts/upgrade-database.mjs:ro',
                    '--entrypoint', 'node', 'online-shopping-backend:' + candidate['sha'], '/app/scripts/upgrade-database.mjs']
                output = self.migration_runner(command, candidate, 'main', 300) if enabled else self.run(command, capture=True, timeout=300)
                main_ran = True
                if json.loads(output.strip().splitlines()[-1]).get('version') != after:
                    raise RuntimeError('Database schema is not at the expected version after the upgrade.')
                if report:
                    proof = json.loads(report.read_text()); proof['upgraded'].append('online_shopping'); atomic_json(report, proof)
            if enabled:
                script = Path(candidate['release']) / 'scripts/upgrade-platform.mjs'
                command = ['docker', '--context', 'orbstack', 'run', '--rm', '--user', '0', '--read-only',
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', PROJECT + '_private',
                    '-v', runtime['PLATFORM_DATABASE_PASSWORD_FILE_HOST'] + ':/run/secrets/platform:ro',
                    '-v', runtime['INTEGRATION_KEY_FILE_HOST'] + ':/run/secrets/integration_keys:ro',
                    '-v', str(manifest) + ':/run/backup/manifest.json:ro', '-v', str(directory) + ':/run/upgrade',
                    '-v', str(script) + ':/app/scripts/upgrade-platform.mjs:ro',
                    '-e', 'UPGRADE_REPORT_FILE=/run/upgrade/' + report.name, '--entrypoint', 'node',
                    'online-shopping-backend:' + candidate['sha'], '/app/scripts/upgrade-platform.mjs']
                output = self.migration_runner(command, candidate, 'platform', 900)
                result = json.loads(output.strip().splitlines()[-1]); proof = json.loads(report.read_text())
                if result.get('version') != after or proof.get('complete') is not True:
                    raise RuntimeError('Platform upgrade did not complete.')
            if enabled: self.stop_runners()
            return main_ran or enabled
        except Exception:
            if enabled:
                try: self.restore_migration(candidate)
                except Exception as error: raise MigrationRestoreError('Deployment restore failed; maintenance remains enabled.') from error
            raise

    def activate(self, item):
        # Application services only: the database and the tunnel are never recreated automatically.
        names = [name for name in self.services(item) if name not in GATED_SERVICES]
        self.run(self.compose(item) + ['up', '-d', '--no-deps', '--no-build', '--wait',
                                       '--wait-timeout', '90', '--force-recreate'] + names, timeout=180)

    def health(self, item):
        for host in ['shop.gmb01.xyz', 'seller.gmb01.xyz']:
            for endpoint, expected in [('ready', 'ready'), ('health', 'alive')]:
                request = urllib.request.Request(f'https://{host}/{endpoint}', headers={'Cache-Control': 'no-cache', 'User-Agent': 'OnlineShoppingDeploy/1.0'})
                with urllib.request.urlopen(request, timeout=15) as response:
                    body = json.load(response)
                if body.get('status') != expected or body.get('revision') != item['sha']:
                    raise RuntimeError('Public endpoint does not serve the expected release.')
        for service in ['frontend', 'backend']:
            ids = self.run(self.compose(item) + ['ps', '-q', service], capture=True).strip()
            if not ids or '\n' in ids:
                raise RuntimeError('Unexpected application container count.')
            metadata = json.loads(self.run(['docker', '--context', 'orbstack', 'inspect', ids], capture=True))[0]
            if metadata['Config']['Labels'].get('org.opencontainers.image.revision') != item['sha']:
                raise RuntimeError('Container revision mismatch.')
            desired = self.run(['docker', '--context', 'orbstack', 'image', 'inspect',
                f'online-shopping-{service}:{item["sha"]}', '--format', '{{.Id}}'], capture=True).strip()
            if metadata['Image'] != desired:
                raise RuntimeError('Container image mismatch.')

    def deploy(self, candidate):
        try:
            self.render(candidate)
            reasons = self.violations(candidate)
            if reasons:
                self.save('manual_migration_required', sha=candidate['sha'], reasons=reasons)
                return
            self.build(candidate)
        except Exception:
            self.save('build_failed', failed_sha=candidate['sha'])
            raise
        paused = self.migration_required(candidate)
        if paused:
            self.save('migration_preparing', migration={'candidate': candidate, 'report': str(self.migration_report(candidate)), 'backup': None, 'paused': True})
            self.maintenance(True, candidate)
        try:
            self.backup()
        except Exception:
            if paused: self.resume('backup_failed', candidate, migration=None)
            raise
        if paused:
            self.state['migration']['backup'] = str(self.deployment_backup)
            self.save('migration_running')
        # A newer push during build/backup supersedes this candidate before traffic changes.
        if self.remote_head() != candidate['sha'] or not self.approved(candidate['sha']):
            self.resume('superseded', candidate, paused=paused, sha=candidate['sha'], migration=None)
            return
        previous = self.state['current']
        try:
            migrated = self.migrate(candidate)
        except MigrationRestoreError:
            self.save('migration_restore_failed', failed_sha=candidate['sha'])
            raise
        except Exception:
            self.resume('migration_failed', candidate, paused=paused, failed_sha=candidate['sha'], migration=None)
            raise
        self.save('deploying', pending=candidate, migrated=migrated)
        try:
            self.activate(candidate)
            self.health(candidate)
        except Exception:
            try:
                if self.state.get('migration'): self.restore_migration(candidate)
                self.activate(previous)
                self.health(previous)
            except Exception:
                self.save('rollback_failed', failed_sha=candidate['sha'])
                raise RuntimeError('Automatic rollback failed; operator intervention is required.') from None
            self.resume('rolled_back', candidate, paused=paused, failed_sha=candidate['sha'], pending=None, migration=None)
            raise RuntimeError('Release failed validation; previous application images restored.') from None
        self.state.update(current=candidate, previous=previous, pending=None, failed_sha=None, migration=None)
        # Commit the validated release before allowing writes. Recovery must never restore a stale snapshot after resume.
        self.save('deployed', sha=candidate['sha'], maintenance_resume=paused)
        if paused:
            self.maintenance(False, candidate)
            self.save('deployed', sha=candidate['sha'], maintenance_resume=False)

    def resume(self, status, candidate, *, paused=True, **fields):
        # Clear restore intent durably before any route or worker can accept a new write.
        self.save(status, maintenance_resume=bool(paused), **fields)
        if paused:
            self.maintenance(False, candidate)
            self.save(status, maintenance_resume=False)

    def recover(self):
        progress = self.state.get('migration')
        if progress:
            candidate = progress['candidate']
            try: self.restore_migration(candidate)
            except Exception:
                self.save('migration_restore_failed', failed_sha=candidate['sha'])
                raise MigrationRestoreError('Interrupted migration could not be restored.') from None
            if self.state.get('pending'):
                self.activate(self.state['current']); self.health(self.state['current'])
            self.resume('migration_recovered', candidate, paused=progress.get('paused'), failed_sha=candidate['sha'], pending=None, migration=None)
        elif self.state.get('pending'):
            self.activate(self.state['current']); self.health(self.state['current'])
            self.save('recovered', failed_sha=self.state['pending']['sha'], pending=None)
        if self.state.get('maintenance_resume'):
            self.maintenance(False, self.state['current']); self.save('up_to_date', maintenance_resume=False)

    def poll(self, retry=False):
        self.recover()
        sha = self.remote_head()
        if sha == self.state['current']['sha']:
            self.save('up_to_date')
            return
        if sha == self.state.get('failed_sha') and not retry:
            self.save('failed_release_waiting', sha=sha)
            return
        if not self.approved(sha):
            self.save('waiting_for_ci', sha=sha)
            return
        release = self.checkout(sha)
        if fingerprint(release) != fingerprint(self.state['current']['release']):
            self.save('manual_migration_required', sha=sha)
            return
        self.deploy({'sha': sha, 'release': str(release)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', default=str(Path.home() / 'Library/Application Support/Online-Shopping/auto-deploy'))
    parser.add_argument('--backup', action='store_true')
    parser.add_argument('--retry', action='store_true')
    args = parser.parse_args()
    root = Path(args.state_dir)
    if not root.is_dir():
        raise SystemExit('Automatic deployment is not installed.')
    with open(root / 'update.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another update or backup is already running.')
            return
        updater = Updater(root)
        try:
            if args.backup:
                updater.backup()
            else:
                updater.poll(args.retry)
        except Exception as error:
            print('Auto-update failed:', type(error).__name__, file=sys.stderr)
            if updater.state.get('last_status') not in ['rolled_back', 'rollback_failed', 'build_failed', 'migration_failed', 'migration_restore_failed', 'backup_failed']:
                updater.save('check_failed')
            raise SystemExit(1)


if __name__ == '__main__':
    main()
