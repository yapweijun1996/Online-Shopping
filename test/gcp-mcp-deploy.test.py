#!/usr/bin/env python3
"""Offline production-profile release contracts. No Docker, registry or live data."""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gcp_update', ROOT / 'deploy/gcp/update.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
SHA = 'a' * 40
ID = 'sha256:' + '1' * 64
BASE = 'SHOP_HOST=shop.example\nSELLER_HOST=seller.example\nADMIN_USERNAME=owner\nSECRETS_DIR=/opt/secrets\n'
ON = 'MCP_ENABLED=1\nMCP_REDIRECT_URIS=https://client.example/callback\nMCP_V2_PRODUCTION_PROFILE=seller-operations-v1\n' + ''.join(key + '=1\n' for key in u.MCP_FLAGS)

def manifest():
    return dict(version=1,image='ghcr.io/yapweijun1996/online-shopping-backend@sha256:' + '2'*64,
                imageId=ID,revision=SHA,platform='linux/amd64',**{key:'3'*64 for key in u.CODEC_FILES})

def release():
    return dict(sha=SHA,baseline={},backend='ghcr.io/yapweijun1996/online-shopping-backend@sha256:'+'4'*64,
                frontend='ghcr.io/yapweijun1996/online-shopping-frontend@sha256:'+'5'*64,
                mcp=dict(version=1,profile=u.PROFILE,backendIdentity=ID,codec=manifest()))

