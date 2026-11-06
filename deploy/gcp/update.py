#!/usr/bin/env python3
"""Root-installed, anonymous, main + CI gated image deployment. Never runs release code."""
import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

REPO = 'yapweijun1996/Online-Shopping'
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'ghcr\.io/yapweijun1996/online-shopping-(backend|frontend|whatsapp-qr)@sha256:[0-9a-f]{64}')
MOUNTS = ('src/postgres/schema.sql', 'deploy/init-postgres.sh', 'deploy/gcp/Caddyfile')
CODEC_FILES = {'wireSha256': 'src/mcp/media-codec-wire.js', 'clientSha256': 'src/mcp/media-codec-client.js', 'lockSha256': 'media-codec/package-lock.json'}
MCP_FLAGS = ('MCP_V2_ENABLED', 'MCP_V2_MEDIA_ENABLED', 'MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED', 'MCP_V2_CATALOG_MEDIA_CREATE_ENABLED')
PROFILE = 'seller-operations-v1'
IMAGE_ID = re.compile(r'sha256:[0-9a-f]{64}')
PROTECTED = ('src/mcp/', 'media-codec/', 'src/request-origin.js', 'src/server.js', 'src/app.js', 'deploy/', '.github/workflows/', 'compose', 'Dockerfile', 'src/postgres/', 'src/platform/', 'src/config.js', 'package.json', 'package-lock.json')


