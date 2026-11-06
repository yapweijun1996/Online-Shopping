#!/usr/bin/env python3
"""Explicit root-only synthetic AMD64 canary. Never selects or alters production.

Each phase is a separate operator invocation. A started/interrupted phase cannot
be repeated: inspect its private checkpoint, then clean up or use a new nonce.
No daemon, automatic release, schema migration or production-data import.
"""
import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time

PREVIOUS = 'b134f5c30b316b10c88fc8afedac6479a1cd6d8b'
OWNER_LABEL = 'shopping.mcp-canary.owner'
PROJECT_LABEL = 'com.docker.compose.project'
SOURCE_PINS = {
    'deploy/gcp/update.py': 'ac5e7b5ba920f59f55482798c10e2367ed0649bafcf4e84e10a485df5c238974',
    'deploy/gcp/media-codec.py': '881c17e637655f137e009f089be1daca862661e0f123e6c32cc9fa28f941dec2',
    'deploy/gcp/mcp-maintenance.py': '93d37e12c122f5e1a6167d195e31b49c7acc705e40a9757efe5aced1065af49e',
}
HEX64 = re.compile(r'[0-9a-f]{64}\Z')
ID = re.compile(r'sha256:[0-9a-f]{64}\Z')
SHA = re.compile(r'[0-9a-f]{40}\Z')
SERVICES = ('frontend', 'backend', 'postgres', 'whatsapp-qr', 'whatsapp-qr-slot1')
RELEASE_BINDS = {
    ('frontend', '/etc/caddy/Caddyfile'): '${RELEASE_DIR:?Release required}/deploy/gcp/Caddyfile',
    ('postgres', '/docker-entrypoint-initdb.d/01-schema.sql'): '${RELEASE_DIR:?Release required}/src/postgres/schema.sql',
    ('postgres', '/docker-entrypoint-initdb.d/02-app-role.sh'): '${RELEASE_DIR:?Release required}/deploy/init-postgres.sh',
}
PHASES = ('source', 'A', 'B', 'C', 'E-on', 'D', 'E-off')
READY_PROGRAM = "fetch('http://127.0.0.1:3000/ready',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))"
LEGACY_BASELINE_PROGRAM = "import{createHash}from'node:crypto';import{catalogue}from'./src/mcp/tools.js';const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;const tools=catalogue.map(({scope,...tool})=>tool);if(tools.length!==8)process.exit(1);console.log(JSON.stringify({version:1,count:8,sha256:createHash('sha256').update(JSON.stringify(canonical(tools))).digest('hex')}));"
COUNTS_SQL = "SELECT json_build_object('grants',(SELECT COUNT(*) FROM oauth_grant WHERE revoked_at IS NULL),'tokens',(SELECT COUNT(*) FROM oauth_token WHERE revoked_at IS NULL),'codes',(SELECT COUNT(*) FROM oauth_authorization_code WHERE consumed_at IS NULL AND expires_at::timestamptz>clock_timestamp()),'sessions',(SELECT COUNT(*) FROM session),'unbound',(SELECT COUNT(*) FROM oauth_authorization_request WHERE account_id IS NULL AND consumed_at IS NULL AND expires_at::timestamptz>clock_timestamp()))"


class Blocked(Exception):
    """Only fixed codes are exposed; subprocess/HTTP exception text stays private."""


