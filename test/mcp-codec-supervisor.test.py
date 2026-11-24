"""Root-only synthetic lifecycle tests; never select a production root/container."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import tempfile
import time
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

class Reaping(unittest.TestCase):
    """Real filesystem operations; only the root installation and Docker are stubbed."""
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='c-', dir='/tmp')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.s = object.__new__(module.CodecSupervisor)
        self.s.root = self.root
        self.s.base = self.root / 'mcp-codec'
        self.s.generations = self.s.base / 'generations'
        self.s.generations.mkdir(parents=True)
        self.s.state_path = self.s.base / 'state.json'
        self.s.paused_path = self.s.base / 'paused'
        self.s.lock_file = (self.root / 'update.lock').open('w')
        self.addCleanup(self.s.lock_file.close)
        fcntl.flock(self.s.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.s.test_mode = True
        self.containers = {}
        self.start = time.time_ns() + 3600 * 10**9
        self.now = self.start + 2 * module.GENERATION_MIN_AGE_NS
        self.log = io.StringIO()
        for target, attribute, options in [
            (module, 'trusted', dict(side_effect=lambda path, **opts: Path(path))),
            (module.sys, 'stderr', dict(new=self.log)),
            (module.time, 'time_ns', dict(return_value=self.now)),
            (self.s, '_image', {}), (self.s, '_image_files', {}),
            (self.s, 'docker', dict(side_effect=self.docker)),
        ]:
            mock = patch.object(target, attribute, **options)
            mock.start()
            self.addCleanup(mock.stop)

    def docker(self, *args):
        if args == ('ps', '-a', '--no-trunc', '--format={{.ID}}'):
            return '\n'.join(self.containers)
        if args[:3] == ('ps', '-a', '--no-trunc') and '--filter' in args:
            return ''  # Exact-name lookup for the synthetic, stopped state receipt.
        self.assertEqual(args[:2], ('inspect', '--type=container'))
        self.assertEqual(set(args[3:]), set(self.containers))
        return '\n'.join(json.dumps([identity, *row]) for identity, row in self.containers.items())

    def generation(self, index):
        return self.s.generations / ('g-' + format(index, '032x'))

    def populate(self, count):
        for index in range(count):
            self.generation(index).mkdir(mode=0o700)
            self.age(index)

    def age(self, index, ns=None):
        stamp = ns if ns is not None else self.start + index * 10**9
        os.utime(self.generation(index), ns=(stamp, stamp))

    def survivors(self):
        return sorted(int(path.name[2:], 16) for path in self.s.generations.iterdir())

    def test_preflight_reaps_oldest_inactive_and_reserves_forward_and_rollback(self):
        self.populate(64)
        # Exercise the exact layout, including a real Unix socket, without reading the token.
        old = self.generation(2)
        (old / 'socket').mkdir(mode=0o710)
        (old / 'token').write_text('synthetic fixture')
        with socket.socket(socket.AF_UNIX) as worker:
            worker.bind(str(old / 'socket/codec.sock'))
        self.age(2)
        current = self.generation(0).name
        self.s._save(dict(version=1, generation=current, owner='1'*32, status='stopped',
                          container='shopping-mcp-codec-' + current[2:], manifest=manifest()))
        module.atomic(self.root / 'state.json', {
            'current': {'codec_generation': self.generation(1).name},
            'previous': {'codec_generation': self.generation(3).name},
            'pending': {'codec_generation': self.generation(4).name},
        })
        self.assertFalse(self.s.paused_path.exists())
        receipt = self.s.preflight(manifest())
        self.assertEqual(self.survivors(), [0, 1, 3, 4, *range(56, 64)])
        self.assertEqual(receipt['capacityRemaining'], 52)
        self.assertEqual(receipt['reservedGenerations'], 2)
        self.assertEqual(self.s.state()['generation'], current)
        self.assertEqual(self.log.getvalue(), 'CODEC_GENERATIONS_REAPED\n')

    def test_busy_update_lock_prevents_reaping(self):
        self.populate(12)
        fcntl.flock(self.s.lock_file, fcntl.LOCK_UN)
        with (self.root / 'update.lock').open('w') as other:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(module.CodecFailure, '^UPDATE_BUSY$'):
                self.s.preflight(manifest())
        self.assertEqual(self.survivors(), list(range(12)))
        self.s.docker.assert_not_called()

    def test_recent_or_future_generation_is_kept_even_outside_newest_eight(self):
        self.populate(12)
        cutoff = self.now - module.GENERATION_MIN_AGE_NS
        for index in range(3, 12):
            self.age(index, cutoff + index * 10**9)
        self.age(2, cutoff - 1)
        self.age(11, self.now + 10**9)
        self.s.preflight(manifest())
        self.assertEqual(self.survivors(), list(range(3, 12)))

    def test_mount_name_and_label_pin_containers_even_with_pause_marker(self):
        self.populate(16)
        self.s.paused_path.write_text('paused\n')
        # Includes the backend's whole generation bind and the worker's socket
        # or token bind. Neither needs a recognized container label or name.
        self.containers = {
            'a'*64: ['/unlabelled-backend', '', [{'Type': 'bind', 'Source': str(self.generation(0))}]],
            'b'*64: ['/unlabelled-worker', '', [{'Type': 'bind', 'Source': str(self.generation(1) / 'socket')}]],
            'c'*64: ['/other-worker', self.generation(2).name, []],
            'd'*64: ['/shopping-mcp-codec-' + self.generation(3).name[2:], '', []],
            'e'*64: ['/unrelated', '', [{'Type': 'bind', 'Source': str(self.generation(4)) + '-other'}]],
        }
        self.s.preflight(manifest())
        self.assertEqual(self.survivors(), [0, 1, 2, 3, *range(8, 16)])

    def test_capacity_fails_closed_when_all_generations_are_in_use(self):
        self.populate(64)
        self.containers = {'a'*64: ['/backend', '', [{'Type': 'bind', 'Source': str(self.generation(i))}
                                                     for i in range(64)]]}
        for reserve in (1, 2):
            with self.assertRaisesRegex(module.CodecFailure, '^MANUAL_MAINTENANCE_REQUIRED$'):
                self.s.preflight(manifest(), reserve)
        self.assertEqual(self.survivors(), list(range(64)))

    def test_ancestor_mount_preserves_entire_inventory(self):
        self.populate(12)
        self.containers = {'a'*64: ['/backend', '', [{'Type': 'bind', 'Source': str(self.s.base)}]]}
        self.s.preflight(manifest())
        self.assertEqual(self.survivors(), list(range(12)))

    def test_incomplete_docker_inventory_or_bad_pin_cannot_authorize_deletion(self):
        self.populate(64)
        commands = [('a'*64, ''), ('a'*64, subprocess.TimeoutExpired('private args', 1)), ('private output',)]
        for outputs in commands:
            with self.subTest(outputs=outputs), patch.object(self.s, 'docker', side_effect=outputs):
                with self.assertRaisesRegex(module.CodecFailure, '^MANUAL_MAINTENANCE_REQUIRED$'):
                    self.s.preflight(manifest())
        module.atomic(self.root / 'state.json', {'previous': {'codec_generation': 'private invalid pin'}})
        with self.assertRaisesRegex(module.CodecFailure, '^MANUAL_MAINTENANCE_REQUIRED$'):
            self.s.preflight(manifest())
        self.assertEqual(self.survivors(), list(range(64)))
        self.assertEqual(self.log.getvalue().splitlines(),
                         ['CODEC_REAP_DOCKER_UNVERIFIED'] * 3 + ['CODEC_REAP_RELEASE_PINS_UNVERIFIED'])

    def test_top_level_symlink_and_odd_name_fail_closed_before_deletion(self):
        self.populate(12)
        target = self.root / 'outside'
        target.mkdir(); (target / 'token').write_text('do not touch')
        link = self.generation(12)
        link.symlink_to(target, target_is_directory=True)
        odd = self.s.generations / 'unexpected'
        for entry in (link, odd):
            if entry == odd: odd.mkdir()
            with self.assertRaisesRegex(module.CodecFailure, '^MANUAL_MAINTENANCE_REQUIRED$'):
                self.s.preflight(manifest())
            self.assertTrue(entry.exists())
            self.assertTrue(all(self.generation(i).is_dir() for i in range(12)))
            self.assertEqual((target / 'token').read_text(), 'do not touch')
            if entry == link: link.unlink()

    def test_nested_symlinks_and_unexpected_entries_preserve_candidates(self):
        self.populate(16)
        target = self.root / 'outside'
        target.mkdir(); (target / 'token').write_text('do not touch')
        (self.generation(0) / 'socket').symlink_to(target, target_is_directory=True)
        (self.generation(1) / 'token').symlink_to(target / 'token')
        (self.generation(2) / 'unexpected').mkdir()
        (self.generation(3) / 'socket').mkdir()
        (self.generation(3) / 'socket/codec.sock').symlink_to(target / 'token')
        sockets = self.generation(4) / 'socket'
        sockets.mkdir()
        with socket.socket(socket.AF_UNIX) as worker:
            worker.bind(str(sockets / 'codec.sock'))
        (sockets / 'unexpected').touch()
        for index in range(5): self.age(index)
        self.s.preflight(manifest())
        self.assertEqual(self.survivors(), [0, 1, 2, 3, 4, *range(8, 16)])
        self.assertTrue((sockets / 'codec.sock').is_socket())
        self.assertEqual((target / 'token').read_text(), 'do not touch')
        self.assertEqual(self.log.getvalue().splitlines(), ['CODEC_REAP_UNSAFE_GENERATION', 'CODEC_GENERATIONS_REAPED'])

    def test_same_device_mount_boundary_preserves_the_candidate(self):
        self.populate(12)
        nested = self.generation(0) / 'socket'
        nested.mkdir()
        (self.generation(0) / 'token').write_text('synthetic fixture')
        self.age(0)
        identity = module.inode(nested.lstat())
        with patch.object(module, 'mount_id', side_effect=lambda fd: int(module.inode(os.fstat(fd)) == identity)):
            self.s.preflight(manifest())
        self.assertEqual(self.survivors(), [0, *range(4, 12)])
        self.assertTrue(nested.is_dir())
        self.assertTrue((self.generation(0) / 'token').is_file())


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