class Tests(unittest.TestCase):
    def test_profile_is_complete_or_disabled_and_identity_is_not_runtime_input(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root,'runtime.env'); f=u.Updater(root)
            p.write_text(BASE); self.assertFalse(f.mcp_enabled())
            p.write_text(BASE+ON); self.assertTrue(f.mcp_enabled())
            bad=[ON.replace(key+'=1\n',key+'=0\n') for key in ('MCP_ENABLED',*u.MCP_FLAGS)]
            bad += ['MCP_V2_PRODUCTION_PROFILE=\n', 'MCP_V2_ENABLED=1\n', ON+'MCP_V2_BACKEND_IDENTITY='+ID+'\n',
                    ON+'MCP_GENERATION_PATH=/tmp/untrusted\n',ON+'MCP_V2_MEDIA_SOCKET_PATH=/tmp/x\n']
            for value in bad:
                p.write_text(BASE+value)
                with self.assertRaises(ValueError): f.runtime()

    def test_initial_bootstrap_rejects_on_before_any_release_or_container_work(self):
        with tempfile.TemporaryDirectory() as root:
            f=u.Updater(root);Path(root,'runtime.env').write_text(BASE+ON)
            with patch.object(f,'head') as head,patch.object(f,'release') as pull,patch.object(f,'docker') as docker:
                with self.assertRaisesRegex(ValueError,'Initialize requires the disabled'):f.initialize(SHA)
                head.assert_not_called();pull.assert_not_called();docker.assert_not_called()
            self.assertFalse(Path(root,'images.env').exists());self.assertFalse(Path(root,'state.json').exists())

    def test_closed_codec_and_backend_release_binding(self):
        with tempfile.TemporaryDirectory() as root:
            f=u.Updater(root); f.validate_release(release())
            for field,value in [('image','evil/image:latest'),('imageId','latest'),('revision','b'*40),('platform','linux/arm64'),('wireSha256','3'*63)]:
                r=release(); r['mcp']['codec'][field]=value
                with self.assertRaises(ValueError): f.validate_release(r)
            for mutate in [lambda r:r['mcp'].update(extra=True),lambda r:r['mcp']['codec'].update(extra=True),
                           lambda r:r['mcp'].update(backendIdentity='not-an-id'),lambda r:r['mcp']['codec'].update(image=r['backend'])]:
                r=release();mutate(r)
                with self.assertRaises(ValueError):f.validate_release(r)

    def test_publisher_identity_requires_actual_file_hash_labels_and_platform(self):
        with tempfile.TemporaryDirectory() as root:
            f=u.Updater(root); content={path:path.encode() for path in u.CODEC_FILES.values()}
            labels={'org.opencontainers.image.title':'online-shopping-media-codec','org.opencontainers.image.source':'https://github.com/'+u.REPO,'org.opencontainers.image.revision':SHA}
            for name,key in [('wire','wireSha256'),('client','clientSha256'),('lock','lockSha256')]:
                labels['shopping.media.'+name+'.sha256']=hashlib.sha256(content[u.CODEC_FILES[key]]).hexdigest()
            info=dict(Id=ID,Os='linux',Architecture='amd64',Config=dict(Labels=labels),RepoDigests=[manifest()['image']])
            with patch.object(f,'docker',side_effect=['',json.dumps(info)]) as docker:
                actual=f.codec_image(SHA,content)
            self.assertEqual(ID,actual['imageId']);self.assertEqual(SHA,actual['revision'])
            self.assertEqual('ghcr.io/yapweijun1996/online-shopping-backend:media-codec-'+SHA,docker.call_args_list[0].args[-1])
            for key in labels:
                bad=json.loads(json.dumps(info));bad['Config']['Labels'][key]='wrong'
                with patch.object(f,'docker',side_effect=['',json.dumps(bad)]):
                    with self.assertRaises(ValueError): f.codec_image(SHA,content)

    def test_source_verifies_every_boundary_blob_without_commit_tree_sha_assumption(self):
        with tempfile.TemporaryDirectory() as root:
            f=u.Updater(root); paths=(*u.MOUNTS,'src/db.js',*u.CODEC_FILES.values())
            content={p:(b'export const SCHEMA_VERSION = 34;' if p=='src/db.js' else p.encode()) for p in paths}
            entries=[dict(path=p,type='blob',mode='100644',sha=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()) for p,b in content.items()]
            with patch.object(u,'api',return_value=dict(sha=SHA,truncated=False,tree=entries)),patch.object(u,'request',side_effect=lambda url:content[url.split('/'+SHA+'/')[1]]):
                baseline,actual=f.source(SHA)
            self.assertEqual(34,baseline['schema']);self.assertEqual(content,actual)
            with patch.object(u,'api',return_value=dict(tree=entries)),patch.object(u,'request',return_value=b'corrupt'):
                with self.assertRaisesRegex(ValueError,'Source digest mismatch'): f.source(SHA)

    @unittest.skipUnless(shutil.which('docker'), 'Docker Compose parser is required')
    def test_real_compose_initial_stop_parses_legacy_images_without_target_generation(self):
        with tempfile.TemporaryDirectory() as root:
            f=u.Updater(root)
            Path(root,'compose.yaml').write_bytes((ROOT/'compose.gcp.yaml').read_bytes())
            Path(root,'compose.mcp.yaml').write_bytes((ROOT/'deploy/gcp/compose.mcp.yaml').read_bytes())
            Path(root,'runtime.env').write_text(BASE+ON)
            Path(root,'images.env').write_text('BACKEND_IMAGE='+release()['backend']+'\nFRONTEND_IMAGE='+release()['frontend']+'\nAPP_REVISION='+SHA+'\nRELEASE_DIR='+root+'/releases/'+SHA+'\n')
            env={'PATH':os.environ['PATH'],'HOME':root}
            args=f.compose({})+['config','--format','json']
            output=subprocess.run(['docker',*args],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False,timeout=15)
            self.assertEqual(0,output.returncode)
            self.assertNotIn('MCP_V2_PRODUCTION_PROFILE',json.loads(output.stdout)['services']['backend']['environment'])
            self.assertNotIn(str(Path(root,'compose.mcp.yaml')),args)
            with patch.object(u,'trusted',side_effect=lambda p:Path(p)):
                target=subprocess.run(['docker',*f.compose(release()),'config','--format','json'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False,timeout=15)
            self.assertNotEqual(0,target.returncode) # Target overlay correctly requires the not-yet-created tuple.

    def test_overlay_is_explicit_readonly_directory_mount_and_off_base_has_no_selector(self):
        base=(ROOT/'compose.gcp.yaml').read_text(); overlay=(ROOT/'deploy/gcp/compose.mcp.yaml').read_text()
        self.assertNotIn('MCP_V2_PRODUCTION_PROFILE:',base)
        self.assertNotIn('/run/mcp-codec',base)
        self.assertIn('MCP_V2_PRODUCTION_PROFILE: seller-operations-v1',overlay)
        self.assertEqual(2,overlay.count('create_host_path: false'))
        self.assertEqual(2,overlay.count('read_only: true'))
        self.assertIn('target: /run/mcp-control\n',overlay)
        for path in ('src/mcp/deployment-profile.js','src/mcp/media-codec-client.js','media-codec/src/main.js','src/server.js'):
            self.assertTrue(path.startswith(u.PROTECTED))

class Supervisor:
    def __init__(self, calls, root): self.calls=calls; self.root=Path(root); self.ready=True; self.capacity=False
    def preflight(self, manifest, reserve_generations=2):
        self.calls.append(('preflight',reserve_generations))
        if self.capacity: raise RuntimeError('MANUAL_MAINTENANCE_REQUIRED')
    def status(self): return dict(status='ready',ready=self.ready)
    def stop(self,drained=False): self.calls.append(('retire',drained))
    def prepare(self,manifest): self.calls.append(('prepare',manifest['imageId']));return self.probe()
    def probe(self):
        return dict(version=1,ready=True,status='ready',generation='g-'+'6'*32,
                    generationPath=str(self.root/'mcp-codec/generations'/('g-'+'6'*32)),
                    image=manifest()['image'],imageId=ID,revision=SHA)

class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.calls=[];self.f=u.Updater(self.root);self.sup=Supervisor(self.calls,self.root)
        self.secrets=self.root/'secrets';self.secrets.mkdir()
        for name in ('admin-password','postgres-password','integration-keys','platform-password','provisioner-password',
                     'whatsapp-qr-token','whatsapp-qr-token-slot1','whatsapp-qr-bindings.json','ai-api-key'):
            (self.secrets/name).write_text('synthetic fixture')
        (self.root/'runtime.env').write_text(BASE.replace('/opt/secrets',str(self.secrets))+ON)
        (self.root/'compose.yaml').write_text('fixture')
        (self.root/'compose.mcp.yaml').write_text('fixture')
        (self.root/'mcp-codec').mkdir()
        self.addCleanup(patch.stopall)
        patch.object(u,'trusted',side_effect=lambda p,**kw:Path(p)).start()
        patch.object(self.f,'supervisor',return_value=self.sup).start()
        patch.object(self.f,'wait_backend',side_effect=lambda item:self.calls.append(('backend-ready',item['sha']))).start()
        self.epoch=patch.object(self.f,'epoch_control',side_effect=lambda rotate=False:self.calls.append(('epoch',rotate))).start()
        patch.object(self.f,'docker',side_effect=self.docker).start()
    def docker(self,*args,**kwargs):
        self.calls.append(('docker',args))
        if args[:2]==('image','inspect'):
            return json.dumps(dict(Id=ID,Os='linux',Architecture='amd64',RepoDigests=[release()['backend']],
                         Config=dict(Labels={'org.opencontainers.image.revision':SHA,'org.opencontainers.image.source':'https://github.com/'+u.REPO})))
        return ''
    def test_preflight_capacity_failure_never_stops_running_clients(self):
        self.sup.capacity=True
        with self.assertRaisesRegex(RuntimeError,'MANUAL_MAINTENANCE_REQUIRED'):self.f.activate(release())
        self.assertFalse(any('stop' in call[1] for call in self.calls if call[0]=='docker'))
        self.assertFalse((self.root/'mcp-codec/paused').exists())
        self.assertFalse((self.root/'images.env').exists())
    def test_forward_fresh_generation_and_force_recreate_after_all_clients_stopped(self):
        self.f.activate(release())
        pre=self.calls.index(('preflight',2));ret=self.calls.index(('retire',True));prep=self.calls.index(('prepare',ID))
        stops=[(i,c[1]) for i,c in enumerate(self.calls) if c[0]=='docker' and 'stop' in c[1]]
        self.assertLess(pre,stops[0][0]);self.assertNotIn(str(self.root/'compose.mcp.yaml'),stops[0][1]);self.assertNotIn(str(self.root/'compose.mcp.yaml'),stops[1][1]);self.assertEqual('frontend',stops[0][1][-1]);self.assertEqual('backend',stops[1][1][-1])
        self.assertLess(stops[1][0],ret);self.assertLess(ret,prep)
        self.assertNotIn(('epoch',True),self.calls)
        env=(self.root/'images.env').read_text();self.assertIn('MCP_BACKEND_IDENTITY='+ID,env)
        self.assertIn('MCP_GENERATION_PATH='+str(self.root/'mcp-codec/generations'/('g-'+'6'*32)),env)
        up=[c[1] for c in self.calls if c[0]=='docker' and 'up' in c[1]][0]
        self.assertIn(str(self.root/'compose.mcp.yaml'),up);self.assertIn('--force-recreate',up)
        self.assertNotIn('postgres',up);self.assertTrue(self.f.paused())
        frontend=[i for i,c in enumerate(self.calls) if c[0]=='docker' and 'up' in c[1] and c[1][-1]=='frontend'][0]
        self.assertLess(self.calls.index(('backend-ready',SHA)),frontend)
    def test_rollback_reserves_one_rotates_then_retires_and_never_reuses_generation(self):
        self.f.restore(release())
        self.assertIn(('preflight',1),self.calls)
        self.assertLess(self.calls.index(('epoch',True)),self.calls.index(('retire',True)))
        self.assertFalse(self.f._rollback)
    def test_disabled_initial_fallback_has_clean_base_and_no_profile_env(self):
        disabled=release();del disabled['mcp']
        self.f.state.update(current=disabled,pending=release())
        self.f.restore(disabled)
        self.assertIn(('epoch',True),self.calls)
        self.assertFalse(any(c[0]=='prepare' for c in self.calls))
        env=(self.root/'images.env').read_text();self.assertIn('MCP_ENABLED=0\n',env)
        self.assertNotIn('MCP_BACKEND_IDENTITY',env)
        self.assertTrue(self.f.state['profile_fallback'])
        up=[c[1] for c in self.calls if c[0]=='docker' and 'up' in c[1]][0]
        self.assertNotIn(str(self.root/'compose.mcp.yaml'),up)
        self.assertIn('--force-recreate',up)
    def test_disabled_fallback_survives_restart_and_blocks_poll_and_codec_recovery(self):
        disabled=release();del disabled['mcp']
        self.f.state.update(current=disabled,pending=release(),local={})
        self.f.restore(disabled)
        self.f.unpause()
        restarted=u.Updater(self.root)
        with patch.object(restarted,'local_fingerprint',return_value={}),patch.object(restarted,'head') as head,patch.object(restarted,'activate') as activate:
            restarted.poll();restarted.recover_codec()
            head.assert_not_called();activate.assert_not_called()
        self.assertEqual('manual_profile_resume_required',restarted.state['status'])
        self.assertTrue(restarted.state['profile_fallback'])
        self.assertEqual(release(),restarted.state['pending'])

    def test_remaining_backend_writer_prevents_worker_retirement(self):
        original=self.docker
        def active(*args,**kwargs):
            if args[0]=='ps' and args[-1].endswith('backend'):return 'unexpected-second-backend'
            return original(*args,**kwargs)
        self.f.docker=active
        with self.assertRaisesRegex(ValueError,'writers remain'):self.f.activate(release())
        self.assertFalse(any(c[0]=='retire' for c in self.calls))
        self.assertTrue(self.f.paused())
    def test_recovery_respects_pause_and_keeps_epoch_for_fresh_generation(self):
        self.f.pause();self.f.recover_codec();self.assertEqual('codec_paused',self.f.state['status'])
        self.assertFalse(self.calls)
        self.f.unpause();self.f.state.update(current=release(),local={});self.sup.ready=False
        with patch.object(self.f,'local_fingerprint',return_value={}),patch.object(self.f,'health'):
            self.f.recover_codec()
        self.assertEqual('codec_recovered',self.f.state['status'])
        self.assertNotIn(('epoch',True),self.calls);self.assertFalse(self.f.paused())

    def test_failed_recovery_keeps_pause_and_pending_without_image_or_epoch_rollback(self):
        self.f.state.update(current=release(),local={});self.sup.ready=False
        with patch.object(self.f,'local_fingerprint',return_value={}),patch.object(self.f,'health',side_effect=RuntimeError('synthetic health failure')):
            with self.assertRaises(RuntimeError):self.f.recover_codec()
            self.assertEqual('codec-recovery',self.f.state['pending_kind'])
            self.assertTrue(self.f.paused())
            count=len(self.calls);self.f.poll();self.assertEqual(count,len(self.calls))
        self.assertEqual('codec_manual_maintenance_required',self.f.state['status'])
        self.assertNotIn(('epoch',True),self.calls)
    def test_recovery_budget_preserves_running_backend_on_fourth_crash(self):
        self.f.state.update(current=release(),local={},codec_recoveries=[100,101,102]);self.sup.ready=False
        with patch.object(self.f,'local_fingerprint',return_value={}),patch.object(u.time,'time',return_value=103):
            self.f.recover_codec()
        self.assertEqual('codec_manual_maintenance_required',self.f.state['status'])
        self.assertFalse(any(c[0]=='docker' for c in self.calls))
        self.assertFalse(self.f.paused())
    def test_backend_health_failure_never_starts_frontend(self):
        with patch.object(self.f,'wait_backend',side_effect=RuntimeError('synthetic readiness failure')):
            with self.assertRaises(RuntimeError):self.f.activate(release())
        self.assertTrue(self.f.paused())
        self.assertFalse(any(c[0]=='docker' and 'up' in c[1] and c[1][-1]=='frontend' for c in self.calls))
    def test_running_capable_image_with_off_or_mismatched_profile_is_not_healthy(self):
        env={'NODE_ENV':'production','MCP_ENABLED':'1',**{key:'1' for key in u.MCP_FLAGS},
             'MCP_V2_PRODUCTION_PROFILE':u.PROFILE,'MCP_V2_BACKEND_IDENTITY':ID,
             'MCP_V2_MEDIA_CODEC_IDENTITY':ID,'MCP_V2_EPOCH_FILE':'/run/mcp-control/epoch',
             'MCP_V2_MEDIA_SOCKET_PATH':'/run/mcp-codec/socket/codec.sock','MCP_V2_MEDIA_TOKEN_FILE':'/run/mcp-codec/token',
             'TRUST_PROXY':'1','SHOP_MODE':'manual','SELLER_QUICK_LOGIN':'0'}
        info=dict(Image=ID,Config=dict(Env=[k+'='+v for k,v in env.items()]),Mounts=[
            dict(Type='bind',RW=False,Source=self.sup.probe()['generationPath'],Destination='/run/mcp-codec'),
            dict(Type='bind',RW=False,Source=str(self.root/'mcp-control'),Destination='/run/mcp-control')])
        with patch.object(self.f,'docker',return_value=json.dumps(info)):self.f.verify_mcp_backend(release())
        for key in env:
            bad=json.loads(json.dumps(info));bad['Config']['Env']=[k+'='+('wrong' if k==key else v) for k,v in env.items()]
            with self.subTest(key=key),patch.object(self.f,'docker',return_value=json.dumps(bad)):
                with self.assertRaisesRegex(ValueError,'profile mismatch'):self.f.verify_mcp_backend(release())
        info['Config']['Env'].append('MCP_V2_ENABLED=0')
        with patch.object(self.f,'docker',return_value=json.dumps(info)):
            with self.assertRaisesRegex(ValueError,'backend environment'):self.f.verify_mcp_backend(release())

    def test_pre_frontend_gate_checks_identity_and_mounts_before_readiness(self):
        self.f.wait_backend=u.Updater.wait_backend.__get__(self.f)
        with patch.object(self.f,'verify_mcp_backend',side_effect=lambda item:self.calls.append(('bound-tuple',item['sha']))),patch.object(self.f,'backend_probe',side_effect=lambda item:self.calls.append(('ready-rpc',item['sha']))):
            self.f.activate(release())
        front=[i for i,c in enumerate(self.calls) if c[0]=='docker' and 'up' in c[1] and c[1][-1]=='frontend'][0]
        self.assertLess(self.calls.index(('bound-tuple',SHA)),self.calls.index(('ready-rpc',SHA)))
        self.assertLess(self.calls.index(('ready-rpc',SHA)),front)

    def test_worker_start_failure_keeps_application_stopped_and_never_reopens_ingress(self):
        with patch.object(self.sup,'prepare',side_effect=RuntimeError('synthetic startup failure')):
            with self.assertRaises(RuntimeError):self.f.activate(release())
        self.assertTrue(self.f.paused())
        self.assertFalse(any(c[0]=='docker' and 'up' in c[1] for c in self.calls))

class Hygiene(unittest.TestCase):
    def test_cursor_progress_and_private_bounded_result(self):
        spec=importlib.util.spec_from_file_location('gcp_maintenance',ROOT/'deploy/gcp/mcp-maintenance.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.module=u
        with tempfile.TemporaryDirectory() as root:
            f=u.Updater(root);f.state.update(current=release(),local={});cursor='12345678-1234-4234-8234-123456789012'
            results=[json.dumps(dict(Config=dict(Image=release()['backend']),State=dict(Running=True),Image=ID)),
                     json.dumps(dict(processedTenants=20,cleanupPassesPerTenant=1,nextCursor=cursor,complete=False))]
            with patch.object(f,'local_fingerprint',return_value={}),patch.object(f,'docker',side_effect=results) as docker:
                self.assertEqual('continued',module.maintain(f))
                self.assertEqual(('--all','1','--limit=20'),docker.call_args.args[-3:])
            self.assertEqual(cursor,json.loads(Path(root,'mcp-maintenance.json').read_text())['nextCursor'])
            results[1]=json.dumps(dict(processedTenants=1,cleanupPassesPerTenant=1,nextCursor=None,complete=True))
            with patch.object(u,'trusted',side_effect=lambda p:Path(p)),patch.object(f,'local_fingerprint',return_value={}),patch.object(f,'docker',side_effect=results) as docker:
                self.assertEqual('completed',module.maintain(f));self.assertEqual('--after='+cursor,docker.call_args.args[-1])
            self.assertIsNone(json.loads(Path(root,'mcp-maintenance.json').read_text())['nextCursor'])
    def test_invalid_result_and_wrong_backend_do_not_advance_cursor(self):
        spec=importlib.util.spec_from_file_location('gcp_maintenance',ROOT/'deploy/gcp/mcp-maintenance.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.module=u
        with tempfile.TemporaryDirectory() as root:
            f=u.Updater(root);f.state.update(current=release(),local={})
            info=dict(Config=dict(Image=release()['backend']),State=dict(Running=True),Image=ID)
            for raw in ['x'*513,'{}',json.dumps(dict(processedTenants=21,cleanupPassesPerTenant=1,nextCursor=None,complete=True))]:
                with patch.object(f,'local_fingerprint',return_value={}),patch.object(f,'docker',side_effect=[json.dumps(info),raw]):
                    with self.assertRaises(ValueError):module.maintain(f)
                self.assertFalse(Path(root,'mcp-maintenance.json').exists())
            info['Image']='sha256:'+'9'*64
            with patch.object(f,'local_fingerprint',return_value={}),patch.object(f,'docker',return_value=json.dumps(info)) as docker:
                with self.assertRaises(ValueError):module.maintain(f)
                self.assertEqual(1,docker.call_count)

if __name__=='__main__':unittest.main()
