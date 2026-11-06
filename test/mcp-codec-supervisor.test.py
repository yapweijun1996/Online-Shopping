"""Root-only synthetic lifecycle tests; never select a production root/container."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import sys
import fcntl

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('codec_supervisor', REPO / 'deploy/gcp/media-codec.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def manifest():
    return dict(version=1, image='sha256:' + '1' * 64, imageId='sha256:' + '1' * 64,
                revision='2' * 40, platform='linux/arm64', wireSha256='3' * 64,
                clientSha256='4' * 64, lockSha256='5' * 64)

class Validation(unittest.TestCase):
    def test_production_artifact_namespace_is_fixed_and_separate_from_config_identity(self):
        value = manifest(); value.update(image='ghcr.io/yapweijun1996/online-shopping-backend@sha256:' + '6' * 64, platform='linux/amd64')
        self.assertEqual(module.validate_manifest(value), value)
        for key, bad in [('image', value['image'].replace('online-shopping-backend', 'other')), ('imageId', '1'*64), ('platform', 'linux/arm64'), ('version', True), ('extra', 1)]:
            changed = dict(value); changed[key] = bad
            with self.assertRaises(module.CodecFailure): module.validate_manifest(changed)

class Fake(module.CodecSupervisor):
    """Only failure injection. Actual isolation/readiness is tested separately below."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs); self.container = None; self.removed = []; self.fail_run = None
    def _image(self, value): pass
    def _image_files(self, value): pass
    def docker(self, *args, **kwargs):
        if args[0] == 'ps':
            self.assert_query = args
            return '' if self.container is None else self.container['Id'] + ' ' + self.container['Name'][1:]
        if args[0] == 'inspect': return json.dumps(self.container)
        if args[0] == 'rm': self.removed.append(args[-1]); self.container = None; return args[-1]
        if args[0] == 'run':
            if self.fail_run != 'before':
                state = self.state()
                self.container = dict(Id='a'*64, Name='/'+state['container'], Image=state['manifest']['imageId'],
                    Config=dict(Labels={module.LABEL: state['owner'], 'shopping.mcp-codec.generation': state['generation']}))
            raise module.CodecFailure('INJECTED_CLIENT_FAILURE')
        raise AssertionError('Unexpected synthetic Docker command')

