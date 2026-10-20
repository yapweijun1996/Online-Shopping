#!/usr/bin/env python3
"""Root-installed, anonymous, main + CI gated image deployment. Never runs release code."""
import argparse
import fcntl
import hashlib
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
DIGEST = re.compile(r'ghcr\.io/yapweijun1996/online-shopping-(backend|frontend)@sha256:[0-9a-f]{64}')
MOUNTS = ('src/postgres/schema.sql', 'deploy/init-postgres.sh', 'deploy/gcp/Caddyfile')
PROTECTED = ('deploy/', '.github/workflows/', 'compose', 'Dockerfile', 'src/postgres/', 'src/config.js', 'package.json', 'package-lock.json')


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
    def __init__(self, root):
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
        if not all(p in entries and entries[p]['mode'] in ('100644', '100755') for p in (*MOUNTS, 'src/db.js')):
            raise ValueError('Invalid mounted source')
        content = {}
        for path in (*MOUNTS, 'src/db.js'):
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
        return {'sha': sha, 'baseline': baseline, 'backend': self.image('backend', sha), 'frontend': self.image('frontend', sha)}

    def activate(self, release, initial=False):
        self.validate_release(release)
        env = ('BACKEND_IMAGE=' + release['backend'] + '\nFRONTEND_IMAGE=' + release['frontend']
               + '\nAPP_REVISION=' + release['sha'] + '\nRELEASE_DIR=' + str(self.root / 'releases' / release['sha']) + '\n')
        atomic(self.root / 'images.env', env.encode())
        args = ['compose', '--project-name', 'online-shopping-gcp', '--env-file', str(self.root / 'runtime.env'),
                '--env-file', str(self.root / 'images.env'), '-f', str(self.root / 'compose.yaml'), 'up', '-d', '--no-build']
        if not initial:
            args += ['--no-deps', 'backend', 'frontend']
        self.docker(*args)

    def validate_release(self, release):
        revision(release['sha'])
        for component in ('backend', 'frontend'):
            image = release[component]
            if not DIGEST.fullmatch(image) or '/online-shopping-' + component + '@' not in image:
                raise ValueError('Invalid state image')

    def health(self, release):
        # Backend readiness includes its DB schema check; also prove the running frontend revision.
        for _ in range(18):
            try:
                for component in ('backend', 'frontend'):
                    name = 'online-shopping-gcp-' + component + '-1'
                    running = json.loads(self.docker('inspect', '--format', '{{json .State}}', name))
                    image = self.docker('inspect', '--format', '{{.Config.Image}}', name).strip()
                    if not running.get('Running') or image != release[component]:
                        raise ValueError('Container mismatch')
                body = json.loads(self.docker('exec', 'online-shopping-gcp-backend-1', 'node', '-e',
                    "fetch('http://127.0.0.1:3000/ready',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))", timeout=10))
                if body.get('status') != 'ready' or body.get('revision') != release['sha']:
                    raise ValueError('Revision mismatch')
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
            if not separator or key in values or key not in ('SHOP_HOST', 'SELLER_HOST', 'ADMIN_USERNAME', 'SECRETS_DIR'):
                raise ValueError('Invalid runtime configuration')
            values[key] = value
        if set(values) != {'SHOP_HOST', 'SELLER_HOST', 'ADMIN_USERNAME', 'SECRETS_DIR'}:
            raise ValueError('Missing runtime configuration')
        for key in ('SHOP_HOST', 'SELLER_HOST'):
            if not re.fullmatch(r'(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}', values[key]):
                raise ValueError('Invalid hostname')
        if values['SHOP_HOST'] == values['SELLER_HOST'] or not re.fullmatch(r'[A-Za-z0-9_.-]{3,64}', values['ADMIN_USERNAME']):
            raise ValueError('Invalid origin or administrator')
        secret_dir = values['SECRETS_DIR']
        if not re.fullmatch(r'/[A-Za-z0-9_./-]+', secret_dir) or '..' in Path(secret_dir).parts:
            raise ValueError('Invalid secrets directory')
        return values

    def local_fingerprint(self):
        return {name: hashlib.sha256((self.root / name).read_bytes()).hexdigest() for name in ('compose.yaml', 'runtime.env')}

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
        self.save('initialized', current=candidate, previous=None, pending=None, local=self.local_fingerprint())

    def poll(self):
        if not self.state.get('current'):
            raise ValueError('Explicit initialization required')
        if self.local_fingerprint() != self.state['local']:
            self.save('manual_config_required')
            return
        previous = self.state['current']
        self.validate_release(previous)
        if self.state.get('pending'):
            failed = self.state['pending']['sha']
            self.activate(previous)
            self.health(previous)
            self.save('recovered', pending=None, failed_sha=failed)
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
        self.save('deploying', pending=candidate)
        try:
            self.activate(candidate)
            self.health(candidate)
        except Exception:
            self.save('rolling_back', failed_sha=sha)
            self.activate(previous)
            self.health(previous)
            self.save('rolled_back', pending=None)
            raise RuntimeError('Application update rolled back') from None
        self.save('deployed', current=candidate, previous=previous, pending=None, failed_sha=None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='/opt/online-shopping-gcp')
    parser.add_argument('action', choices=('initialize', 'run'))
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
            updater = Updater(root)
            if args.action == 'initialize':
                updater.initialize(revision(args.sha))
            else:
                updater.poll()
        print('GCP updater:', updater.state.get('status', 'unchanged'))
    except Exception as error:
        # Never emit command output, URLs, config, secrets or external exception text.
        print('GCP updater failed:', type(error).__name__, file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