def revision(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError('Invalid revision')
    return value


def atomic(path, data):
    path = Path(path)
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError('Invalid file target')
    fd, name = tempfile.mkstemp(prefix='.update-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            os.fchmod(out.fileno(), 0o600)
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def trusted(path, directory=False):
    """Every host control path must be absolute, root owned and not group/world writable."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)):
        raise ValueError('Invalid control path')
    for item in (path, *path.parents):
        stat = item.lstat()
        if item.is_symlink() or stat.st_uid != 0 or stat.st_mode & 0o022:
            raise ValueError('Unsafe control path')
    if not (path.is_dir() if directory else path.is_file()):
        raise ValueError('Invalid control type')
    return path


def request(url, limit=4_000_000):
    req = urllib.request.Request(url, headers={'User-Agent': 'online-shopping-gcp-updater', 'Accept': 'application/vnd.github+json'})
    # No redirects: source identity must remain the reviewed GitHub endpoint.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Response too large')
        return data


def api(suffix):
    return json.loads(request('https://api.github.com/repos/' + REPO + suffix))


def frontend_probe(host):
    # Node fetch can replace Host with the URL hostname; node:http preserves the
    # explicit virtual host required by Caddy. Bound the entire response lifetime.
    return ("const http=require('node:http');"
            "const deadline=setTimeout(()=>process.exit(1),4000);"
            "const req=http.get({hostname:'frontend',path:'/ready',agent:false,headers:{Host:" + json.dumps(host) + "}},res=>{"
            "if(res.statusCode!==200)process.exit(1);"
            "let body='';res.setEncoding('utf8');"
            "res.on('data',chunk=>{body+=chunk;if(body.length>16384)process.exit(1)});"
            "res.on('error',()=>process.exit(1));res.on('aborted',()=>process.exit(1));"
            "res.on('end',()=>{clearTimeout(deadline);process.stdout.write(body)});"
            "});req.on('error',()=>process.exit(1));")


def ci_passed(payload, sha):
    runs = payload.get('workflow_runs', [])
    if payload.get('total_count', 0) > 100 or not runs:
        return False
    # Reject foreign/malformed entries rather than hiding a newer failed run.
    if any(r.get('head_sha') != sha or r.get('head_branch') != 'main' or r.get('event') != 'push'
           or r.get('path') != '.github/workflows/verify.yml'
           or r.get('repository', {}).get('full_name') != REPO
           or r.get('head_repository', {}).get('full_name') != REPO
           or type(r.get('id')) is not int or type(r.get('run_attempt')) is not int for r in runs):
        return False
    latest = max(runs, key=lambda r: (r['id'], r['run_attempt']))
    return latest.get('status') == 'completed' and latest.get('conclusion') == 'success'


class Updater:
    def __init__(self, root, lock_file=None):
        self.lock_file = lock_file
        self.root = Path(root)
        self.state_path = self.root / 'state.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    def save(self, status, **fields):
        self.state.update(fields, status=status)
        atomic(self.state_path, json.dumps(self.state, sort_keys=True).encode())

    def head(self):
        return revision(api('/git/ref/heads/main')['object']['sha'])

    def approved(self, sha):
        query = urllib.parse.urlencode({'head_sha': sha, 'branch': 'main', 'event': 'push', 'per_page': 100})
        return ci_passed(api('/actions/workflows/verify.yml/runs?' + query), sha)

    def source(self, sha):
        revision(sha)
        tree = api('/git/trees/' + sha + '?recursive=1')
        if tree.get('truncated') or not tree.get('tree'):
            raise ValueError('Incomplete source tree')
        entries = {e['path']: e for e in tree['tree'] if e['type'] == 'blob'}
        protected = {p: [e['sha'], e['mode']] for p, e in entries.items() if p.startswith(PROTECTED)}
        if not all(p in entries and entries[p]['mode'] in ('100644', '100755') for p in (*MOUNTS, 'src/db.js', *CODEC_FILES.values())):
            raise ValueError('Invalid mounted source')
        content = {}
        for path in (*MOUNTS, 'src/db.js', *CODEC_FILES.values()):
            data = request('https://raw.githubusercontent.com/' + REPO + '/' + sha + '/' + path)
            blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            if blob != entries[path]['sha']:
                raise ValueError('Source digest mismatch')
            content[path] = data
        match = re.search(rb'export const SCHEMA_VERSION = (\d+);', content['src/db.js'])
        if not match:
            raise ValueError('Missing schema version')
        return {'protected': protected, 'schema': int(match[1])}, content

    def command(self, argv, timeout=180):
        # Output stays private, is never included in exceptions/logs and has a finite file cap.
        import resource
        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE, (1_048_576, 1_048_576))
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                    timeout=timeout, check=False, preexec_fn=limits,
                                    env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root'})
            if result.returncode:
                raise RuntimeError('Command failed')
            output.seek(0)
            data = output.read(1_048_577)
            if len(data) > 1_048_576:
                raise RuntimeError('Command output limit')
            return data.decode()

    def docker(self, *args, timeout=180):
        return self.command(['docker', '--config', str(self.root / 'docker-anonymous'), *args], timeout)

    def image(self, component, sha):
        if shutil.disk_usage(self.root).free < 3 * 1024 ** 3:
            raise RuntimeError('Insufficient disk reserve')
        tag = 'ghcr.io/yapweijun1996/online-shopping-' + component + ':' + revision(sha)
        self.docker('pull', '--platform', 'linux/amd64', tag, timeout=300)
        info = json.loads(self.docker('image', 'inspect', '--format', '{{json .}}', tag))
        label = (info.get('Config', {}).get('Labels') or {}).get('org.opencontainers.image.revision')
        if label != sha:
            raise ValueError('Image revision mismatch')
        expected = tag.split(':')[0] + '@'
        digests = [d for d in info.get('RepoDigests', []) if d.startswith(expected) and DIGEST.fullmatch(d)]
        if len(digests) != 1 or info.get('Architecture') != 'amd64' or info.get('Os') != 'linux':
            raise ValueError('Invalid image digest or platform')
        return digests[0]

    def release(self, sha, baseline, content):
        directory = self.root / 'releases' / revision(sha)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        for path in MOUNTS:
            destination = directory / path
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            atomic(destination, content[path])
            # Init script must be executable; configuration and schema readable by containers.
            destination.chmod(0o755 if path.endswith('.sh') else 0o644)
        release = {'sha': sha, 'baseline': baseline, 'backend': self.image('backend', sha), 'frontend': self.image('frontend', sha)}
        if self.runtime().get('WHATSAPP_QR_ENABLED') == '1':
            release['whatsapp-qr'] = self.image('whatsapp-qr', sha)
            if self.runtime().get('WHATSAPP_QR_SLOT1_ENABLED') == '1':
                release['qr_workers'] = ['whatsapp-qr', 'whatsapp-qr-slot1']
        if self.mcp_enabled():
            backend = json.loads(self.docker('image', 'inspect', '--format', '{{json .}}', release['backend']))
            backend_id = backend.get('Id', '')
            if not IMAGE_ID.fullmatch(backend_id):
                raise ValueError('Invalid backend identity')
            release['mcp'] = {'version': 1, 'profile': PROFILE, 'backendIdentity': backend_id,
                              'codec': self.codec_image(sha, content)}
        return release

    def codec_image(self, sha, content):
        if shutil.disk_usage(self.root).free < 3 * 1024 ** 3:
            raise RuntimeError('Insufficient disk reserve')
        tag = 'ghcr.io/yapweijun1996/online-shopping-backend:media-codec-' + revision(sha)
        self.docker('pull', '--platform', 'linux/amd64', tag, timeout=300)
        info = json.loads(self.docker('image', 'inspect', '--format', '{{json .}}', tag))
        labels = info.get('Config', {}).get('Labels') or {}
        digests = [d for d in info.get('RepoDigests', []) if DIGEST.fullmatch(d) and '/online-shopping-backend@' in d]
        hashes = {key: hashlib.sha256(content[path]).hexdigest() for key, path in CODEC_FILES.items()}
        if (info.get('Os') != 'linux' or info.get('Architecture') != 'amd64' or len(digests) != 1 or
                not IMAGE_ID.fullmatch(info.get('Id', '')) or
                labels.get('org.opencontainers.image.title') != 'online-shopping-media-codec' or
                labels.get('org.opencontainers.image.source') != 'https://github.com/' + REPO or
                labels.get('org.opencontainers.image.revision') != sha or
                any(labels.get('shopping.media.' + name + '.sha256') != hashes[key]
                    for name, key in [('wire', 'wireSha256'), ('client', 'clientSha256'), ('lock', 'lockSha256')])):
            raise ValueError('Invalid codec provenance')
        return dict(version=1, image=digests[0], imageId=info['Id'], revision=sha, platform='linux/amd64', **hashes)

    def mcp_enabled(self):
        return self.runtime().get('MCP_V2_PRODUCTION_PROFILE') == PROFILE

    def supervisor(self):
        # Only manually installed, root-owned policy is imported. Candidate host
        # source is never executed. The same lock covers worker and app changes.
        helper = trusted(self.root / 'media-codec.py')
        if self.lock_file is None:
            raise ValueError('MCP activation requires the shared update lock')
        spec = importlib.util.spec_from_file_location('shopping_installed_media_codec', helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.CodecSupervisor(self.root, self.lock_file)

    def epoch_control(self, rotate=False):
        directory = trusted(self.root / 'mcp-control', directory=True)
        stat = directory.stat()
        if stat.st_gid != 1000 or stat.st_mode & 0o777 != 0o710:
            raise ValueError('Invalid epoch directory permissions')
        path = trusted(directory / 'epoch')
        stat = path.stat()
        if stat.st_gid != 1000 or stat.st_mode & 0o777 != 0o440 or not 43 <= stat.st_size <= 44:
            raise ValueError('Invalid epoch file permissions')
        value = path.read_bytes().removesuffix(b'\n')
        if (not re.fullmatch(rb'[A-Za-z0-9_-]{43}', value) or
                base64.urlsafe_b64encode(base64.urlsafe_b64decode(value + b'=')).rstrip(b'=') != value):
            raise ValueError('Invalid epoch encoding')
        if rotate:
            fd, temporary = tempfile.mkstemp(prefix='.epoch-', dir=directory)
            try:
                with os.fdopen(fd, 'wb') as output:
                    os.fchown(output.fileno(), 0, 1000)
                    os.fchmod(output.fileno(), 0o440)
                    output.write(base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=') + b'\n')
                    output.flush(); os.fsync(output.fileno())
                os.replace(temporary, path)
                fd = os.open(directory, os.O_RDONLY)
                try: os.fsync(fd)
                finally: os.close(fd)
            finally:
                if os.path.exists(temporary): os.unlink(temporary)
        return directory

    def compose(self, release):
        args = ['compose', '--project-name', 'online-shopping-gcp', '--env-file', str(self.root / 'runtime.env'),
                '--env-file', str(self.root / 'images.env'), '-f', str(self.root / 'compose.yaml')]
        if 'mcp' in release:
            args += ['-f', str(trusted(self.root / 'compose.mcp.yaml'))]
        return args + ['--profile', 'whatsapp-qr', '--profile', 'whatsapp-qr-slot1']

    def pause(self):
        directory = trusted(self.root / 'mcp-codec', directory=True)
        atomic(directory / 'paused', b'paused\n')

    def paused(self):
        path = self.root / 'mcp-codec/paused'
        if not path.exists() and not path.is_symlink(): return False
        trusted(path)
        if path.read_bytes() != b'paused\n': raise ValueError('Invalid pause barrier')
        return True

    def unpause(self):
        if self.paused():
            (self.root / 'mcp-codec/paused').unlink()
        self._mcp_inflight = None

    def stop_clients(self, compose):
        # Stopping frontend closes application ingress first. Compose stop waits
        # for existing requests/native work to drain, then kills on the deadline.
        # The shared external gateway and PostgreSQL are deliberately untouched.
        self.docker(*compose, 'stop', '--timeout', '35', 'frontend')
        self.docker(*compose, 'stop', '--timeout', '35', 'backend')
        for service in ('frontend', 'backend'):
            active = self.docker('ps', '-q', '--filter', 'label=com.docker.compose.project=online-shopping-gcp',
                                 '--filter', 'label=com.docker.compose.service=' + service).strip()
            if active: raise ValueError('Application writers remain active')

    def preflight_mcp(self, release):
        profile = release['mcp']
        if not self.mcp_enabled(): raise ValueError('MCP release requires the full runtime profile')
        trusted(self.root / 'compose.mcp.yaml')
        self.epoch_control()
        info = json.loads(self.docker('image', 'inspect', '--format', '{{json .}}', release['backend']))
        labels = info.get('Config', {}).get('Labels') or {}
        if (info.get('Id') != profile['backendIdentity'] or info.get('Os') != 'linux' or info.get('Architecture') != 'amd64' or
                release['backend'] not in info.get('RepoDigests', []) or
                labels.get('org.opencontainers.image.revision') != release['sha'] or
                labels.get('org.opencontainers.image.source') != 'https://github.com/' + REPO):
            raise ValueError('Backend artifact mapping changed')
        supervisor = self.supervisor()
        supervisor.preflight(profile['codec'], reserve_generations=1 if getattr(self, '_rollback', False) else 2)
        return supervisor

    def restore(self, release):
        # An old binary never inherits the ON overlay. Rotating before restoring
        # fences outstanding v2 authority; committed receipt replay stays scoped.
        if 'mcp' not in release and ((self.state.get('current') or {}).get('mcp') or
                (self.state.get('pending') or {}).get('mcp') or getattr(self, '_mcp_inflight', None)):
            # Durable quarantine: a restarted poller cannot re-enable the ON
            # runtime after an initial disabled-image compatibility fallback.
            self.save('disabled_profile_fallback', profile_fallback=True)
        self._rollback = True
        try: self.activate(release)
        finally: self._rollback = False

    def recover_codec(self):
        if self.state.get('profile_fallback'):
            self.save('manual_profile_resume_required'); return
        if self.paused():
            self.save('codec_paused'); return
        current = self.state.get('current')
        if not current or 'mcp' not in current: return
        if self.local_fingerprint() != self.state['local']:
            self.save('manual_config_required'); return
        self.validate_release(current)
        supervisor = self.supervisor()
        if supervisor.status().get('ready') is True: return
        now = int(time.time())
        attempts = self.state.get('codec_recoveries', [])
        if (not isinstance(attempts, list) or len(attempts) > 3 or
                any(type(value) is not int or value < 0 or value > now for value in attempts)):
            raise ValueError('Invalid codec recovery budget')
        attempts = [value for value in attempts if value > now - 900]
        if len(attempts) >= 3:
            self.save('codec_manual_maintenance_required'); return
        self.preflight_mcp(current)
        self.save('codec_recovering', pending=current, pending_kind='codec-recovery', codec_recoveries=attempts + [now])
        # Same accepted build, same epoch, fresh sealed generation. No old socket
        # directory is ever reused and no incompatible image rollback is attempted.
        self.activate(current)
        self.health(current)
        self.unpause()
        self.save('codec_recovered', pending=None, pending_kind=None)

    def activate(self, release, initial=False):
        self.validate_release(release)
        # Match the fixed Compose backend mounts even when QR/manifest mode is off.
        # Rollback and recovery enter here too: refuse before touching containers.
        secrets = ('admin-password', 'postgres-password', 'integration-keys',
                   'platform-password', 'provisioner-password', 'whatsapp-qr-token',
                   'whatsapp-qr-token-slot1', 'whatsapp-qr-bindings.json', 'ai-api-key')
        if initial:
            secrets += ('postgres-owner-password',)
        directory = Path(self.runtime()['SECRETS_DIR'])
        for name in secrets:
            path = directory / name
            if not path.is_file() or path.stat().st_size == 0:
                raise ValueError('Required compose secret must be a regular non-empty file: ' + str(path))
        supervisor = None
        media = release.get('mcp')
        previous_media = ((self.state.get('current') or {}).get('mcp') or
                          (self.state.get('pending') or {}).get('mcp') or getattr(self, '_mcp_inflight', None))
        if media:
            supervisor = self.preflight_mcp(release)
        elif previous_media:
            # Explicit disabled-profile fallback still retires only the owned
            # worker and invalidates pending v2 authority.
            supervisor = self.supervisor()
            self.epoch_control()
        compose = self.compose(release)
        generation = None
        if supervisor:
            if media: self._mcp_inflight = media
            self.pause()
            self.stop_clients(compose)
            if getattr(self, '_rollback', False): self.epoch_control(rotate=True)
            if supervisor.status().get('status') != 'absent': supervisor.stop(drained=True)
            if media:
                generation = supervisor.prepare(media['codec'])
                checked = supervisor.probe()
                if generation != checked or checked.get('ready') is not True:
                    raise ValueError('Codec generation readiness changed')
                expected = str(self.root / 'mcp-codec/generations' / checked.get('generation', ''))
                if (not re.fullmatch(r'g-[0-9a-f]{32}', checked.get('generation', '')) or
                        checked.get('generationPath') != expected or checked.get('imageId') != media['codec']['imageId'] or
                        checked.get('image') != media['codec']['image'] or checked.get('revision') != release['sha']):
                    raise ValueError('Codec generation mapping changed')
        worker = release.get('whatsapp-qr')
        env = ('BACKEND_IMAGE=' + release['backend'] + '\nFRONTEND_IMAGE=' + release['frontend']
               + ('\nWHATSAPP_QR_IMAGE=' + worker if worker else '')
               + '\nAPP_REVISION=' + release['sha'] + '\nRELEASE_DIR=' + str(self.root / 'releases' / release['sha']) + '\n')
        if not media and self.state.get('profile_fallback'):
            env += 'MCP_ENABLED=0\n'
        if media:
            env += ('MCP_BACKEND_IDENTITY=' + media['backendIdentity'] + '\nMCP_CODEC_IDENTITY=' + media['codec']['imageId'] +
                    '\nMCP_GENERATION_PATH=' + generation['generationPath'] + '\nMCP_CONTROL_PATH=' + str(self.root / 'mcp-control') + '\n')
        atomic(self.root / 'images.env', env.encode())
        # Stop every old binding before backend mounts or credentials can change.
        # The same barrier applies to rollback and interrupted-release recovery.
        self.docker(*compose, 'rm', '--stop', '--force', 'whatsapp-qr', 'whatsapp-qr-slot1')
        args = compose + ['up', '-d', '--no-build']
        if supervisor: args += ['--force-recreate']
        if not initial:
            args += ['--no-deps', 'backend', 'frontend'] + self.qr_workers(release)
        else:
            args += ['backend', 'frontend', 'postgres'] + self.qr_workers(release)
        if supervisor:
            # Backend config and cheap authenticated codec health must be ready
            # before the dedicated frontend can accept external traffic again.
            backend_args = [value for value in args if value != 'frontend']
            self.docker(*backend_args)
            self.wait_backend(release)
            self.docker(*compose, 'up', '-d', '--no-build', '--no-deps', '--force-recreate', 'frontend')
        else:
            self.docker(*args)

    def backend_probe(self, release):
        body = json.loads(self.docker('exec', 'online-shopping-gcp-backend-1', 'node', '-e',
            "fetch('http://127.0.0.1:3000/ready',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))", timeout=10))
        if body.get('status') != 'ready' or body.get('revision') != release['sha']:
            raise ValueError('Revision mismatch')

    def verify_mcp_backend(self, release):
        if 'mcp' in release:
            backend = json.loads(self.docker('inspect', '--format', '{{json .}}', 'online-shopping-gcp-backend-1'))
            if backend.get('Image') != release['mcp']['backendIdentity']:
                raise ValueError('Running backend identity mismatch')
            codec = self.supervisor().probe()
            if codec.get('imageId') != release['mcp']['codec']['imageId'] or codec.get('revision') != release['sha']:
                raise ValueError('Running codec identity mismatch')
            mounts = {item['Destination']: item for item in backend.get('Mounts', [])}
            for target, source in [('/run/mcp-codec', codec.get('generationPath')), ('/run/mcp-control', str(self.root / 'mcp-control'))]:
                item = mounts.get(target, {})
                if item.get('Type') != 'bind' or item.get('RW') is not False or item.get('Source') != source:
                    raise ValueError('Running MCP mount mismatch')

    def wait_backend(self, release):
        for attempt in range(18):
            try:
                self.verify_mcp_backend(release)
                self.backend_probe(release); return
            except (RuntimeError, ValueError, subprocess.TimeoutExpired):
                if attempt == 17: raise RuntimeError('Backend readiness validation failed') from None
                time.sleep(5)

    def validate_release(self, release):
        revision(release['sha'])
        for component in ('backend', 'frontend') + (('whatsapp-qr',) if 'whatsapp-qr' in release else ()):
            image = release[component]
            if not DIGEST.fullmatch(image) or '/online-shopping-' + component + '@' not in image:
                raise ValueError('Invalid state image')

        profile = release.get('mcp')
        if 'mcp' in release:
            if (not isinstance(profile, dict) or set(profile) != {'version', 'profile', 'backendIdentity', 'codec'} or
                    profile['version'] != 1 or profile['profile'] != PROFILE or not IMAGE_ID.fullmatch(profile['backendIdentity'])):
                raise ValueError('Invalid MCP release profile')
            codec = profile['codec']
            if (not isinstance(codec, dict) or set(codec) != {'version', 'image', 'imageId', 'revision', 'platform', *CODEC_FILES} or
                    codec['version'] != 1 or codec['revision'] != release['sha'] or codec['platform'] != 'linux/amd64' or
                    not DIGEST.fullmatch(codec['image']) or '/online-shopping-backend@' not in codec['image'] or
                    codec['image'] == release['backend'] or not IMAGE_ID.fullmatch(codec['imageId']) or
                    any(not re.fullmatch(r'[0-9a-f]{64}', codec[key]) for key in CODEC_FILES)):
                raise ValueError('Invalid MCP codec manifest')
        workers = self.qr_workers(release)
        if workers not in ([], ['whatsapp-qr'], ['whatsapp-qr', 'whatsapp-qr-slot1']):
            raise ValueError('Invalid worker slots')
        if bool(workers) != ('whatsapp-qr' in release):
            raise ValueError('Missing worker image')

    def qr_workers(self, release):
        return release.get('qr_workers', ['whatsapp-qr'] if 'whatsapp-qr' in release else [])

    def health(self, release):
        # Backend readiness includes its DB schema check; also prove the running frontend revision.
        for _ in range(18):
            try:
                for component in ['backend', 'frontend'] + self.qr_workers(release):
                    name = 'online-shopping-gcp-' + component + '-1'
                    running = json.loads(self.docker('inspect', '--format', '{{json .State}}', name))
                    image = self.docker('inspect', '--format', '{{.Config.Image}}', name).strip()
                    expected = release['whatsapp-qr'] if component.startswith('whatsapp-qr') else release[component]
                    if not running.get('Running') or image != expected:
                        raise ValueError('Container mismatch')
                self.verify_mcp_backend(release)
                self.backend_probe(release)
                host = self.runtime()['SHOP_HOST']
                probe = frontend_probe(host)
                proxied = json.loads(self.docker('exec', 'online-shopping-gcp-backend-1', 'node', '-e', probe, timeout=10))
                if proxied.get('status') == 'ready' and proxied.get('revision') == release['sha']:
                    return
            except (RuntimeError, ValueError, subprocess.TimeoutExpired):
                pass
            time.sleep(5)
        raise RuntimeError('Readiness validation failed')

    def runtime(self):
        values = {}
        for line in (self.root / 'runtime.env').read_text().splitlines():
            if not line or line.startswith('#'):
                continue
            key, separator, value = line.partition('=')
            if not separator or key in values or key not in ('SHOP_HOST', 'SELLER_HOST', 'ADMIN_USERNAME', 'SECRETS_DIR', 'PLATFORM_ENABLED', 'PLATFORM_ADMIN_CLAIM_ENABLED', 'INTEGRATION_KEY_FILE', 'MCP_ENABLED', 'MCP_REDIRECT_URIS', 'AI_ENABLED', 'AI_MODEL', 'WHATSAPP_QR_ENABLED', 'WHATSAPP_QR_SLOT1_ENABLED', 'WHATSAPP_QR_BINDINGS_FILE', *MCP_FLAGS, 'MCP_V2_PRODUCTION_PROFILE'):
                raise ValueError('Invalid runtime configuration')
            values[key] = value
        if not {'SHOP_HOST', 'SELLER_HOST', 'ADMIN_USERNAME', 'SECRETS_DIR'} <= set(values):
            raise ValueError('Missing runtime configuration')
        for key in ('SHOP_HOST', 'SELLER_HOST'):
            if not re.fullmatch(r'(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}', values[key]):
                raise ValueError('Invalid hostname')
        if values['SHOP_HOST'] == values['SELLER_HOST'] or not re.fullmatch(r'[A-Za-z0-9_.-]{3,64}', values['ADMIN_USERNAME']):
            raise ValueError('Invalid origin or administrator')
        secret_dir = values['SECRETS_DIR']
        if not re.fullmatch(r'/[A-Za-z0-9_./-]+', secret_dir) or '..' in Path(secret_dir).parts:
            raise ValueError('Invalid secrets directory')
        for key in ('PLATFORM_ENABLED', 'PLATFORM_ADMIN_CLAIM_ENABLED'):
            if values.get(key, '0') not in ('0', '1'):
                raise ValueError('Invalid platform switch')
        if values.get('INTEGRATION_KEY_FILE', '') not in ('', '/run/secrets/integration_keys'):
            raise ValueError('Invalid integration key path')
        if values.get('PLATFORM_ENABLED') == '1' and (values.get('PLATFORM_ADMIN_CLAIM_ENABLED') != '1' or not values.get('INTEGRATION_KEY_FILE')):
            raise ValueError('Platform requires claim mode and integration key')
        if values.get('MCP_ENABLED', '0') not in ('0', '1'):
            raise ValueError('Invalid MCP switch')
        redirects = values.get('MCP_REDIRECT_URIS', '')
        if redirects and not all(re.fullmatch(r'https://[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}(?:/[A-Za-z0-9._~/-]*)?', uri) for uri in redirects.split(',')):
            raise ValueError('Invalid MCP redirect URIs')
        if values.get('MCP_ENABLED') == '1' and not redirects:
            raise ValueError('MCP requires redirect URIs')
        if any(values.get(key, '0') not in ('0', '1') for key in ('WHATSAPP_QR_ENABLED', 'WHATSAPP_QR_SLOT1_ENABLED')):
            raise ValueError('Invalid WhatsApp QR switch')
        if values.get('WHATSAPP_QR_SLOT1_ENABLED') == '1' and (values.get('WHATSAPP_QR_ENABLED') != '1' or values.get('PLATFORM_ENABLED') != '1'):
            raise ValueError('Slot 1 requires slot 0 and platform')
        if values.get('WHATSAPP_QR_BINDINGS_FILE', '') not in ('', '/run/secrets/whatsapp_qr_bindings'):
            raise ValueError('Invalid QR bindings path')
        if values.get('WHATSAPP_QR_SLOT1_ENABLED') == '1' and not values.get('WHATSAPP_QR_BINDINGS_FILE'):
            raise ValueError('Slot 1 requires the bindings manifest')
        if values.get('WHATSAPP_QR_ENABLED') == '1' and not values.get('INTEGRATION_KEY_FILE'):
            raise ValueError('WhatsApp QR requires the integration key')
        # AI assistant: the key file always exists (placeholder while off); switching it on needs a real key and valid model id.
        if values.get('AI_ENABLED', '0') not in ('0', '1'):
            raise ValueError('Invalid AI switch')
        if not re.fullmatch(r'[a-z0-9.-]{3,64}', values.get('AI_MODEL', 'claude-haiku-5-5')):
            raise ValueError('Invalid AI model')
        if values.get('AI_ENABLED') == '1':
            key = Path(secret_dir) / 'ai-api-key'
            if not key.is_file() or not 20 <= key.stat().st_size <= 400:
                raise ValueError('AI requires a real API key file')
        if any(values.get(key, '0') not in ('0', '1') for key in MCP_FLAGS):
            raise ValueError('Invalid MCP v2 switch')
        requested = values.get('MCP_V2_PRODUCTION_PROFILE')
        if requested is not None and requested != PROFILE:
            raise ValueError('Invalid MCP production profile')
        if requested is not None or any(values.get(key, '0') == '1' for key in MCP_FLAGS):
            if requested != PROFILE or values.get('MCP_ENABLED') != '1' or any(values.get(key) != '1' for key in MCP_FLAGS):
                raise ValueError('Incomplete MCP production profile')
        return values

    def local_fingerprint(self):
        names = ['compose.yaml', 'runtime.env', 'update.py']
        if self.mcp_enabled(): names += ['compose.mcp.yaml', 'media-codec.py', 'mcp-maintenance.py']
        return {name: hashlib.sha256(trusted(self.root / name).read_bytes()).hexdigest() for name in names}

    def initialize(self, sha):
        if self.state:
            raise ValueError('Already initialized')
        if self.head() != revision(sha) or not self.approved(sha):
            raise ValueError('Initial release is not trusted main')
        self.runtime()
        baseline, content = self.source(sha)
        candidate = self.release(sha, baseline, content)
        if self.head() != sha or not self.approved(sha):
            raise ValueError('Trust changed')
        self.activate(candidate, initial=True)
        self.health(candidate)
        self.unpause()
        self.save('initialized', current=candidate, previous=None, pending=None, local=self.local_fingerprint())

    def poll(self):
        if not self.state.get('current'):
            raise ValueError('Explicit initialization required')
        if self.local_fingerprint() != self.state['local']:
            self.save('manual_config_required')
            return
        if self.state.get('profile_fallback'):
            self.save('manual_profile_resume_required'); return
        previous = self.state['current']
        self.validate_release(previous)
        if self.state.get('pending') and self.state.get('pending_kind') == 'codec-recovery':
            self.save('codec_manual_maintenance_required'); return
        if self.state.get('pending'):
            failed = self.state['pending']['sha']
            self.restore(previous)
            self.health(previous)
            self.unpause()
            self.save('recovered', pending=None, failed_sha=failed)
        if self.state.get('profile_fallback'):
            self.save('manual_profile_resume_required'); return
        if self.paused():
            self.save('codec_paused'); return
        sha = self.head()
        if sha == previous['sha'] or sha == self.state.get('failed_sha'):
            return
        if not self.approved(sha):
            self.save('waiting_for_ci')
            return
        baseline, content = self.source(sha)
        if baseline != previous['baseline']:
            self.save('manual_release_required')
            return
        candidate = self.release(sha, baseline, content)
        if self.head() != sha or not self.approved(sha):
            self.save('trust_changed')
            return
        if 'mcp' in candidate:
            try: self.preflight_mcp(candidate)
            except Exception as error:
                if error.args == ('MANUAL_MAINTENANCE_REQUIRED',):
                    self.save('manual_maintenance_required'); return
                raise
        self.save('deploying', pending=candidate)
        try:
            self.activate(candidate)
            self.health(candidate)
        except Exception:
            self.save('rolling_back', failed_sha=sha)
            self.restore(previous)
            self.health(previous)
            self.unpause()
            self.save('rolled_back', pending=None)
            raise RuntimeError('Application update rolled back') from None
        self.unpause()
        self.save('deployed', current=candidate, previous=previous, pending=None, failed_sha=None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='/opt/online-shopping-gcp')
    parser.add_argument('action', choices=('initialize', 'run', 'recover-codec'))
    parser.add_argument('--sha')
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise ValueError('Root required')
        os.umask(0o077)
        root = trusted(args.root, directory=True)
        for name in ('compose.yaml', 'runtime.env'):
            trusted(root / name)
        for name in ('state.json', 'images.env', 'update.lock'):
            if (root / name).exists() or (root / name).is_symlink():
                trusted(root / name)
        (root / 'docker-anonymous').mkdir(mode=0o700, exist_ok=True)
        trusted(root / 'docker-anonymous', directory=True)
        atomic(root / 'docker-anonymous/config.json', b'{}')
        with open(root / 'update.lock', 'a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            updater = Updater(root, lock)
            if args.action == 'initialize':
                updater.initialize(revision(args.sha))
            elif args.action == 'recover-codec':
                updater.recover_codec()
            else:
                updater.poll()
        print('GCP updater:', updater.state.get('status', 'unchanged'))
    except Exception as error:
        # Never emit command output, URLs, config, secrets or external exception text.
        print('GCP updater failed:', type(error).__name__, file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