def require(ok, code):
    if not ok:
        raise Blocked(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def deny_production_path(path):
    for candidate in (Path(path).absolute(),Path(path).resolve(strict=False)):
        require(not candidate.is_relative_to('/opt/online-shopping-gcp') and
                'online-shopping-gcp_pg_data' not in candidate.parts,'PRODUCTION_PATH')


def private_json(path, value):
    path = Path(path)
    deny_production_path(path)
    require(not path.is_symlink(), 'PRIVATE_PATH')
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.canary-')
    try:
        with os.fdopen(fd, 'w') as out:
            os.fchmod(out.fileno(), 0o600)
            json.dump(value, out, sort_keys=True); out.write('\n')
            out.flush(); os.fsync(out.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def read_private(path, maximum=262144):
    deny_production_path(path)
    info = Path(path).lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
            stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and info.st_size <= maximum, 'PRIVATE_FILE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        require((opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino), 'PRIVATE_INODE')
        with os.fdopen(fd, 'r', closefd=False) as source: return json.load(source)
    finally: os.close(fd)


class Namespace:
    def __init__(self, nonce):
        require(isinstance(nonce, str) and re.fullmatch('[0-9a-f]{12}', nonce), 'NONCE')
        self.nonce = nonce
        self.project = 'mcp-canary-' + nonce
        self.root = Path('/opt') / self.project
        require(len(os.fsencode(self.root / 'mcp-codec/generations' / ('g-' + '0'*32) / 'socket/codec.sock')) < 108, 'UDS_PATH')

    def app(self, service):
        require(service in SERVICES, 'SERVICE')
        return self.project + '-' + service + '-1'

    def translate(self, args):
        """Translate exact fixed tokens only. Never change Docker response data."""
        result = list(args)
        names = {'online-shopping-gcp-' + s + '-1': self.app(s) for s in SERVICES}
        for index, value in enumerate(result):
            if value in names:
                result[index] = names[value]
            elif value == 'label=' + PROJECT_LABEL + '=online-shopping-gcp':
                result[index] = 'label=' + PROJECT_LABEL + '=' + self.project
            elif value == 'online-shopping-gcp' and index and result[index-1] == '--project-name':
                result[index] = self.project
        require(not any('/opt/online-shopping-gcp' in v or 'online-shopping-edge' in v or
                        v == 'online-shopping-gcp' or v.startswith('online-shopping-gcp-') or
                        '=online-shopping-gcp' in v for v in result), 'PRODUCTION_TOKEN')
        return result


def transform_compose(value, ns):
    """Only the reviewed namespace/network/label differences are introduced."""
    result = json.loads(json.dumps(value))
    require(result.get('name') == ns.project and set(result['services']) == set(SERVICES), 'COMPOSE_SOURCE')
    require(set(result['networks']) == {'edge', 'private', 'egress'} and set(result['volumes']) == {'pg_data'}, 'COMPOSE_TOPOLOGY')
    result['name'] = ns.project
    for key, network in result['networks'].items():
        network.pop('external', None); network.pop('ipam', None)
        network['name'] = ns.project + '_' + key
        network['internal'] = True
        network.setdefault('labels', {})[OWNER_LABEL] = ns.nonce
    result['volumes']['pg_data']['name'] = ns.project + '_pg_data'
    result['volumes']['pg_data'].setdefault('labels', {})[OWNER_LABEL] = ns.nonce
    for name, service in result['services'].items():
        require(not service.get('ports') and not service.get('privileged') and not service.get('container_name'), 'COMPOSE_PORTS')
        service.setdefault('labels', {})[OWNER_LABEL] = ns.nonce
        for mount in service.get('volumes', []):
            expected = RELEASE_BINDS.get((name, mount.get('target')))
            if expected is None:
                continue
            require(mount.get('source') == expected and mount.get('read_only') is True and
                    mount.get('type') in ('volume', 'bind'), 'COMPOSE_RELEASE_BIND')
            if mount['type'] == 'volume':
                # Compose --no-interpolate classifies these variable-prefixed
                # short paths as named volumes. Only these three RO files bind.
                require(set(mount) == {'type', 'source', 'target', 'read_only', 'volume'} and
                        mount['volume'] == {}, 'COMPOSE_RELEASE_BIND_OPTIONS')
                mount['type'] = 'bind'
                del mount['volume']
    return result


class DockerGuard:
    """Closed boundary around the real installed controller/supervisor Docker I/O."""
    def __init__(self, ns, images, record, persist, programs=()):
        self.ns, self.images, self.record, self.persist = ns, set(images), record, persist
        self.programs = set(programs)
        self.compose_hash = None
        self.call_count = 0

    def remember_codec(self, state):
        name = state['container']
        require(name == 'shopping-mcp-codec-' + state['generation'][2:] and
                re.fullmatch('g-[0-9a-f]{32}', state['generation']) and
                re.fullmatch('[0-9a-f]{32}', state['owner']) and ID.fullmatch(state['manifest']['imageId']), 'CODEC_RECEIPT')
        self.record.setdefault('codecs', {})[name] = {k: state[k] for k in ('container', 'generation', 'owner')}
        self.record['codecs'][name]['imageId'] = state['manifest']['imageId']
        self.persist()

    def _name(self, value):
        apps = {self.ns.app(service) for service in SERVICES}
        jobs = set(self.record.get('jobs', []))
        if value in apps | jobs | set(self.record.get('codecs', {})): return value
        mapped = self.record.get('ids', {}).get(value)
        require(mapped is not None, 'UNKNOWN_CONTAINER')
        return mapped

    def owned(self, value, name=None):
        labels = value.get('Config', {}).get('Labels') or {}
        require(labels.get(OWNER_LABEL) == self.ns.nonce and HEX64.fullmatch(value.get('Id', '')), 'OWNER_LABEL')
        actual = value.get('Name', '').removeprefix('/')
        if name is not None: require(actual == name, 'CONTAINER_NAME')
        if actual in self.record.get('codecs', {}):
            receipt = self.record['codecs'][actual]
            require(labels.get('shopping.mcp-codec.owner') == receipt['owner'] and
                    labels.get('shopping.mcp-codec.generation') == receipt['generation'] and
                    value.get('Image') == receipt['imageId'], 'CODEC_OWNER')
        else:
            services={self.ns.app(s):s for s in SERVICES}
            expected=services.get(actual,'backend' if actual in self.record.get('jobs',[]) else None)
            require(expected is not None and labels.get(PROJECT_LABEL) == self.ns.project and
                    labels.get('com.docker.compose.service') == expected, 'PROJECT_OWNER')
        self.record.setdefault('ids', {})[value['Id']] = actual
        self.persist()
        return value

    def inspect(self, name, raw):
        target=name;name=self._name(target)
        value=self.owned(json.loads(raw('inspect','--format','{{json .}}',target)),name)
        if HEX64.fullmatch(target):require(value['Id']==target,'CONTAINER_ID')
        return value

    def compose(self, args, raw):
        prefix = ['compose', '--project-name', self.ns.project, '--env-file', str(self.ns.root/'runtime.env'),
                  '--env-file', str(self.ns.root/'images.env'), '-f', str(self.ns.root/'compose.yaml')]
        require(args[:len(prefix)] == prefix, 'COMPOSE_PREFIX')
        rest = args[len(prefix):]
        if rest[:2] == ['-f', str(self.ns.root/'compose.mcp.yaml')]: rest = rest[2:]
        require(rest[:4] == ['--profile', 'whatsapp-qr', '--profile', 'whatsapp-qr-slot1'], 'COMPOSE_PROFILES')
        tail = rest[4:]
        if tail == ['config', '--no-interpolate', '--no-path-resolution', '--format', 'json']: return args
        require(self.compose_hash and digest((self.ns.root/'compose.yaml').read_bytes()) == self.compose_hash, 'COMPOSE_DRIFT')
        allowed = [
            ['stop', '--timeout', '35', 'frontend'], ['stop', '--timeout', '35', 'backend'],
            ['rm', '--stop', '--force', 'whatsapp-qr', 'whatsapp-qr-slot1'],
        ]
        if tail not in allowed:
            require(tail[:3] == ['up', '-d', '--no-build'] or tail[:2] == ['run', '--rm'], 'COMPOSE_ACTION')
            if tail[0] == 'up':
                remainder = [x for x in tail[3:] if x not in ('--force-recreate', '--no-deps')]
                require(remainder in [['backend','frontend'], ['backend'], ['frontend'], ['backend','frontend','postgres']], 'COMPOSE_SERVICES')
            else:
                require(len(tail)>=8 and tail[2:4] == ['--no-deps', '--name'] and tail[4] in self.record.get('jobs', []), 'JOB_NAME')
                command = tail[5:]
                if command[:2] == ['-e', 'NEW_SELLER_PASSWORD']: command = command[2:]
                require(command[:2] == ['backend', 'node'] and
                        ((command[2:4] == ['scripts/reset-seller-password.js', 'synthetic_owner'] and len(command)==4) or
                         (command[2:3] == ['scripts/recover-seller-mcp.js'] and all(re.fullmatch(r'--(?:phase=(?:accounts|requests)|limit=100|after=[0-9a-f-]{36})', x) for x in command[3:]))), 'JOB_COMMAND')
        # A colliding project must never let Compose mutate foreign resources.
        rows = raw('ps', '-a', '--no-trunc', '--filter', 'label='+PROJECT_LABEL+'='+self.ns.project, '--format', '{{.Names}}').splitlines()
        for name in rows: self.inspect(name, raw)
        for kind, logical in [('volume','pg_data'), ('network','edge'), ('network','private'), ('network','egress')]:
            name = self.ns.project+'_'+logical
            found = raw(kind, 'ls', '--filter', 'name=^'+name+'$', '--format', '{{.Name}}').splitlines()
            require(found in ([], [name]), 'RESOURCE_AMBIGUOUS')
            if found: self.resource(kind, name, raw)
        return args

    def resource(self, kind, name, raw):
        allowed = {self.ns.project+'_pg_data'} if kind == 'volume' else {self.ns.project+'_'+x for x in ('edge','private','egress')}
        require(kind in ('volume','network') and name in allowed, 'RESOURCE_NAME')
        value = json.loads(raw(kind, 'inspect', name))
        require(isinstance(value, list) and len(value)==1 and value[0].get('Name')==name and
                value[0].get('Labels', {}).get(OWNER_LABEL)==self.ns.nonce and
                value[0].get('Labels', {}).get(PROJECT_LABEL)==self.ns.project, 'RESOURCE_OWNER')
        return value[0]

    def call(self, incoming, raw, timeout=180, supervisor=None, **kwargs):
        self.call_count += 1
        args = self.ns.translate(incoming)
        require(args and not any(x.startswith(('--host', '--context', '--privileged', '--publish', '-p=')) for x in args), 'DOCKER_OPTIONS')
        action = args[0]
        codec_lookup = False
        if action == 'compose': args = self.compose(args, raw)
        elif action == 'pull':
            require(len(args)==4 and args[1:3]==['--platform','linux/amd64'] and args[3] in self.images, 'PULL')
        elif args[:2] == ['image','inspect']:
            require(args[-1] in self.images and args[2:-1] in [['--format','{{json .}}'], ['--format={{json .}}']], 'IMAGE_INSPECT')
        elif action == 'ps':
            app = args in [['ps','-q','--filter','label='+PROJECT_LABEL+'='+self.ns.project,'--filter','label=com.docker.compose.service='+s] for s in ('frontend','backend')]
            codec = len(args)==6 and args[:4]==['ps','-a','--no-trunc','--filter'] and args[-1]=='--format={{.ID}} {{.Names}}'
            if codec:
                match = re.fullmatch(r'name=\^/(shopping-mcp-codec-[0-9a-f]{32})\$', args[4])
                require(match and match[1] in self.record.get('codecs', {}), 'CODEC_LOOKUP')
                codec_lookup = True
            require(app or codec, 'PS_FILTER')
        elif action == 'inspect':
            require(args[1:-1] in [['--format','{{json .}}'], ['--format','{{json .State}}'], ['--format','{{.Config.Image}}'], ['--format={{json .}}']], 'INSPECT_FORMAT')
            args[-1]=self.inspect(args[-1],raw)['Id']
        elif action == 'exec':
            offset = 2 if args[1:2]==['-i'] else 1
            name=self._name(args[offset]);proved=self.inspect(args[offset],raw)
            command = args[offset+1:]
            if command[:1] == ['node']:
                allowed = (command[:2] == ['node','-e'] and len(command)==3 and command[2] in self.programs) or (command[:3]==['node','--input-type=module','-e'] and len(command)==4 and command[3] in self.programs)
                require(allowed, 'EXEC_NODE')
            else:
                require(name == self.ns.app('postgres') and command in [
                    ['pg_dump','-U','online_shopping','-d','online_shopping','--format=custom'],
                    ['pg_restore','-U','online_shopping','-d','online_shopping','--clean','--if-exists','--exit-on-error','--single-transaction'],
                    ['psql','-U','online_shopping','-d','online_shopping','-tA','-v','ON_ERROR_STOP=1','-c',COUNTS_SQL],
                ], 'EXEC_PG')
            args[offset]=proved['Id']
        elif action in ('rm','kill'):
            require(args[1:-1] == (['-f'] if action=='rm' else ['--signal=KILL']), 'MUTATION_OPTIONS')
            args[-1]=self.inspect(args[-1],raw)['Id']
        elif action == 'run' and supervisor is not None:
            name = args[args.index('--name')+1]
            labels = [args[i+1] for i,x in enumerate(args[:-1]) if x=='--label']
            pairs = dict(x.split('=',1) for x in labels)
            state = {'container':name, 'generation':pairs.get('shopping.mcp-codec.generation',''),
                     'owner':pairs.get('shopping.mcp-codec.owner',''), 'manifest':{'imageId':next((x for x in args if ID.fullmatch(x)), '')}}
            require(state['manifest']['imageId'] in self.images, 'CODEC_IMAGE')
            common = supervisor._container_args(state)
            folder = self.ns.root/'mcp-codec/generations'/state['generation']
            normal = ['run','-d','--pull=never',*common,'--mount','type=bind,src='+str(folder/'socket')+',dst=/run/media-codec','--mount','type=bind,src='+str(folder/'token')+',dst=/run/media-codec-token,readonly',state['manifest']['imageId']]
            check = ['run','--rm','--pull=never',*common,'--entrypoint=node',state['manifest']['imageId'],'--input-type=module','-e',supervisor.__class__._canary_hash_program]
            require(args in (normal, check), 'CODEC_ARGUMENTS')
            self.remember_codec(state)
            args = ['run','--label',OWNER_LABEL+'='+self.ns.nonce,*args[1:]]
        elif action in ('network','volume'):
            require(len(args)==3 and args[1]=='rm', 'RESOURCE_ACTION')
            self.resource(action,args[2],raw)
        else: raise Blocked('DOCKER_ACTION')
        result = raw(*args, timeout=timeout, **kwargs)
        if codec_lookup and result:
            for line in result.splitlines():
                identity, name = line.split(' ')
                require(HEX64.fullmatch(identity) and name in self.record.get('codecs',{}), 'LOOKUP_RESPONSE')
                self.record.setdefault('ids',{})[identity]=name
            self.persist()
        return result


def bounded_docker(ns, *args, timeout=180, input=None, extra_env=None, binary=False):
    """Private bounded subprocess; no inherited Docker context or credential env."""
    env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','HOME':str(ns.root),'LC_ALL':'C'}
    if extra_env:
        require(set(extra_env)=={'NEW_SELLER_PASSWORD'}, 'PROCESS_ENV')
        env.update(extra_env)
    def limits(): resource.setrlimit(resource.RLIMIT_FSIZE,(16*1024*1024,16*1024*1024))
    with tempfile.TemporaryFile(dir=ns.root) as output, tempfile.TemporaryFile(dir=ns.root) as errors:
        result=subprocess.run(['docker','--host=unix:///var/run/docker.sock','--config',str(ns.root/'docker-anonymous'),*args],
                              input=input,stdout=output,stderr=errors,timeout=timeout,env=env,check=False,preexec_fn=limits)
        output.seek(0); data=output.read(16*1024*1024+1)
        require(len(data)<=16*1024*1024,'DOCKER_OUTPUT')
        if result.returncode:
            try:failure=json.loads(data)
            except (ValueError,UnicodeError):failure={}
            if isinstance(failure,dict) and set(failure)=={'ok','code'} and failure['ok'] is False and re.fullmatch('[A-Z_]{1,64}',failure.get('code','')):
                raise Blocked('CLIENT_'+failure['code'])
            raise Blocked('DOCKER_FAILED')
        return data if binary else data.decode()


def validate_manifest(value):
    require(isinstance(value,dict) and set(value)=={'version','nonce','candidate','previous','verifyRunId','publicationRunId','policyHashes','helperHashes'} and type(value['version']) is int and value['version']==1,'INPUT_MANIFEST')
    ns=Namespace(value['nonce'])
    for key in ('candidate','previous'):
        release=value[key]
        expected={'sha','backend','frontend'} | ({'codec'} if key=='candidate' else set())
        require(isinstance(release,dict) and set(release)==expected and SHA.fullmatch(release['sha']),'INPUT_RELEASE')
        for component in expected-{'sha'}:
            package='backend' if component=='codec' else component
            require(isinstance(release[component],str) and re.fullmatch('ghcr.io/yapweijun1996/online-shopping-'+package+'@sha256:[0-9a-f]{64}',release[component]),'INPUT_IMAGE')
        if key=='candidate':require(release['codec']!=release['backend'],'SEPARATE_CODEC_IMAGE')
    require(value['previous']['sha']==PREVIOUS and value['candidate']['sha']!=PREVIOUS,'INPUT_REVISIONS')
    require(all(type(value[k]) is int and value[k]>0 for k in ('verifyRunId','publicationRunId')),'INPUT_CI')
    require(set(value['policyHashes'])==set(SOURCE_PINS)|{'compose.gcp.yaml','deploy/gcp/compose.mcp.yaml'} and
            all(HEX64.fullmatch(x) for x in value['policyHashes'].values()) and
            all(value['policyHashes'][k]==v for k,v in SOURCE_PINS.items()),'POLICY_PINS')
    require(set(value['helperHashes'])=={'qa-gcp-mcp-canary.py','qa-gcp-mcp-canary.mjs'} and
            all(HEX64.fullmatch(x) for x in value['helperHashes'].values()),'HELPER_PINS')
    return ns


class Harness:
    def __init__(self, manifest, source_root):
        self.ns=validate_manifest(manifest); self.root=self.ns.root; self.manifest=manifest
        require(os.geteuid()==0,'ROOT_REQUIRED')
        os.umask(0o077)
        self.source_root=Path(source_root)
        deny_production_path(self.source_root)
        for path,expected in manifest['policyHashes'].items():
            source=self.source_root/path
            require(not source.is_symlink() and source.is_file() and digest(source.read_bytes())==expected,'LOCAL_POLICY_HASH')
        for name,expected in manifest['helperHashes'].items():
            source=Path(__file__).with_name(name)
            require(not source.is_symlink() and digest(source.read_bytes())==expected,'LOCAL_HELPER_HASH')
        for ancestor in self.root.parents:
            info=ancestor.lstat()
            require(not stat.S_ISLNK(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022,'ROOT_ANCESTORS')
        if not self.root.exists():
            self.root.mkdir(mode=0o700)
            private_json(self.root/'canary-owner.json',{'version':1,'nonce':self.ns.nonce})
            self.record={'version':1,'nonce':self.ns.nonce,'manifestHash':digest(json.dumps(manifest,sort_keys=True).encode()),'phases':{},'io':{}}
            self.persist()
            for name in ('releases','backups','secrets','docker-anonymous'): (self.root/name).mkdir(mode=0o700)
            private_json(self.root/'docker-anonymous/config.json',{})
            mapping={'deploy/gcp/update.py':'update.py','deploy/gcp/media-codec.py':'media-codec.py',
                     'deploy/gcp/mcp-maintenance.py':'mcp-maintenance.py','compose.gcp.yaml':'compose.source.yaml',
                     'deploy/gcp/compose.mcp.yaml':'compose.mcp.yaml'}
            for source,destination in mapping.items():
                (self.root/destination).write_bytes((self.source_root/source).read_bytes());(self.root/destination).chmod(0o600)
            (self.root/'compose.yaml').write_bytes((self.root/'compose.source.yaml').read_bytes())
        self.trust_root()
        self.record=read_private(self.root/'canary.json',1048576)
        require(self.record.get('manifestHash')==digest(json.dumps(manifest,sort_keys=True).encode()),'MANIFEST_DRIFT')
        for source,name in [('deploy/gcp/update.py','update.py'),('deploy/gcp/media-codec.py','media-codec.py'),
                            ('deploy/gcp/mcp-maintenance.py','mcp-maintenance.py'),('compose.gcp.yaml','compose.source.yaml'),
                            ('deploy/gcp/compose.mcp.yaml','compose.mcp.yaml')]:
            require(digest((self.root/name).read_bytes())==manifest['policyHashes'][source],'INSTALLED_POLICY_DRIFT')
        spec=importlib.util.spec_from_file_location('canary_installed_update',self.root/'update.py')
        self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        self.client_code=Path(__file__).with_suffix('.mjs').read_text()
        images=set()
        for key in ('candidate','previous'):
            r=manifest[key];images.update(v for k,v in r.items() if k!='sha')
            images.update('ghcr.io/yapweijun1996/online-shopping-'+x+':'+r['sha'] for x in ('backend','frontend'))
        images.add('ghcr.io/yapweijun1996/online-shopping-backend:media-codec-'+manifest['candidate']['sha'])
        self.base_images=set(images)
        images.update(self.record.get('imageIds',[]))
        self.guard=DockerGuard(self.ns,images,self.record['io'],self.persist,[READY_PROGRAM,LEGACY_BASELINE_PROGRAM,self.module.frontend_probe('shop.'+self.ns.nonce+'.invalid'),self.client_code])
        self.guard.compose_hash=self.record.get('composeHash')
        self.lock=None

    def trust_root(self):
        for path in (self.root,*self.root.parents):
            info=path.lstat()
            require(not stat.S_ISLNK(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022,'ROOT_ANCESTORS')
        require(stat.S_IMODE(self.root.stat().st_mode)==0o700 and
                read_private(self.root/'canary-owner.json')=={'version':1,'nonce':self.ns.nonce},'ROOT_SENTINEL')

    def persist(self):
        private_json(self.root/'canary.json',self.record)

    def reload_checkpoint(self):
        value=read_private(self.root/'canary.json',1048576)
        require(value.get('version')==1 and value.get('nonce')==self.ns.nonce and
                value.get('manifestHash')==digest(json.dumps(self.manifest,sort_keys=True).encode()) and
                isinstance(value.get('phases'),dict) and isinstance(value.get('io'),dict),'CHECKPOINT_IDENTITY')
        require(isinstance(value.get('imageIds',[]),list) and all(isinstance(x,str) and ID.fullmatch(x) for x in value.get('imageIds',[])),'CHECKPOINT_IMAGES')
        self.record=value
        self.guard.record=value['io']
        self.guard.images=self.base_images|set(value.get('imageIds',[]))
        self.guard.compose_hash=value.get('composeHash')

    def step(self, name):
        self.record['step']=name;self.persist()

    def raw(self,*args,**kwargs):
        return bounded_docker(self.ns,*args,**kwargs)

    def docker(self,*args,**kwargs):
        return self.guard.call(args,self.raw,**kwargs)

    def controller(self):
        harness=self
        class CanaryUpdater(self.module.Updater):
            def docker(self,*args,timeout=180):
                return harness.guard.call(args,super().docker,timeout=timeout)
            def supervisor(self):
                actual=super().supervisor()
                require(actual.test_mode is False,'PRODUCTION_SUPERVISOR_MODE')
                # importlib's original module is not registered by the controller;
                # the installed method's globals are its exact source namespace.
                program=actual._image_files.__func__.__globals__['FILE_HASH_PROGRAM']
                actual.__class__._canary_hash_program=program;harness.guard.programs.add(program)
                original=actual.docker
                actual.docker=lambda *args,timeout=30:harness.guard.call(args,original,timeout=timeout,supervisor=actual)
                return actual
        return CanaryUpdater(self.root,self.lock)

    def source(self):
        controller=self.controller();sha=self.manifest['candidate']['sha']
        require(controller.head()==sha and controller.approved(sha),'EXACT_MAIN_CI')
        for key,path,event in [('verifyRunId','.github/workflows/verify.yml','push'),('publicationRunId','.github/workflows/gcp-images.yml','workflow_run')]:
            run=self.module.api('/actions/runs/'+str(self.manifest[key]))
            require(run.get('id')==self.manifest[key] and run.get('head_sha')==sha and run.get('head_branch')=='main' and
                    run.get('path')==path and run.get('event')==event and run.get('status')=='completed' and
                    run.get('conclusion')=='success' and run.get('repository',{}).get('full_name')==self.module.REPO,'CI_RUN_IDENTITY')
        for key in ('previous','candidate'):
            target=self.manifest[key]['sha'];baseline,content=controller.source(target)
            require(baseline['schema']==34,'SOURCE_SCHEMA34')
            private_json(self.root/('source-'+target+'.json'),{'baseline':baseline,'content':{p:base64.b64encode(b).decode() for p,b in content.items()}})
        return {'sha':sha,'verifyRunId':self.manifest['verifyRunId'],'publicationRunId':self.manifest['publicationRunId'],'readOnlySourceQuery':True}

    def source_cache(self,sha):
        value=read_private(self.root/('source-'+sha+'.json'),1048576)
        return value['baseline'],{p:base64.b64decode(b,validate=True) for p,b in value['content'].items()}

    def secret_file(self,name,text,mode=0o600,uid=0):
        path=self.root/'secrets'/name
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
        with os.fdopen(fd,'w') as out:
            os.fchown(out.fileno(),uid,1000 if uid==1000 else 0);os.fchmod(out.fileno(),mode)
            out.write(text+'\n');out.flush();os.fsync(out.fileno())
        return path

    def runtime(self,on):
        values={'SHOP_HOST':'shop.'+self.ns.nonce+'.invalid','SELLER_HOST':'seller.'+self.ns.nonce+'.invalid',
                'ADMIN_USERNAME':'synthetic_owner','SECRETS_DIR':str(self.root/'secrets'),'PLATFORM_ENABLED':'0',
                'AI_ENABLED':'0','WHATSAPP_QR_ENABLED':'0','WHATSAPP_QR_SLOT1_ENABLED':'0','MCP_ENABLED':'1' if on else '0',
                'MCP_REDIRECT_URIS':'https://client.example.com/canary-'+self.ns.nonce}
        if on:values.update({key:'1' for key in self.module.MCP_FLAGS},MCP_V2_PRODUCTION_PROFILE=self.module.PROFILE)
        self.module.atomic(self.root/'runtime.env',''.join(k+'='+v+'\n' for k,v in values.items()).encode())

    def artifact(self,key):
        controller=self.controller();expected=self.manifest[key];baseline,content=self.source_cache(expected['sha'])
        release=controller.release(expected['sha'],baseline,content)
        for component in ('backend','frontend'):
            require(release[component]==expected[component],'PUBLIC_ARTIFACT_PIN')
            info=json.loads(controller.docker('image','inspect','--format','{{json .}}',release[component]))
            labels=info.get('Config',{}).get('Labels') or {}
            require(ID.fullmatch(info.get('Id','')) and info.get('Os')=='linux' and info.get('Architecture')=='amd64' and
                    labels.get('org.opencontainers.image.source')=='https://github.com/'+self.module.REPO and
                    labels.get('org.opencontainers.image.revision')==expected['sha'],'PUBLIC_ARTIFACT_IDENTITY')
            self.guard.images.add(info['Id']);self.record.setdefault('imageIds',[]).append(info['Id'])
        if key=='candidate':
            require(release['mcp']['codec']['image']==expected['codec'],'PUBLIC_CODEC_PIN')
            self.guard.images.add(release['mcp']['codec']['imageId']);self.record['imageIds'].append(release['mcp']['codec']['imageId'])
        self.record.setdefault('releases',{})[key]=release;self.persist();return release

    def pg_identity(self):
        value=self.guard.inspect(self.ns.app('postgres'),self.raw)
        mounts=[x for x in value.get('Mounts',[]) if x.get('Destination')=='/var/lib/postgresql/data']
        require(value.get('State',{}).get('Running') is True and len(mounts)==1 and mounts[0].get('Type')=='volume' and
                mounts[0].get('Name')==self.ns.project+'_pg_data','PG_IDENTITY')
        actual={'containerId':value['Id'],'volume':mounts[0]['Name'],'startedAt':value['State']['StartedAt']}
        self.guard.resource('volume',actual['volume'],self.raw)
        if 'pg' in self.record:require(actual==self.record['pg'],'PG_REPLACED')
        else:self.record['pg']=actual;self.persist()
        return actual

    def policy_readback(self):
        evidence={}
        for service,memory,cpu,networks in [('backend',384,500000000,{'private','egress'}),('frontend',48,250000000,{'private','edge'}),('postgres',192,350000000,{'private'})]:
            value=self.guard.inspect(self.ns.app(service),self.raw);host=value['HostConfig']
            require(host.get('Memory')==memory*1024*1024 and host.get('NanoCpus')==cpu and
                    not host.get('Privileged') and not host.get('PortBindings') and
                    all(x is None for x in (value.get('NetworkSettings',{}).get('Ports') or {}).values()) and
                    set(value['NetworkSettings']['Networks'])=={self.ns.project+'_'+x for x in networks} and
                    'no-new-privileges:true' in host.get('SecurityOpt',[]) and value['State'].get('OOMKilled') is False,'APP_RESOURCE_ISOLATION')
            if service=='backend':require(host.get('ReadonlyRootfs') is True,'BACKEND_READ_ONLY')
            evidence[service]={'memoryBytes':host['Memory'],'nanoCpus':host['NanoCpus'],'oomKilled':False,'hostPorts':0}
        for logical in ('edge','private','egress'):
            require(self.guard.resource('network',self.ns.project+'_'+logical,self.raw).get('Internal') is True,'INTERNAL_NETWORK')
        return evidence

    def client(self,action,**extra):
        private=self.root/'client-state.json'
        state=read_private(private) if private.exists() else {}
        data={'nonce':self.ns.nonce,'sellerHost':'seller.'+self.ns.nonce+'.invalid',
              'origin':'https://seller.'+self.ns.nonce+'.invalid','redirect':'https://client.example.com/canary-'+self.ns.nonce,
              'action':action,'state':state,'legacyDefinitionsSha256':self.legacy_hash(),**extra}
        payload=json.dumps(data).encode();require(len(payload)<=65536,'CLIENT_STATE_BOUND')
        result=self.docker('exec','-i',self.ns.app('backend'),'node','--input-type=module','-e',self.client_code,input=payload,timeout=120)
        value=json.loads(result)
        require(value.get('ok') is True and set(value)=={'ok','state','evidence'},'CLIENT_ASSERTION')
        private_json(private,value['state'])
        self.record.setdefault('evidence',{}).setdefault(self.record['activePhase'],[]).append(value['evidence']);self.persist()
        return value['evidence']

    def legacy_hash(self):
        oracle=self.record.get('legacyContract')
        require(isinstance(oracle,dict) and set(oracle)=={'revision','backend','count','sha256'} and
                oracle['revision']==PREVIOUS and oracle['backend']==self.manifest['previous']['backend'] and
                type(oracle['count']) is int and oracle['count']==8 and isinstance(oracle['sha256'],str) and
                HEX64.fullmatch(oracle['sha256']),'LEGACY_BASELINE_REQUIRED')
        return oracle['sha256']

    def capture_legacy_baseline(self):
        value=self.guard.inspect(self.ns.app('backend'),self.raw)
        env=dict(x.split('=',1) for x in value.get('Config',{}).get('Env',[]))
        require(value['Config']['Image']==self.manifest['previous']['backend'] and env.get('MCP_ENABLED')=='0','LEGACY_BASELINE_IMAGE')
        actual=json.loads(self.docker('exec',self.ns.app('backend'),'node','--input-type=module','-e',LEGACY_BASELINE_PROGRAM,timeout=15))
        require(isinstance(actual,dict) and set(actual)=={'version','count','sha256'} and actual['version']==1 and
                type(actual['count']) is int and actual['count']==8 and HEX64.fullmatch(actual['sha256']),'LEGACY_BASELINE_OUTPUT')
        self.record['legacyContract']={'revision':PREVIOUS,'backend':self.manifest['previous']['backend'],'count':8,'sha256':actual['sha256']}
        self.persist();return self.record['legacyContract']

    def accept(self,release,previous=None):
        controller=self.controller()
        if 'mcp' in release:controller.preflight_mcp(release)
        controller.save('canary_deploying',pending=release,pending_kind=None,local=controller.local_fingerprint())
        controller.activate(release);controller.health(release);controller.unpause()
        controller.save('canary_accepted',current=release,previous=previous,pending=None,pending_kind=None,local=controller.local_fingerprint())

    def generation(self):
        supervisor=self.controller().supervisor();public=supervisor.probe();state=supervisor.state()
        folder=Path(public['generationPath']);sock=(folder/'socket/codec.sock').lstat()
        return {**public,'tokenHash':digest((folder/'token').read_bytes()),'socketDevice':sock.st_dev,'socketInode':sock.st_ino,
                'backendId':self.guard.inspect(self.ns.app('backend'),self.raw)['Id'],'owner':state['owner']}

    def drained(self):
        controller=self.controller();controller.pause();controller.stop_clients(controller.compose({}))
        supervisor=controller.supervisor()
        if supervisor.status().get('status')!='absent':supervisor.stop(drained=True)
        return controller

    def lock_probe(self):
        program="import fcntl,sys\nf=open(sys.argv[1],'a')\ntry:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:sys.exit(0)\nsys.exit(1)"
        result=subprocess.run([sys.executable,'-c',program,str(self.root/'update.lock')],stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,close_fds=True,
                              env={'PATH':'/usr/bin:/bin','HOME':str(self.root)})
        require(result.returncode==0,'SHARED_LOCK_CONTENTION')

    def phase_A(self):
        available=int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))
        require(available>=1100*1024 and shutil.disk_usage(self.root).free>=3*1024**3,'RESOURCE_ADMISSION')
        require(not self.raw('ps','-a','--filter','label='+PROJECT_LABEL+'='+self.ns.project,'--format','{{.ID}}').strip(),'PROJECT_ALREADY_EXISTS')
        self.record['admission']={'memAvailableKiB':available,'diskFreeBytes':shutil.disk_usage(self.root).free};self.persist()
        self.runtime(False)
        for name in ('admin-password','postgres-password','postgres-owner-password','integration-keys','platform-password','provisioner-password','whatsapp-qr-token','whatsapp-qr-token-slot1','ai-api-key'):
            # Both Postgres's non-root init script and backend read the app DB secret.
            shared=name in ('postgres-password','postgres-owner-password')
            self.secret_file(name,'Synthetic-'+secrets.token_urlsafe(32)+'!',mode=0o444 if shared else 0o600,uid=1000)
        self.secret_file('whatsapp-qr-bindings.json','{}',uid=1000)
        old=self.artifact('previous')
        self.module.atomic(self.root/'images.env',('BACKEND_IMAGE='+old['backend']+'\nFRONTEND_IMAGE='+old['frontend']+'\nAPP_REVISION='+old['sha']+'\nRELEASE_DIR='+str(self.root/'releases'/old['sha'])+'\n').encode())
        controller=self.controller()
        original=json.loads(controller.docker(*controller.compose({}),'config','--no-interpolate','--no-path-resolution','--format','json'))
        transformed=transform_compose(original,self.ns)
        require(transformed['services']['backend']['environment']['MCP_ENABLED']=='${MCP_ENABLED:-0}','COMPOSE_INTERPOLATION_RETAINED')
        private_json(self.root/'compose-source-normalized.json',original)
        private_json(self.root/'compose.yaml',transformed)
        self.record['composeHash']=digest((self.root/'compose.yaml').read_bytes());self.guard.compose_hash=self.record['composeHash'];self.persist()
        self.step('historical_manual_bootstrap')
        controller.activate(old,initial=True);controller.health(old);controller.unpause()
        controller.save('canary_historical_baseline',current=old,previous=None,pending=None,local=controller.local_fingerprint())
        self.capture_legacy_baseline();self.pg_identity();self.client('baseline')
        return {'historicalManualBootstrap':True,'initializeTrustGateClaimed':False,'sha':old['sha'],'legacyContract':self.record['legacyContract'],'policy':self.policy_readback()}

    def phase_B(self):
        trust=self.controller();sha=self.manifest['candidate']['sha']
        require(trust.head()==sha and trust.approved(sha),'EXACT_MAIN_CI_CHANGED')
        directory=self.root/'mcp-control';directory.mkdir(mode=0o710);os.chown(directory,0,1000);directory.chmod(0o710)
        epoch=directory/'epoch';epoch.write_bytes(base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=')+b'\n');os.chown(epoch,0,1000);epoch.chmod(0o440)
        self.runtime(True);candidate=self.artifact('candidate')
        require(trust.head()==sha and trust.approved(sha),'EXACT_MAIN_CI_CHANGED')
        self.step('pending_first_full_activation');self.accept(candidate,self.record['releases']['previous'])
        self.pg_identity();self.client('on');self.record['generation']=self.generation();self.persist()
        return {'fullProfile':True,'pendingFirst':True,'privateHttpOnly':True,'realSellerApprovalClaimed':False,'policy':self.policy_readback()}

    def phase_C(self):
        self.lock_probe()
        controller=self.controller();controller.pause();before_calls=self.guard.call_count;controller.recover_codec()
        require(controller.state.get('status')=='codec_paused' and self.guard.call_count==before_calls,'PAUSED_RECOVERY_BARRIER');controller.unpause()
        before=self.generation();self.step('owned_codec_crash')
        self.docker('kill','--signal=KILL',before['container'])
        self.client('readiness-failed')
        epoch=digest((self.root/'mcp-control/epoch').read_bytes())
        self.step('real_same_build_codec_recovery');controller=self.controller();controller.recover_codec()
        require(controller.state.get('status')=='codec_recovered','ACTUAL_CODEC_RECOVERY')
        after=self.generation()
        require(after['generation']!=before['generation'] and after['tokenHash']!=before['tokenHash'] and
                (after['socketDevice'],after['socketInode'])!=(before['socketDevice'],before['socketInode']) and
                after['backendId']!=before['backendId'] and after['imageId']==before['imageId'] and after['revision']==before['revision'] and
                digest((self.root/'mcp-control/epoch').read_bytes())==epoch,'RECOVERY_IDENTITY_FENCE')
        require((Path(before['generationPath'])/'socket').stat().st_mode&0o777==0o710,'OLD_GENERATION_SEALED')
        self.client('grants-live');self.client('native');self.pg_identity()
        self.record['generation']=after;self.persist()
        return {'sameBuild':True,'epochUnchanged':True,'freshGeneration':True,'pausedRecoveryDenied':True,'kernelLockContentionDenied':True,'policy':self.policy_readback()}

    def phase_E_on(self):
        self.client('pending');controller=self.controller();current=controller.state['current'];before=self.generation()
        require(controller.head()==self.manifest['candidate']['sha'],'EXACT_MAIN_CHANGED')
        epoch=digest((self.root/'mcp-control/epoch').read_bytes())
        controller.save('canary_interrupted_pending',pending=current,pending_kind=None)
        self.step('actual_pending_same_build_rollback');controller=self.controller();controller.poll()
        require(controller.state.get('pending') is None and controller.state.get('current')==current and not controller.paused(),'PENDING_ROLLBACK')
        after=self.generation()
        require(after['generation']!=before['generation'] and after['imageId']==before['imageId'] and
                digest((self.root/'mcp-control/epoch').read_bytes())!=epoch,'SAME_BUILD_ROLLBACK_EPOCH')
        self.client('epoch-fenced');self.pg_identity()
        return {'sameBuildRollbackOnly':True,'differentOldOnImageTested':False,'epochRotated':True,'commerceUndoClaimed':False}

    def counts(self):
        return json.loads(self.docker('exec',self.ns.app('postgres'),'psql','-U','online_shopping','-d','online_shopping','-tA','-v','ON_ERROR_STOP=1','-c',COUNTS_SQL))

    def job(self,phase,args,password=None):
        name=self.ns.project+'-job-'+phase
        require(name not in self.record['io'].get('jobs',[]),'DUPLICATE_JOB')
        self.record['io'].setdefault('jobs',[]).append(name);self.persist()
        controller=self.controller();release=self.record['releases']['candidate']
        tail=['run','--rm','--no-deps','--name',name]
        extra={}
        if password is not None:
            require(12<=len(password)<=256 and '\n' not in password,'SYNTHETIC_TEMP_PASSWORD')
            tail+=['-e','NEW_SELLER_PASSWORD'];extra['extra_env']={'NEW_SELLER_PASSWORD':password}
        return self.docker(*controller.compose(release),*tail,'backend','node',*args,timeout=90,**extra)

    def phase_D(self):
        candidate=self.record['releases']['candidate'];self.client('restore-prepare')
        # pg_dump takes a consistent synthetic snapshot. No other synthetic HTTP
        # client runs here; the shared lock excludes host lifecycle changes.
        # Drain before restore, keeping the real 60-second OAuth code TTL intact.
        self.step('synthetic_consistent_snapshot')
        dump=self.docker('exec',self.ns.app('postgres'),'pg_dump','-U','online_shopping','-d','online_shopping','--format=custom',binary=True,timeout=90)
        archive=self.root/'backups/synthetic.pgdump';archive.write_bytes(dump);archive.chmod(0o600)
        with archive.open('rb') as handle:os.fsync(handle.fileno())
        self.record['snapshot']={'sha256':digest(dump),'bytes':len(dump)};self.persist()
        self.client('restore-revoke')
        controller=self.drained();self.step('synthetic_restore_all_writers_stopped')
        require(digest(archive.read_bytes())==self.record['snapshot']['sha256'],'SNAPSHOT_HASH')
        self.docker('exec','-i',self.ns.app('postgres'),'pg_restore','-U','online_shopping','-d','online_shopping','--clean','--if-exists','--exit-on-error','--single-transaction',input=dump,timeout=90)
        restored=self.counts();require(restored['grants']>=2 and restored['tokens']>=4 and restored['codes']>=1 and restored['sessions']>=1 and restored['unbound']>=1,'RESTORED_LIVE_CREDENTIALS')
        epoch=digest((self.root/'mcp-control/epoch').read_bytes());controller.epoch_control(rotate=True)
        require(digest((self.root/'mcp-control/epoch').read_bytes())!=epoch,'RESTORE_EPOCH_ROTATION')
        self.step('actual_packaged_credential_hygiene')
        pages=[]
        for phase in ('accounts','requests'):
            cursor=None
            for index in range(10):
                args=['scripts/recover-seller-mcp.js','--phase='+phase,'--limit=100']+(['--after='+cursor] if cursor else [])
                result=json.loads(self.job('recover-'+phase+'-'+str(index),args));pages.append(result)
                require(set(result)=={'phase','processed','nextPhase','nextCursor','complete'} and result['phase']==phase and
                        type(result['processed']) is int and 0<=result['processed']<=100,'HYGIENE_RESPONSE')
                cursor=result['nextCursor']
                if cursor is None:
                    require(result['complete']==(phase=='requests') and result['nextPhase']==('requests' if phase=='accounts' else None),'HYGIENE_COMPLETE');break
                require(isinstance(cursor,str) and re.fullmatch('[0-9a-f-]{36}',cursor) and result['complete'] is False and result['nextPhase']==phase,'HYGIENE_CURSOR')
            else:raise Blocked('HYGIENE_PAGE_BOUND')
        require(all(x==0 for x in self.counts().values()),'HYGIENE_CREDENTIALS_REMAIN')
        temporary='Synthetic-temporary-'+secrets.token_urlsafe(32)+'!'
        temporary_file=self.secret_file('restore-temporary-password',temporary)
        self.step('actual_synthetic_owner_password_reset')
        self.job('reset-owner',['scripts/reset-seller-password.js','synthetic_owner'],password=temporary_file.read_text().strip())
        self.accept(candidate,candidate)
        self.client('restore-finished',temporaryPassword=temporary_file.read_text().strip());self.pg_identity()
        return {'syntheticSnapshot':self.record['snapshot'],'restoredCredentialCounts':restored,'recoveryPages':pages,
                'actualPackagedCli':True,'trustedSyntheticPasswordReset':True,'productionDataUsed':False}

    def phase_E_off(self):
        self.client('fallback-marker')
        candidate=self.record['releases']['candidate'];old=self.record['releases']['previous'];controller=self.controller()
        epoch=digest((self.root/'mcp-control/epoch').read_bytes())
        controller.save('canary_pending_health_fault',pending=candidate,pending_kind=None)
        self.step('actual_activate_then_one_shot_health_failure')
        def health_fixture():
            controller.health(candidate)
            raise Blocked('SYNTHETIC_CONTROLLER_HEALTH_FAILURE')
        controller.activate(candidate)
        try:health_fixture()
        except Blocked as fault:
            require(str(fault)=='SYNTHETIC_CONTROLLER_HEALTH_FAILURE','UNEXPECTED_HEALTH_FAILURE')
            controller.restore(old);controller.health(old);controller.unpause()
            controller.save('canary_disabled_profile_fallback',current=old,previous=candidate)
        require(controller.state.get('profile_fallback') is True,'DURABLE_QUARANTINE')
        require(digest((self.root/'mcp-control/epoch').read_bytes())!=epoch,'FALLBACK_EPOCH_ROTATION')
        self.step('restarted_quarantine_no_implicit_activation');controller=self.controller();before_calls=self.guard.call_count;controller.poll();controller.recover_codec()
        require(controller.state.get('status')=='manual_profile_resume_required' and controller.state.get('profile_fallback') is True and
                self.guard.call_count==before_calls,'RESTARTED_QUARANTINE')
        value=self.guard.inspect(self.ns.app('backend'),self.raw)
        env=dict(x.split('=',1) for x in value.get('Config',{}).get('Env',[]))
        require(env.get('MCP_ENABLED')=='0' and not any(k.startswith('MCP_V2_') for k in env) and
                not any(x.get('Destination') in ('/run/mcp-codec','/run/mcp-control') for x in value.get('Mounts',[])),'OLD_BINARY_CLEAN_OFF')
        require(self.controller().supervisor().status().get('status')=='stopped','FALLBACK_CODEC_RETIRED')
        self.client('off');self.pg_identity()
        return {'sha':PREVIOUS,'actualOldBinaryOff':True,'profileFallback':True,'pendingEvidenceRetained':True,'commercePreserved':True,
                'failureFixture':'controller-health-after-real-health-success','epochRotated':True,'policy':self.policy_readback()}

    def cleanup(self):
        self.step('cleanup_only_nonce_owned_resources')
        existing=self.raw('ps','-a','--no-trunc','--filter','label='+PROJECT_LABEL+'='+self.ns.project,'--format','{{.Names}}').splitlines()
        if not self.guard.compose_hash:
            require(not existing,'UNRENDERED_PROJECT_EXISTS')
        elif (self.root/'images.env').exists() and (existing or (self.root/'mcp-codec').exists()):
            controller=self.controller()
            if (self.root/'mcp-codec').exists():
                controller.pause()
                if existing:controller.stop_clients(controller.compose({}))
                supervisor=controller.supervisor()
                if supervisor.status().get('status')!='absent':supervisor.stop(drained=True)
            else:controller.stop_clients(controller.compose({}))
        names=self.raw('ps','-a','--no-trunc','--filter','label='+PROJECT_LABEL+'='+self.ns.project,'--format','{{.Names}}').splitlines()
        for name in names:
            value=self.guard.inspect(name,self.raw);self.docker('rm','-f',value['Id'])
        for name in self.record['io'].get('codecs',{}):
            rows=self.raw('ps','-a','--no-trunc','--filter','name=^/'+name+'$','--format','{{.Names}}').splitlines()
            require(rows in ([],[name]),'CLEANUP_CODEC_AMBIGUOUS')
            if rows:
                value=self.guard.inspect(name,self.raw);self.docker('rm','-f',value['Id'])
        for kind,logical in [('network','edge'),('network','private'),('network','egress'),('volume','pg_data')]:
            name=self.ns.project+'_'+logical
            rows=self.raw(kind,'ls','--filter','name=^'+name+'$','--format','{{.Name}}').splitlines()
            require(rows in ([],[name]),'CLEANUP_RESOURCE_AMBIGUOUS')
            if rows:self.docker(kind,'rm',name)
        require(not self.raw('ps','-a','--filter','label='+PROJECT_LABEL+'='+self.ns.project,'--format','{{.ID}}').strip(),'CLEANUP_REMAINS')
        self.record['cleanup']={'status':'PASSED','privateEvidenceRetained':True};self.persist()

    def summary(self):
        controller=read_private(self.root/'state.json',1048576) if (self.root/'state.json').exists() else {}
        return {'version':1,'nonce':self.ns.nonce,'root':str(self.root),'phases':self.record['phases'],'step':self.record.get('step'),
                'cleanup':self.record.get('cleanup'),'controller':{'status':controller.get('status'),'currentSha':(controller.get('current') or {}).get('sha'),
                  'pending':bool(controller.get('pending')),'profileFallback':controller.get('profile_fallback') is True},
                'executionComplete':all(self.record['phases'].get(x,{}).get('status')=='PASSED' for x in PHASES)}

    def run(self,action):
        require(os.uname().machine in ('x86_64','amd64') or action in ('source','inspect'),'AMD64_HOST_REQUIRED')
        fd=os.open(self.root/'update.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'a') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise Blocked('UPDATE_LOCK_BUSY') from None
            self.lock=lock
            self.reload_checkpoint()
            if action=='inspect':return self.summary()
            if action=='cleanup':self.cleanup();return self.summary()
            require(action in PHASES,'PHASE')
            phase=self.record['phases'].get(action,{})
            if phase.get('status')=='PASSED':return self.summary()
            require(not phase and not any(x.get('status')!='PASSED' for x in self.record['phases'].values()),'INTERRUPTED_PHASE_INSPECT_OR_CLEANUP')
            require(all(self.record['phases'].get(x,{}).get('status')=='PASSED' for x in PHASES[:PHASES.index(action)]),'PHASE_PREREQUISITE_BLOCKED')
            require(not self.record.get('cleanup'),'CLEANED_CANARY')
            self.record['activePhase']=action;self.record['phases'][action]={'status':'RUNNING','startedAt':int(time.time())};self.persist()
            try:
                if action=='source':result=self.source()
                else:result=getattr(self,'phase_'+action.replace('-','_'))()
                available=int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))
                self.record['phases'][action].update(status='PASSED',finishedAt=int(time.time()),evidence=result,
                                                    resources={'memAvailableKiB':available,'diskFreeBytes':shutil.disk_usage(self.root).free});self.persist()
            except Exception as error:
                code=str(error) if isinstance(error,Blocked) and re.fullmatch('[A-Z_]{1,80}',str(error)) else type(error).__name__
                self.record['phases'][action].update(status='BLOCKED',code=code,finishedAt=int(time.time()));self.persist();raise
            return self.summary()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=(*PHASES,'inspect','cleanup'))
    parser.add_argument('--manifest',required=True,help='Root0600 input: reviewed exact SHA/digest/CI/policy/helper pins, no production secrets.')
    parser.add_argument('--source-root',required=True,help='Local reviewed source with the frozen policy hashes.')
    args=parser.parse_args()
    try:
        harness=Harness(read_private(args.manifest),args.source_root)
        result=harness.run(args.action);private_json(harness.root/'report.json',result)
        print(json.dumps(result,sort_keys=True))
    except Exception as error:
        code=str(error) if isinstance(error,Blocked) and re.fullmatch('[A-Z_]{1,80}',str(error)) else type(error).__name__
        print(json.dumps({'status':'BLOCKED','code':code}),file=sys.stderr);raise SystemExit(1) from None


if __name__=='__main__':main()
