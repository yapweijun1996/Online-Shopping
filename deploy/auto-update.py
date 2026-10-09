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
        self.run([sys.executable, str(Path(item['release']) / 'deploy/backup-postgres.py'),
                  '--env-file', str(self.root / 'runtime.env')], timeout=180)

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

    def migrate(self, candidate):
        """Upgrade the database schema as its owner before traffic moves. Returns True when it ran.

        The upgrade is one transaction and runs after a verified backup; failure leaves the schema as it was.
        """
        before, after = schema_version(self.state['current']['release']), schema_version(candidate['release'])
        if after == before:
            return False
        if after < before:
            raise RuntimeError('Schema downgrades are never automatic.')
        runtime = dict(line.split('=', 1) for line in (self.root / 'runtime.env').read_text().splitlines() if '=' in line)
        owner = runtime['DATABASE_OWNER_PASSWORD_FILE_HOST']
        script = Path(candidate['release']) / 'scripts/upgrade-database.mjs'
        output = self.run(['docker', '--context', 'orbstack', 'run', '--rm', '--network', PROJECT + '_private',
                           '-v', owner + ':/run/secrets/owner:ro', '-v', str(script) + ':/app/scripts/upgrade-database.mjs:ro',
                           '--entrypoint', 'node', 'online-shopping-backend:' + candidate['sha'],
                           '/app/scripts/upgrade-database.mjs'], capture=True, timeout=300)
        if json.loads(output.strip().splitlines()[-1]).get('version') != after:
            raise RuntimeError('Database schema is not at the expected version after the upgrade.')
        return True

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
        self.backup()
        # A newer push during build/backup supersedes this candidate before traffic changes.
        if self.remote_head() != candidate['sha'] or not self.approved(candidate['sha']):
            self.save('superseded', sha=candidate['sha'])
            return
        previous = self.state['current']
        try:
            migrated = self.migrate(candidate)
        except Exception:
            self.save('migration_failed', failed_sha=candidate['sha'])
            raise
        self.save('deploying', pending=candidate, migrated=migrated)
        try:
            self.activate(candidate)
            self.health(candidate)
        except Exception:
            try:
                self.activate(previous)
                self.health(previous)
            except Exception:
                self.save('rollback_failed', failed_sha=candidate['sha'])
                raise RuntimeError('Automatic rollback failed; operator intervention is required.') from None
            self.save('rolled_back', failed_sha=candidate['sha'], pending=None)
            raise RuntimeError('Release failed validation; previous application images restored.') from None
        self.state.update(current=candidate, previous=previous, pending=None, failed_sha=None)
        self.save('deployed', sha=candidate['sha'])

    def recover(self):
        if self.state.get('pending'):
            # Interrupted cutover has no success evidence. Restore the recorded current release.
            self.activate(self.state['current'])
            self.health(self.state['current'])
            self.save('recovered', failed_sha=self.state['pending']['sha'], pending=None)

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
            if updater.state.get('last_status') not in ['rolled_back', 'rollback_failed', 'build_failed']:
                updater.save('check_failed')
            raise SystemExit(1)


if __name__ == '__main__':
    main()