@unittest.skipUnless(os.geteuid() == 0 and os.environ.get('NODE_ENV') == 'test', 'Requires explicit root synthetic fixture')
class RootFixture(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='mcp-codec-test-', dir='/root')); self.root.chmod(0o700)
        self.lock = open(self.root/'update.lock', 'w'); os.chmod(self.root/'update.lock', 0o600)
        self.s = Fake(self.root, self.lock, test_mode=True)
        self.s.paused_path.write_text('paused\n'); self.s.paused_path.chmod(0o600)
    def tearDown(self):
        self.lock.close(); shutil.rmtree(self.root)
    def receipt(self, status='preparing'):
        value = dict(version=1, generation='g-'+'7'*32, owner='8'*32, container='shopping-mcp-codec-'+'7'*32, status=status, manifest=manifest())
        self.s._save(value); return value
    def test_failure_before_creation_is_proven_absent_and_recoverable_without_reusing_generation(self):
        self.s.fail_run = 'before'
        with self.assertRaisesRegex(module.CodecFailure, 'INJECTED_CLIENT_FAILURE'): self.s.prepare(manifest())
        old = self.s.state(); self.assertEqual(old['status'], 'stopped'); self.assertEqual(self.s.removed, [])
        self.assertNotIn('--filter=label', self.s.assert_query)
        with self.assertRaises(module.CodecFailure): self.s.prepare(manifest())
        self.assertNotEqual(old['generation'], self.s.state()['generation'])
        self.assertTrue((self.s.generations/old['generation']).exists())
    def test_lost_client_response_after_creation_only_removes_proven_owned_id(self):
        self.s.fail_run = 'after'
        with self.assertRaises(module.CodecFailure): self.s.prepare(manifest())
        self.assertEqual(self.s.removed, ['a'*64]); self.assertEqual(self.s.state()['status'], 'stopped')
    def test_reboot_preparing_absent_owned_and_foreign_name_are_distinguished(self):
        for presence in ['absent', 'owned', 'foreign']:
            state = self.receipt(); self.s.container = None; self.s.removed.clear()
            if presence != 'absent':
                self.s.container = dict(Id='b'*64, Name='/'+state['container'], Image=state['manifest']['imageId'], Config=dict(Labels={module.LABEL: state['owner'] if presence == 'owned' else 'foreign', 'shopping.mcp-codec.generation': state['generation']}))
            if presence == 'foreign':
                with self.assertRaisesRegex(module.CodecFailure, 'CONTAINER_OWNER'): self.s.preflight(manifest())
                with self.assertRaisesRegex(module.CodecFailure, 'CONTAINER_OWNER'): self.s.stop(drained=True)
                self.assertEqual(self.s.state()['status'], 'preparing'); self.assertEqual(self.s.removed, [])
            else:
                self.assertEqual(self.s.stop(drained=True)['status'], 'stopped')
                self.assertEqual(self.s.removed, ['b'*64] if presence == 'owned' else [])
    def test_capacity_and_manifest_preflight_cannot_stop_a_healthy_receipt(self):
        state = self.receipt('ready'); before = self.s.state_path.read_bytes()
        for i in range(63): (self.s.generations/('g-'+format(i, '032x'))).mkdir()
        with self.assertRaisesRegex(module.CodecFailure, 'MANUAL_MAINTENANCE_REQUIRED'): self.s.preflight(manifest(), 2)
        self.assertEqual(self.s.preflight(manifest(), 1)['capacityRemaining'], 1)
        (self.s.generations/('g-'+format(63, '032x'))).mkdir()
        for action in [lambda: self.s.preflight(manifest(), 1), lambda: self.s.replace(manifest(), drained=True)]:
            with self.assertRaisesRegex(module.CodecFailure, 'MANUAL_MAINTENANCE_REQUIRED'): action()
        self.assertEqual(self.s.state_path.read_bytes(), before); self.assertEqual(self.s.removed, [])
        for folder in self.s.generations.iterdir(): folder.rmdir()
        bad = manifest(); bad['unexpected'] = True
        with self.assertRaises(module.CodecFailure): self.s.replace(bad, drained=True)
        self.assertEqual(self.s.state_path.read_bytes(), before)
    def test_pause_and_drain_are_both_required_and_symlink_generation_is_rejected(self):
        self.receipt('ready')
        with self.assertRaisesRegex(module.CodecFailure, 'COORDINATED_DRAIN_REQUIRED'): self.s.stop()
        self.s.paused_path.unlink()
        with self.assertRaisesRegex(module.CodecFailure, 'COORDINATED_DRAIN_REQUIRED'): self.s.stop(drained=True)
        (self.s.generations/('g-'+'0'*32)).symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(module.CodecFailure, 'MANUAL_MAINTENANCE_REQUIRED'): self.s.preflight(manifest())
    def test_docker_stdout_is_capped_by_child_file_limit_before_parent_reads(self):
        original = subprocess.run
        def oversized(arguments, **options):
            self.assertNotEqual(options['stdout'], subprocess.PIPE)
            return original([sys.executable,'-c',"import os;os.write(1,b'x'*300000);os.write(1,b'y')"],**options)
        with patch.object(module.subprocess,'run',side_effect=oversized):
            with self.assertRaisesRegex(module.CodecFailure,'DOCKER_IMAGE'): module.CodecSupervisor.docker(self.s,'image','inspect')
        self.assertEqual(list(self.s.base.glob('.codec-*')),[])
    def test_artifact_probe_lost_run_response_cleans_only_exact_proven_owned_container(self):
        original = self.s.docker
        def lost(*args, **kwargs):
            if args[0] != 'run': return original(*args,**kwargs)
            name=args[args.index('--name')+1]
            labels=[args[i+1].split('=',1) for i,value in enumerate(args) if value=='--label']
            self.s.container=dict(Id='c'*64,Name='/'+name,Image=manifest()['imageId'],Config=dict(Labels=dict(labels)))
            raise module.CodecFailure('INJECTED_CLIENT_FAILURE')
        self.s.docker=lost
        with self.assertRaisesRegex(module.CodecFailure,'INJECTED_CLIENT_FAILURE'): module.CodecSupervisor._image_files(self.s,manifest())
        self.assertEqual(self.s.removed,['c'*64]);self.assertFalse(self.s.state_path.exists())
    def test_cli_busy_lock_and_automatic_pause_never_start_or_create_generations(self):
        command=[sys.executable,str(REPO/'deploy/gcp/media-codec.py'),'status','--root',str(self.root),'--test-local-image','--automatic']
        for barrier in ['lock','pause']:
            if barrier=='pause': fcntl.flock(self.lock,fcntl.LOCK_UN)
            result=subprocess.run(command,env={**os.environ,'NODE_ENV':'test'},capture_output=True,text=True,timeout=5,check=True)
            self.assertEqual(json.loads(result.stdout),dict(version=1,ready=False,status='paused'))
            self.assertFalse(self.s.state_path.exists());self.assertEqual(list(self.s.generations.iterdir()),[])
    def test_overlong_future_socket_path_is_rejected_before_any_service_is_stopped(self):
        deep=self.root/('x'*80);deep.mkdir(mode=0o700)
        with open(deep/'update.lock','w') as lock:
            (deep/'update.lock').chmod(0o600)
            supervisor=Fake(deep,lock,test_mode=True)
            with self.assertRaisesRegex(module.CodecFailure,'SOCKET_PATH_LIMIT'): supervisor.preflight(manifest())
            self.assertFalse(supervisor.state_path.exists());self.assertEqual(list(supervisor.generations.iterdir()),[])

