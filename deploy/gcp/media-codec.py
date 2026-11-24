#!/usr/bin/env python3
"""Trusted root codec generation supervisor. No backend/Docker or epoch authority.

CLI acquires root/update.lock nonblocking. Library callers pass the SAME held
lock_file to CodecSupervisor; no nested CLI while holding a different lock FD.
replace/stop require caller-proven drain and the root-owned paused marker. They
never rebuild backend containers; the authorized controller owns that phase.

preflight(manifest, reserve_generations=2) must run before the controller stops
ingress/backend: it verifies the local immutable artifact and reserves capacity
for forward and rollback generations. Under update.lock it can reclaim old,
unreferenced generations after proving no Docker container references them.
It keeps the newest eight, release/codec state pins, and at least 24 hours of
history. A pause marker alone never authorizes deletion. If capacity is still
insufficient, fail closed with MANUAL_MAINTENANCE_REQUIRED. No generation is
unsealed or reused, including during rollback.

Install this reviewed file at a root-owned non-release path; controllers import
CodecSupervisor and validate_manifest there, pinning its local SHA256. Public
backend.json contains identity/paths only, never the token. Bind generationPath
read-only at /run/mcp-codec; set socketPath=/run/mcp-codec/socket/codec.sock and
tokenFile=/run/mcp-codec/token. codecDigest is the bare config-ID hex, NOT the
registry manifest digest. A replacement requires rebuilding all backend runtimes.
"""
import argparse
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import secrets
import socket
import stat
import subprocess
import sys
import tempfile
import time

IMAGE = re.compile(r'ghcr\.io/yapweijun1996/online-shopping-backend@sha256:[0-9a-f]{64}\Z')
IMAGE_ID = re.compile(r'sha256:[0-9a-f]{64}\Z')
HEX = re.compile(r'[0-9a-f]{64}\Z')
REVISION = re.compile(r'[0-9a-f]{40}\Z')
GENERATION = re.compile(r'g-[0-9a-f]{32}\Z')
GENERATION_LIMIT = 64
GENERATION_KEEP = 8
GENERATION_MIN_AGE_NS = 24 * 60 * 60 * 10**9
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
LABEL = 'shopping.mcp-codec.owner'
GENERATION_LABEL = 'shopping.mcp-codec.generation'
READY = b'{"version":1,"status":"ready","codec":"sharp/0.35.5/policy-1"}'
MEMORY = 192 * 1024 * 1024
FILE_HASH_PROGRAM = "import fs from 'node:fs';import{createHash}from'node:crypto';const h=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');console.log(JSON.stringify({wireSha256:h('/src/mcp/media-codec-wire.js'),clientSha256:h('/src/mcp/media-codec-client.js'),lockSha256:h('/codec/package-lock.json')}));"
MANIFEST_KEYS = {'version', 'image', 'imageId', 'revision', 'platform', 'wireSha256', 'clientSha256', 'lockSha256'}

class CodecFailure(Exception):
    pass

def check(ok, code):
    if not ok:
        raise CodecFailure(code)

def validate_manifest(value, test_mode=False):
    """Pure reusable validation. RepoDigest and config ID are distinct namespaces."""
    check(type(value) is dict and set(value) == MANIFEST_KEYS and type(value['version']) is int and value['version'] == 1, 'MANIFEST')
    check(isinstance(value['imageId'], str) and IMAGE_ID.fullmatch(value['imageId']), 'MANIFEST_IMAGE_ID')
    check(isinstance(value['revision'], str) and REVISION.fullmatch(value['revision']), 'MANIFEST_REVISION')
    check(all(isinstance(value[key], str) and HEX.fullmatch(value[key]) for key in ['wireSha256', 'clientSha256', 'lockSha256']), 'MANIFEST_HASH')
    if test_mode:
        check(value['image'] == value['imageId'] and value['platform'] in ['linux/arm64', 'linux/amd64'], 'TEST_IMAGE')
    else:
        check(isinstance(value['image'], str) and IMAGE.fullmatch(value['image']) and value['platform'] == 'linux/amd64', 'MANIFEST_ARTIFACT')
    return dict(value)