@unittest.skipUnless(os.geteuid() == 0 and os.environ.get('MEDIA_CODEC_SUPERVISOR_TEST') == '1', 'Actual owned Docker lifecycle opt-in')
class NativeLifecycle(unittest.TestCase):
    def test_actual_native_generation_crash_replace_and_readonly_seal(self):
        root = Path(tempfile.mkdtemp(prefix='mcp-codec-test-', dir='/root')); root.chmod(0o700)
        lock = open(root/'update.lock', 'w'); os.chmod(root/'update.lock', 0o600)
        supervisor = module.CodecSupervisor(root, lock, test_mode=True)
        value = manifest(); image = (REPO/'.local/media-codec-image-id').read_text().strip()
        actual = json.loads(subprocess.check_output(['docker','--host=unix:///var/run/docker.sock','image','inspect','--format={{json .}}',image]))
        value.update(image=image,imageId=image,platform=actual['Os']+'/'+actual['Architecture'])
        for key, path in [('wireSha256','src/mcp/media-codec-wire.js'),('clientSha256','src/mcp/media-codec-client.js'),('lockSha256','media-codec/package-lock.json')]: value[key] = hashlib.sha256((REPO/path).read_bytes()).hexdigest()
        try:
            first = supervisor.prepare(value); self.assertTrue(first['ready']); self.assertEqual(supervisor.probe(), first)
            state = supervisor.state(); folder = Path(first['generationPath']); token_hash = hashlib.sha256((folder/'token').read_bytes()).hexdigest()
            socket_identity = (folder/'socket/codec.sock').stat().st_ino
            self.assertEqual(stat.S_IMODE((folder/'socket').stat().st_mode), 0o710)
            owned = supervisor._owned(state); self.assertIn('NODE_ENV=production', owned['Config']['Env'])
            self.assertEqual(len(owned['Mounts']),2); self.assertEqual(supervisor.preflight(value,2)['capacityRemaining'],63)
            # A separate UID1000 backend-side process sees only a RO generation.
            # This calls actual authenticated readiness, never the native decoder.
            nonce = os.urandom(16).hex()
            probe = dict(generation='g-'+nonce, owner=os.urandom(16).hex(), container='shopping-mcp-codec-'+nonce, manifest=value)
            program = "import fs from 'node:fs';import{probeCodecViaSocket}from'/src/mcp/media-codec-client.js';let ro=false;try{fs.chmodSync('/snapshot/socket',0o730)}catch(e){ro=e.code==='EROFS'}if(!ro)throw Error('Writable generation');await probeCodecViaSocket({socketPath:'/snapshot/socket/codec.sock',token:fs.readFileSync('/snapshot/token','utf8')});console.log('READ_ONLY_READY');"
            try:
                result = supervisor.docker('run','--rm','--pull=never',*supervisor._container_args(probe),'--user=1000:1000','--mount','type=bind,src='+str(folder)+',dst=/snapshot,readonly','--entrypoint=node',image,'--input-type=module','-e',program)
                self.assertEqual(result,'READ_ONLY_READY')
            finally:
                identity=supervisor._lookup(probe)
                if identity is not None: supervisor.docker('rm','-f',supervisor._identity(probe,identity)['Id'])
            # No generation or active receipt change occurs during full artifact preflight.
            self.assertEqual(supervisor.state(), state)
            wrong = dict(value, wireSha256='0'*64)
            with self.assertRaisesRegex(module.CodecFailure,'IMAGE_FILES'): supervisor.preflight(wrong)
            self.assertTrue(supervisor.probe()['ready'])
            supervisor.docker('kill','--signal=KILL',first['container'])
            self.assertFalse(supervisor.status()['ready'])
            with self.assertRaisesRegex(module.CodecFailure,'COORDINATED_DRAIN_REQUIRED'): supervisor.replace(value,drained=True)
            supervisor.paused_path.write_text('paused\n'); supervisor.paused_path.chmod(0o600)
            second = supervisor.replace(value,drained=True); self.assertTrue(second['ready']); self.assertNotEqual(first['generation'],second['generation'])
            self.assertEqual(stat.S_IMODE((folder/'socket').stat().st_mode),0o710)
            self.assertEqual(hashlib.sha256((folder/'token').read_bytes()).hexdigest(),token_hash)
            self.assertEqual((folder/'socket/codec.sock').stat().st_ino,socket_identity)
            self.assertNotEqual(hashlib.sha256((Path(second['generationPath'])/'token').read_bytes()).hexdigest(),token_hash)
            self.assertEqual(supervisor.stop(drained=True)['status'],'stopped')
        finally:
            if supervisor.state_path.exists():
                supervisor.paused_path.write_text('paused\n'); supervisor.paused_path.chmod(0o600); supervisor.stop(drained=True)
            lock.close(); shutil.rmtree(root)

if __name__ == '__main__': unittest.main(verbosity=2)