def trusted(path, directory=False):
    path = Path(path)
    check(path.is_absolute() and re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)) and '..' not in path.parts, 'PATH')
    for item in (path, *path.parents):
        info = item.lstat()
        check(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'PATH_OWNER')
    check(path.is_dir() if directory else path.is_file(), 'PATH_TYPE')
    return path

def atomic(path, value):
    check(not path.is_symlink() and (not path.exists() or path.is_file()), 'STATE_PATH')
    fd, temporary = tempfile.mkstemp(prefix='.codec-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(value, output, sort_keys=True, separators=(',', ':')); output.write('\n')
            output.flush(); os.fsync(output.fileno())
        os.replace(temporary, path)
        folder = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(folder)
        finally: os.close(folder)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def read_private(path):
    trusted(path)
    info = path.lstat()
    check(stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and info.st_size <= 16384, 'PRIVATE_FILE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        check((opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino), 'PRIVATE_INODE')
        with os.fdopen(fd, 'r', closefd=False) as source: return json.load(source)
    finally: os.close(fd)


def inode(info):
    return info.st_dev, info.st_ino


def generation_age_stamp(info):
    # Either recent writes to the directory or a recent metadata change keep it.
    return max(info.st_mtime_ns, info.st_ctime_ns)


def mount_id(fd):
    # st_dev alone does not detect same-filesystem bind mounts on Linux.
    if sys.platform != 'linux':
        return os.fstat(fd).st_dev
    with open('/proc/self/fdinfo/' + str(fd)) as info:
        for line in info:
            if line.startswith('mnt_id:'):
                return int(line.split()[1])
    raise CodecFailure('CODEC_REAP_UNSAFE_GENERATION')


@contextmanager
def reap_directory(parent_fd, name, expected):
    fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    try:
        check(inode(os.fstat(fd)) == inode(expected) and mount_id(fd) == mount_id(parent_fd),
              'CODEC_REAP_UNSAFE_GENERATION')
        yield fd
    finally:
        os.close(fd)


def reap_entries(fd, allowed):
    found = {}
    with os.scandir(fd) as entries:
        for entry in entries:
            check(entry.name in allowed, 'CODEC_REAP_UNSAFE_GENERATION')
            found[entry.name] = os.lstat(entry.name, dir_fd=fd)
    return found


def remove_generation(root_fd, name, expected):
    # Only the supervisor's fixed layout (or a partial one after a crash) is
    # deletable. Validate it before any unlink, and never open the token/socket.
    check(GENERATION.fullmatch(name), 'CODEC_REAP_UNSAFE_GENERATION')
    current = os.lstat(name, dir_fd=root_fd)
    check(stat.S_ISDIR(current.st_mode) and inode(current) == inode(expected) and
          generation_age_stamp(current) == generation_age_stamp(expected), 'CODEC_REAP_UNSAFE_GENERATION')
    with reap_directory(root_fd, name, current) as folder:
        entries = reap_entries(folder, {'socket', 'token'})
        token = entries.get('token')
        check(token is None or (stat.S_ISREG(token.st_mode) and token.st_nlink == 1), 'CODEC_REAP_UNSAFE_GENERATION')
        socket_dir = entries.get('socket')
        if socket_dir is not None:
            check(stat.S_ISDIR(socket_dir.st_mode), 'CODEC_REAP_UNSAFE_GENERATION')
            with reap_directory(folder, 'socket', socket_dir) as sockets:
                sock = reap_entries(sockets, {'codec.sock'}).get('codec.sock')
                if sock is not None:
                    check(stat.S_ISSOCK(sock.st_mode), 'CODEC_REAP_UNSAFE_GENERATION')
                    os.unlink('codec.sock', dir_fd=sockets)
            os.rmdir('socket', dir_fd=folder)
        if token is not None:
            os.unlink('token', dir_fd=folder)
    os.rmdir(name, dir_fd=root_fd)


class CodecSupervisor:
    def __init__(self, root, lock_file, test_mode=False):
        check(os.geteuid() == 0, 'ROOT_REQUIRED')
        self.root = trusted(root, directory=True)
        check(stat.S_IMODE(self.root.stat().st_mode) == 0o700, 'ROOT_MODE')
        self.test_mode = test_mode
        check(not test_mode or (str(self.root).startswith('/root/mcp-codec-test-') and os.environ.get('NODE_ENV') == 'test'), 'TEST_ONLY')
        self.lock_file = lock_file
        self._lock()
        self.base = self.root / 'mcp-codec'
        self.base.mkdir(mode=0o700, exist_ok=True); trusted(self.base, directory=True)
        self.generations = self.base / 'generations'
        self.generations.mkdir(mode=0o700, exist_ok=True); trusted(self.generations, directory=True)
        self.state_path = self.base / 'state.json'
        self.paused_path = self.base / 'paused'

    def _lock(self):
        path = trusted(self.root / 'update.lock')
        expected, opened = path.stat(), os.fstat(self.lock_file.fileno())
        check((expected.st_dev, expected.st_ino) == (opened.st_dev, opened.st_ino), 'LOCK_IDENTITY')
        try: fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise CodecFailure('UPDATE_BUSY') from None

    def paused(self):
        if not self.paused_path.exists() and not self.paused_path.is_symlink(): return False
        trusted(self.paused_path)
        check(self.paused_path.read_bytes() == b'paused\n', 'PAUSE_MARKER')
        return True

    def docker(self, *arguments, timeout=30):
        self._lock()
        env = {key: value for key, value in os.environ.items() if not key.startswith(('DOCKER_', 'BUILDX_'))}
        env.update({'DOCKER_HOST': 'unix:///var/run/docker.sock', 'LC_ALL': 'C'})
        def limit(): resource.setrlimit(resource.RLIMIT_FSIZE, (262144, 262144))
        with tempfile.TemporaryFile(dir=self.base) as output:
            result = subprocess.run(['docker', '--host=unix:///var/run/docker.sock', *arguments], env=env,
                                    stdout=output, stderr=subprocess.DEVNULL, timeout=timeout, check=False, preexec_fn=limit)
            check(result.returncode == 0, 'DOCKER_' + arguments[0].upper())
            output.seek(0); data = output.read(262145)
            check(len(data) <= 262144, 'DOCKER_OUTPUT_LIMIT')
            return data.decode().strip()

    def state(self):
        value = read_private(self.state_path)
        check(type(value) is dict and value.get('version') == 1 and GENERATION.fullmatch(value.get('generation', '')) and
              re.fullmatch('[0-9a-f]{32}', value.get('owner', '')) and value.get('container') == 'shopping-mcp-codec-' + value['generation'][2:], 'STATE')
        validate_manifest(value['manifest'], self.test_mode)
        return value

    def _save(self, state):
        atomic(self.state_path, state)
        atomic(self.base / 'backend.json', self._public(state))

    def _public(self, state):
        manifest = state['manifest']
        return {'version': 1, 'ready': state['status'] == 'ready', 'status': state['status'], 'generation': state['generation'],
                'generationPath': str(self.generations / state['generation']), 'container': state['container'],
                'image': manifest['image'], 'imageId': manifest['imageId'], 'codecDigest': manifest['imageId'][7:], 'revision': manifest['revision']}

    def _image(self, manifest):
        image = json.loads(self.docker('image', 'inspect', '--format={{json .}}', manifest['image']))
        check(image['Id'] == manifest['imageId'] and image['Os'] + '/' + image['Architecture'] == manifest['platform'], 'IMAGE_MAPPING')
        if not self.test_mode:
            labels = image['Config'].get('Labels') or {}
            check(manifest['image'] in (image.get('RepoDigests') or []) and labels.get('org.opencontainers.image.revision') == manifest['revision'] and
                  labels.get('org.opencontainers.image.source') == 'https://github.com/yapweijun1996/Online-Shopping' and labels.get('org.opencontainers.image.title') == 'online-shopping-media-codec', 'IMAGE_PROVENANCE')
        check(image['Config']['User'] == '10001:1000' and image['Config']['WorkingDir'] == '/codec' and image['Config']['Cmd'] == ['node', 'src/main.js'], 'IMAGE_RUNTIME')

    def _container_args(self, state):
        args = ['--name', state['container'], '--label', LABEL + '=' + state['owner'], '--label', GENERATION_LABEL + '=' + state['generation'],
                '--network=none', '--read-only', '--user=10001:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--cgroupns=private', '--init',
                '--memory=192m', '--memory-swap=192m', '--cpus=0.5', '--pids-limit=32', '--shm-size=1m', '--ulimit=core=0:0', '--ulimit=nofile=64:64', '--restart=no', '--log-driver=none',
                '--env', 'NODE_ENV=production', '--env', 'NODE_OPTIONS=--max-old-space-size=32']
        for name in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']: args += ['--env', name + '=']
        return args

    def _image_files(self, manifest):
        # No mounts, token or native import. The exact artifact is checked before
        # any healthy backend/worker is stopped. Cleanup also covers a lost run response.
        nonce = secrets.token_hex(16)
        state = {'generation': 'g-' + nonce, 'owner': secrets.token_hex(16), 'container': 'shopping-mcp-codec-' + nonce, 'manifest': manifest}
        try:
            actual = json.loads(self.docker('run', '--rm', '--pull=never', *self._container_args(state), '--entrypoint=node', manifest['imageId'], '--input-type=module', '-e', FILE_HASH_PROGRAM, timeout=15))
            check(actual == {key: manifest[key] for key in ['wireSha256', 'clientSha256', 'lockSha256']}, 'IMAGE_FILES')
        finally:
            identity = self._lookup(state)
            if identity is not None:
                value = self._identity(state, identity)
                self.docker('rm', '-f', value['Id'])

    def _lookup(self, state):
        # Query ALL labels/states. A failed inspect is never evidence of absence.
        found = self.docker('ps', '-a', '--no-trunc', '--filter', 'name=^/' + state['container'] + '$', '--format={{.ID}} {{.Names}}')
        if not found: return None
        rows = found.splitlines()
        check(len(rows) == 1, 'CONTAINER_AMBIGUOUS')
        fields = rows[0].split(' ')
        check(len(fields) == 2 and re.fullmatch('[a-f0-9]{64}', fields[0]) and fields[1] == state['container'], 'CONTAINER_LOOKUP')
        return fields[0]

    def _identity(self, state, identity=None):
        identity = identity or self._lookup(state)
        check(identity is not None, 'CONTAINER_ABSENT')
        value = json.loads(self.docker('inspect', '--format={{json .}}', identity))
        labels = value['Config'].get('Labels') or {}
        check(value['Id'] == identity and value['Name'] == '/' + state['container'] and labels.get(LABEL) == state['owner'] and
              labels.get(GENERATION_LABEL) == state['generation'] and value['Image'] == state['manifest']['imageId'], 'CONTAINER_OWNER')
        return value

    def _retire(self, state):
        identity = self._lookup(state)
        if identity is not None:
            value = self._identity(state, identity)
            self.docker('rm', '-f', value['Id'])
        # Only a successful exact-name empty query, or deletion of a proven owned
        # ID, permits this receipt to advance. Retention is separate from stop.
        state['status'] = 'stopped'; self._save(state)
        return self._public(state)

    def _owned(self, state):
        value = self._identity(state)
        host = value['HostConfig']
        check(host['NetworkMode'] == 'none' and not (host.get('PortBindings') or {}) and not (value['NetworkSettings'].get('Ports') or {}) and
              host['ReadonlyRootfs'] is True and host['CapDrop'] == ['ALL'] and 'no-new-privileges:true' in host['SecurityOpt'] and
              host['Memory'] == MEMORY and host['MemorySwap'] == MEMORY and host['PidsLimit'] == 32 and host['NanoCpus'] == 500000000 and
              host['ShmSize'] == 1048576 and host['CgroupnsMode'] == 'private' and host['Init'] is True and
              host['RestartPolicy']['Name'] == 'no' and host['LogConfig']['Type'] == 'none' and value['Config']['User'] == '10001:1000', 'ISOLATION')
        limits = {row['Name']: (row['Soft'], row['Hard']) for row in host['Ulimits']}
        check(limits.get('core') == (0, 0) and limits.get('nofile') == (64, 64), 'LIMITS')
        folder = self.generations / state['generation']
        mounts = {row['Destination']: row for row in value['Mounts']}
        check(len(mounts) == 2 and mounts.get('/run/media-codec', {}).get('Source') == str(folder / 'socket') and mounts['/run/media-codec']['RW'] is True and
              mounts.get('/run/media-codec-token', {}).get('Source') == str(folder / 'token') and mounts['/run/media-codec-token']['RW'] is False, 'MOUNTS')
        variables = dict(row.split('=', 1) for row in value['Config']['Env'])
        check(variables.get('NODE_ENV') == 'production' and variables.get('NODE_OPTIONS') == '--max-old-space-size=32' and
              not any(val and re.search(r'PROXY|DATABASE|PASSWORD|SECRET|ACCESS_KEY|TOKEN', key, re.I) for key, val in variables.items()), 'ENVIRONMENT')
        return value

    def _seal(self, state, initial=False):
        folder = self.generations / state['generation']
        expected = [(folder, stat.S_IFDIR, 1000, 1000, 0o700), (folder / 'socket', stat.S_IFDIR, 1000, 1000, 0o730 if initial else 0o710),
                    (folder / 'token', stat.S_IFREG, 1000, 1000, 0o640), (folder / 'socket/codec.sock', stat.S_IFSOCK, 10001, 1000, 0o660)]
        values = []
        for path, kind, uid, gid, mode in expected:
            info = path.lstat()
            check(stat.S_IFMT(info.st_mode) == kind and info.st_uid == uid and info.st_gid == gid and stat.S_IMODE(info.st_mode) == mode, 'SEAL')
            values.append(info)
        check(sorted(item.name for item in folder.iterdir()) == ['socket', 'token'] and [item.name for item in (folder / 'socket').iterdir()] == ['codec.sock'], 'SEAL_ENTRIES')
        info = values[2]
        check(info.st_nlink == 1 and info.st_size == 43, 'TOKEN_FILE')
        fd = os.open(folder / 'token', os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            check((opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino), 'TOKEN_INODE')
            token = os.read(fd, 44)
        finally: os.close(fd)
        check(re.fullmatch(b'[A-Za-z0-9_-]{43}', token) and base64.urlsafe_b64encode(base64.urlsafe_b64decode(token + b'=' )).rstrip(b'=') == token, 'TOKEN')
        sock = values[3]
        if not initial: check((sock.st_dev, sock.st_ino) == (state['socketDevice'], state['socketInode']), 'SOCKET_INODE')
        return token, sock

    def _probe(self, state):
        value = self._owned(state)
        check(value['State']['Running'] is True, 'WORKER_DOWN')
        token, _ = self._seal(state)
        transport = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); transport.settimeout(1)
        deadline = time.monotonic() + 1
        try:
            transport.connect(str(self.generations / state['generation'] / 'socket/codec.sock'))
            transport.sendall(b'GET /v1/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAuthorization: Bearer ' + token + b'\r\n\r\n')
            header = bytearray()
            while not header.endswith(b'\r\n\r\n'):
                check(time.monotonic() < deadline and len(header) < 2048, 'PROBE_LIMIT')
                transport.settimeout(max(0.001, deadline - time.monotonic())); part = transport.recv(1); check(part, 'PROBE_EOF'); header.extend(part)
            lines = bytes(header).decode('ascii').split('\r\n')
            check(lines[0] == 'HTTP/1.1 200 OK', 'PROBE_STATUS')
            pairs = [line.split(':', 1) for line in lines[1:] if line]
            check(all(len(pair) == 2 for pair in pairs), 'PROBE_HEADERS')
            fields = {key.lower(): val.strip() for key, val in pairs}
            check(len(fields) == len(pairs) and set(fields) <= {'content-type', 'content-length', 'cache-control', 'connection', 'date'} and
                  fields.get('content-type') == 'application/json' and fields.get('cache-control') == 'no-store' and fields.get('connection') == 'close' and fields.get('content-length') == str(len(READY)), 'PROBE_HEADERS')
            body = bytearray()
            while len(body) < len(READY):
                check(time.monotonic() < deadline, 'PROBE_DEADLINE'); transport.settimeout(max(0.001, deadline - time.monotonic()))
                part = transport.recv(len(READY) - len(body)); check(part, 'PROBE_EOF'); body.extend(part)
            check(bytes(body) == READY, 'PROBE_BODY')
            transport.settimeout(max(0.001, deadline - time.monotonic())); check(transport.recv(1) == b'', 'PROBE_TRAILING')
        finally: transport.close()
        return self._public(state)

    def _release_pins(self):
        try:
            state = read_private(self.root / 'state.json')
        except FileNotFoundError:
            return set()  # Standalone supervisor or first installation.
        check(type(state) is dict, 'CODEC_REAP_RELEASE_PINS_UNVERIFIED')
        pins = set()
        for key in ('current', 'previous', 'pending'):
            release = state.get(key)
            if release is None:
                continue
            check(type(release) is dict, 'CODEC_REAP_RELEASE_PINS_UNVERIFIED')
            if 'codec_generation' in release:
                name = release['codec_generation']
                check(isinstance(name, str) and GENERATION.fullmatch(name), 'CODEC_REAP_RELEASE_PINS_UNVERIFIED')
                pins.add(name)
        return pins

    def _container_pins(self, candidates):
        # Include stopped, paused and restarting containers as well as running
        # ones. A restart cannot introduce a reference missing from this list.
        # Managed creation and mount changes are serialized by update.lock.
        ids = self.docker('ps', '-a', '--no-trunc', '--format={{.ID}}').splitlines()
        remaining = set(ids)
        check(len(ids) <= 256 and len(remaining) == len(ids) and
              all(re.fullmatch('[a-f0-9]{64}', identity) for identity in ids), 'CODEC_REAP_DOCKER_UNVERIFIED')
        if not ids:
            return set()
        template = ('--format=[{{json .Id}},{{json .Name}},{{json (index .Config.Labels "' + GENERATION_LABEL +
                    '")}},{{if .Mounts}}{{json .Mounts}}{{else}}[]{{end}}]')
        rows = self.docker('inspect', '--type=container', template, *ids).splitlines()
        pins = set()
        root = self.generations.parts
        for row in rows:
            identity, name, label, mounts = json.loads(row)
            check(identity in remaining and isinstance(name, str) and name.startswith('/') and
                  isinstance(label, str) and isinstance(mounts, list), 'CODEC_REAP_DOCKER_UNVERIFIED')
            remaining.remove(identity)
            if label in candidates:
                pins.add(label)
            if name.startswith('/shopping-mcp-codec-'):
                pins.add('g-' + name.removeprefix('/shopping-mcp-codec-'))
            for mount in mounts:
                kind = mount['Type']
                check(kind in ('bind', 'volume', 'tmpfs', 'image'), 'CODEC_REAP_DOCKER_UNVERIFIED')
                if kind != 'bind':
                    continue
                source = Path(mount['Source'])
                check(source.anchor == '/' and '..' not in source.parts, 'CODEC_REAP_DOCKER_UNVERIFIED')
                parts = source.parts
                if root[:len(parts)] == parts:
                    pins.update(candidates)  # An ancestor bind can access every candidate.
                elif parts[:len(root)] == root:
                    pins.add(parts[len(root)])  # Includes mounts of individual members.
        check(not remaining, 'CODEC_REAP_DOCKER_UNVERIFIED')
        return pins

    def _reap(self, root_fd, inventory, current):
        cutoff = time.time_ns() - GENERATION_MIN_AGE_NS
        ordered = sorted(inventory, key=lambda name: (generation_age_stamp(inventory[name]), name), reverse=True)
        candidates = {name for name in ordered[GENERATION_KEEP:] if generation_age_stamp(inventory[name]) < cutoff}
        if current is not None:
            candidates.discard(current['generation'])
        if not candidates:
            return 0
        try:
            candidates -= self._release_pins()
        except (CodecFailure, OSError, ValueError, TypeError):
            print('CODEC_REAP_RELEASE_PINS_UNVERIFIED', file=sys.stderr)
            return 0
        if not candidates:
            return 0
        try:
            candidates -= self._container_pins(candidates)
        except (CodecFailure, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            print('CODEC_REAP_DOCKER_UNVERIFIED', file=sys.stderr)
            return 0
        reaped = 0
        skipped = False
        for name in reversed(ordered):
            if name not in candidates:
                continue
            try:
                remove_generation(root_fd, name, inventory[name])
                reaped += 1
            except (CodecFailure, OSError, ValueError):
                skipped = True
        if skipped:
            print('CODEC_REAP_UNSAFE_GENERATION', file=sys.stderr)
        if reaped:
            print('CODEC_GENERATIONS_REAPED', file=sys.stderr)
        return reaped

    def preflight(self, manifest, reserve_generations=2):
        self._lock(); manifest = validate_manifest(manifest, self.test_mode)
        check(type(reserve_generations) is int and reserve_generations in [1, 2], 'GENERATION_RESERVE')
        check(len(os.fsencode(self.generations / ('g-' + '0' * 32) / 'socket/codec.sock')) < 108, 'SOCKET_PATH_LIMIT')
        try:
            self.state_path.lstat()
        except FileNotFoundError:
            current = None
        else:
            current = self.state(); identity = self._lookup(current)
            if identity is not None: self._identity(current, identity)
        self._image(manifest)
        self._image_files(manifest)
        trusted(self.generations, directory=True)
        root_fd = os.open(self.generations, DIRECTORY_FLAGS)
        try:
            inventory = {}
            with os.scandir(root_fd) as entries:
                for entry in entries:
                    info = os.lstat(entry.name, dir_fd=root_fd)
                    check(len(inventory) < 2 * GENERATION_LIMIT and GENERATION.fullmatch(entry.name) and
                          stat.S_ISDIR(info.st_mode), 'MANUAL_MAINTENANCE_REQUIRED')
                    inventory[entry.name] = info
            count = len(inventory) - self._reap(root_fd, inventory, current)
        finally:
            os.close(root_fd)
        check(count + reserve_generations <= GENERATION_LIMIT, 'MANUAL_MAINTENANCE_REQUIRED')
        return {'version': 1, 'status': 'preflight_ok', 'capacityRemaining': GENERATION_LIMIT - count, 'reservedGenerations': reserve_generations,
                'image': manifest['image'], 'imageId': manifest['imageId'], 'codecDigest': manifest['imageId'][7:], 'revision': manifest['revision']}

    def prepare(self, manifest):
        self._lock(); manifest = validate_manifest(manifest, self.test_mode)
        if self.state_path.exists(): check(self.state()['status'] == 'stopped', 'GENERATION_EXISTS')
        self.preflight(manifest, reserve_generations=1)
        generation = 'g-' + secrets.token_hex(16); folder = self.generations / generation
        folder.mkdir(mode=0o700); os.chown(folder, 1000, 1000); os.chmod(folder, 0o700)
        child = folder / 'socket'; child.mkdir(mode=0o730); os.chown(child, 1000, 1000); os.chmod(child, 0o730)
        fd = os.open(folder / 'token', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
        with os.fdopen(fd, 'wb') as output:
            os.fchown(output.fileno(), 1000, 1000); os.fchmod(output.fileno(), 0o640); output.write(secrets.token_urlsafe(32).encode())
        state = {'version': 1, 'generation': generation, 'owner': secrets.token_hex(16), 'container': 'shopping-mcp-codec-' + generation[2:], 'status': 'preparing', 'manifest': manifest}
        self._save(state)
        try:
            args = ['run', '-d', '--pull=never', *self._container_args(state),
                    '--mount', 'type=bind,src=' + str(child) + ',dst=/run/media-codec', '--mount', 'type=bind,src=' + str(folder / 'token') + ',dst=/run/media-codec-token,readonly']
            self.docker(*args, manifest['imageId'])
            self._owned(state)
            deadline = time.monotonic() + 15
            while True:
                try:
                    _, sock = self._seal(state, initial=True); break
                except (FileNotFoundError, CodecFailure):
                    check(time.monotonic() < deadline, 'START_DEADLINE')
                    check(self._owned(state)['State']['Running'] is True, 'WORKER_START_FAILED'); time.sleep(0.05)
            state.update({'socketDevice': sock.st_dev, 'socketInode': sock.st_ino})
            os.chmod(child, 0o710)
            self._seal(state)
            actual = json.loads(self.docker('exec', state['container'], 'node', '--input-type=module', '-e', FILE_HASH_PROGRAM))
            check(actual == {key: manifest[key] for key in ['wireSha256', 'clientSha256', 'lockSha256']}, 'IMAGE_FILES')
            state['status'] = 'ready'; self._probe(state); self._save(state)
            return self._public(state)
        except Exception:
            # Keep failed private evidence; never unseal or reuse this generation.
            try:
                self._retire(state)
            except (CodecFailure, OSError, ValueError, subprocess.SubprocessError): state['status'] = 'failed'
            self._save(state); raise

    def probe(self):
        self._lock(); state = self.state(); check(state['status'] == 'ready', 'NOT_READY'); return self._probe(state)

    def status(self):
        self._lock()
        if not self.state_path.exists(): return {'version': 1, 'ready': False, 'status': 'absent'}
        state = self.state()
        if state['status'] != 'ready': return self._public(state)
        try: return self._probe(state)
        except (CodecFailure, OSError, ValueError, subprocess.SubprocessError):
            result = self._public(state); result.update({'ready': False, 'status': 'unavailable'}); return result

    def stop(self, drained=False):
        self._lock(); check(drained is True and self.paused(), 'COORDINATED_DRAIN_REQUIRED')
        state = self.state()
        return self._retire(state)

    def replace(self, manifest, drained=False):
        self._lock(); check(drained is True and self.paused(), 'COORDINATED_DRAIN_REQUIRED')
        self.preflight(manifest, reserve_generations=1)
        self.stop(drained=True)
        return self.prepare(manifest)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'prepare', 'probe', 'status', 'stop', 'replace'])
    parser.add_argument('--root', required=True)
    parser.add_argument('--manifest')
    parser.add_argument('--reserve-generations', type=int, choices=[1, 2], default=2)
    parser.add_argument('--coordinated', action='store_true', help='Trusted operator confirms backend/native work drained; not a self-attestation by the worker.')
    parser.add_argument('--automatic', action='store_true')
    parser.add_argument('--test-local-image', action='store_true', help='Only NODE_ENV=test under /root/mcp-codec-test-*; never a production image selector.')
    args = parser.parse_args(); check(os.geteuid() == 0, 'ROOT_REQUIRED'); os.umask(0o077)
    root = trusted(args.root, directory=True)
    fd = os.open(root / 'update.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'version': 1, 'ready': False, 'status': 'paused'})); return
        supervisor = CodecSupervisor(root, lock, test_mode=args.test_local_image)
        if args.automatic and supervisor.paused(): print(json.dumps({'version': 1, 'ready': False, 'status': 'paused'})); return
        if args.action in ['preflight', 'prepare', 'replace']:
            check(args.manifest is not None, 'MANIFEST_REQUIRED'); value = read_private(Path(args.manifest))
            result = supervisor.preflight(value, args.reserve_generations) if args.action == 'preflight' else supervisor.prepare(value) if args.action == 'prepare' else supervisor.replace(value, drained=args.coordinated)
        else: result = getattr(supervisor, args.action)(drained=args.coordinated) if args.action == 'stop' else getattr(supervisor, args.action)()
        print(json.dumps(result, separators=(',', ':')))

if __name__ == '__main__':
    try: main()
    except (CodecFailure, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        code = error.args[0] if isinstance(error, CodecFailure) else 'FAILED'
        check_code = code if isinstance(code, str) and re.fullmatch('[A-Z_]{1,64}', code) else 'FAILED'
        print(json.dumps({'version': 1, 'ready': False, 'status': 'manual_maintenance_required' if check_code == 'MANUAL_MAINTENANCE_REQUIRED' else 'failed', 'code': check_code}), file=sys.stderr); sys.exit(1)
