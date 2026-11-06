#!/usr/bin/env python3
"""Canary namespace/ownership boundaries only. Never invokes Docker or native code."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('canary',ROOT/'scripts/qa-gcp-mcp-canary.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)


class Tests(unittest.TestCase):
    def setUp(self):
        self.ns=c.Namespace('012345abcdef');self.record={};self.calls=[]
        self.guard=c.DockerGuard(self.ns,{'sha256:'+'a'*64},self.record,lambda:None)

    def raw(self,*args,**kwargs):
        self.calls.append(args);return ''

    def app(self,**changes):
        value={'Id':'1'*64,'Name':'/'+self.ns.app('backend'),'Image':'sha256:'+'a'*64,
               'Config':{'Labels':{c.OWNER_LABEL:self.ns.nonce,c.PROJECT_LABEL:self.ns.project,'com.docker.compose.service':'backend'}}}
        value.update(changes);return value

    def test_nonce_and_socket_limit(self):
        self.assertLess(len(bytes(str(self.ns.root/'mcp-codec/generations'/('g-'+'0'*32)/'socket/codec.sock'),'utf8')),108)
        for nonce in ['','abc','../0123456789','012345abcdef0','012345ABCDEf']:
            with self.assertRaises(c.Blocked):c.Namespace(nonce)

    def test_manifest_and_source_paths_cannot_open_live_root_or_volume(self):
        for path in ['/opt/online-shopping-gcp/runtime.env','/opt/online-shopping-gcp/../online-shopping-gcp/update.py',
                     '/var/lib/docker/volumes/online-shopping-gcp_pg_data/_data']:
            with self.subTest(path=path),self.assertRaises(c.Blocked):c.deny_production_path(path)
        with tempfile.TemporaryDirectory() as directory:
            alias=Path(directory)/'policy';alias.symlink_to('/opt/online-shopping-gcp')
            with self.assertRaises(c.Blocked):c.deny_production_path(alias/'runtime.env')

    def test_exact_mapping_never_substring_rewrites(self):
        actual=self.ns.translate(['compose','--project-name','online-shopping-gcp','online-shopping-gcp-backend-1','label='+c.PROJECT_LABEL+'=online-shopping-gcp'])
        self.assertEqual(actual,['compose','--project-name',self.ns.project,self.ns.app('backend'),'label='+c.PROJECT_LABEL+'='+self.ns.project])
        for value in ['online-shopping-gcp-backend-10','--root=/opt/online-shopping-gcp','online-shopping-edge','online-shopping-gcp']:
            with self.assertRaises(c.Blocked):self.ns.translate([value])

    def test_unrelated_names_contexts_ports_and_prune_never_execute(self):
        for args in [['inspect','--format','{{json .}}','foreign'],['--context','prod','ps'],['system','prune'],
                     ['run','--privileged','image'],['network','rm','online-shopping-edge'],['volume','rm','online-shopping-gcp_pg_data']]:
            with self.subTest(args=args),self.assertRaises(c.Blocked):self.guard.call(args,self.raw)
        self.assertEqual(self.calls,[])

    def test_project_filter_is_exact_and_preserves_remaining_writer_evidence(self):
        incoming=['ps','-q','--filter','label='+c.PROJECT_LABEL+'=online-shopping-gcp','--filter','label=com.docker.compose.service=backend']
        def actual(*args,**kwargs):self.calls.append(args);return 'unexpected-live-writer\n'
        self.assertEqual(self.guard.call(incoming,actual),'unexpected-live-writer\n')
        self.assertIn('label='+c.PROJECT_LABEL+'='+self.ns.project,self.calls[0])
        self.assertFalse(any(c.OWNER_LABEL in x for x in self.calls[0]))
        with self.assertRaises(c.Blocked):self.guard.call(['ps','-aq'],self.raw)

    def test_two_independent_ownership_labels_are_required(self):
        self.guard.owned(self.app(),self.ns.app('backend'))
        for key in [c.OWNER_LABEL,c.PROJECT_LABEL]:
            value=self.app();value['Config']['Labels'][key]='foreign'
            with self.assertRaises(c.Blocked):self.guard.owned(value,self.ns.app('backend'))
        with self.assertRaises(c.Blocked):self.guard.owned(self.app(Name='/foreign'),self.ns.app('backend'))

    def test_inspection_response_is_not_rewritten_or_synthesized(self):
        full=self.app();full['State']={'Running':True};calls=[]
        def actual(*args,**kwargs):
            calls.append(args)
            return json.dumps(full) if args[-3:-1]==('--format','{{json .}}') else 'ACTUAL_STATE_BYTES'
        self.assertEqual(self.guard.call(['inspect','--format','{{json .State}}','online-shopping-gcp-backend-1'],actual),'ACTUAL_STATE_BYTES')
        self.assertEqual(calls[-1][-1],self.ns.app('backend'))

    def test_mutation_uses_proven_id_and_refuses_foreign_owner(self):
        self.guard.owned(self.app(),self.ns.app('backend'))
        def actual(*args,**kwargs):
            self.calls.append(args)
            return json.dumps(self.app()) if args[0]=='inspect' else 'removed'
        self.assertEqual(self.guard.call(['rm','-f','1'*64],actual),'removed')
        self.assertEqual(self.calls[-1],('rm','-f','1'*64))
        value=self.app();value['Config']['Labels'][c.OWNER_LABEL]='foreign'
        with self.assertRaises(c.Blocked):self.guard.call(['rm','-f','1'*64],lambda *a,**kw:json.dumps(value))

    def test_supervisor_receipt_binds_name_owner_generation_and_image(self):
        state={'container':'shopping-mcp-codec-'+'2'*32,'generation':'g-'+'2'*32,'owner':'3'*32,'manifest':{'imageId':'sha256:'+'a'*64}}
        self.guard.remember_codec(state)
        value={'Id':'4'*64,'Name':'/'+state['container'],'Image':state['manifest']['imageId'],'Config':{'Labels':{
            c.OWNER_LABEL:self.ns.nonce,'shopping.mcp-codec.owner':state['owner'],'shopping.mcp-codec.generation':state['generation']}}}
        self.guard.owned(value,state['container'])
        for key in ['shopping.mcp-codec.owner','shopping.mcp-codec.generation']:
            bad=json.loads(json.dumps(value));bad['Config']['Labels'][key]='foreign'
            with self.assertRaises(c.Blocked):self.guard.owned(bad,state['container'])
        with self.assertRaises(c.Blocked):self.guard.call(['ps','-a','--no-trunc','--filter','name=^/shopping-mcp-codec-'+'9'*32+'$','--format={{.ID}} {{.Names}}'],self.raw)

    def test_resource_cleanup_requires_exact_name_and_both_labels(self):
        name=self.ns.project+'_pg_data'
        value=[{'Name':name,'Labels':{c.OWNER_LABEL:self.ns.nonce,c.PROJECT_LABEL:self.ns.project}}]
        self.assertEqual(self.guard.resource('volume',name,lambda *a,**kw:json.dumps(value)),value[0])
        value[0]['Labels'].pop(c.PROJECT_LABEL)
        with self.assertRaises(c.Blocked):self.guard.call(['volume','rm',name],lambda *a,**kw:json.dumps(value))

    def test_compose_changes_only_namespace_networks_and_nonce_labels(self):
        base={'name':self.ns.project,'services':{s:{'image':s,'mem_limit':'unchanged','environment':{'NODE_ENV':'production'}} for s in c.SERVICES},
              'networks':{'edge':{'external':True,'name':'online-shopping-edge'},'private':{'internal':True},'egress':{'internal':False,'ipam':{'config':[{'subnet':'192.168.247.0/24'}]}}},'volumes':{'pg_data':{}}}
        actual=c.transform_compose(base,self.ns)
        self.assertTrue(all(n['internal'] and n['name'].startswith(self.ns.project+'_') for n in actual['networks'].values()))
        for s in c.SERVICES:
            self.assertEqual({k:v for k,v in actual['services'][s].items() if k!='labels'},base['services'][s])
        self.assertFalse(actual['networks']['egress'].get('ipam'))
        self.assertTrue(base['networks']['edge']['external'])
        base['services']['backend']['ports']=['3000:3000']
        with self.assertRaises(c.Blocked):c.transform_compose(base,self.ns)

    def test_same_nonce_wrong_service_label_is_not_ownership(self):
        value=self.app();value['Config']['Labels']['com.docker.compose.service']='postgres'
        with self.assertRaises(c.Blocked):self.guard.owned(value,self.ns.app('backend'))

    def test_compose_refuses_colliding_project_before_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            self.ns.root=Path(directory);path=self.ns.root/'compose.yaml';path.write_text('{}')
            self.guard.compose_hash=c.digest(path.read_bytes())
            prefix=['compose','--project-name',self.ns.project,'--env-file',str(self.ns.root/'runtime.env'),'--env-file',str(self.ns.root/'images.env'),'-f',str(path),
                    '--profile','whatsapp-qr','--profile','whatsapp-qr-slot1']
            value=self.app();value['Config']['Labels'][c.OWNER_LABEL]='other'
            def actual(*args,**kwargs):
                self.calls.append(args)
                if args[0]=='ps':return self.ns.app('backend')
                if args[0]=='inspect':return json.dumps(value)
                self.fail('A mutation or foreign resource lookup was attempted')
            with self.assertRaises(c.Blocked):self.guard.call(prefix+['up','-d','--no-build','--no-deps','backend'],actual)
            self.assertTrue(all(x[0] in ('ps','inspect') for x in self.calls))
            with self.assertRaises(c.Blocked):self.guard.call(prefix+['run','--rm'],self.raw)

    def test_codec_run_keeps_real_policy_and_only_adds_nonce_label(self):
        spec=importlib.util.spec_from_file_location('canary_policy',ROOT/'deploy/gcp/media-codec.py')
        policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)
        supervisor=object.__new__(policy.CodecSupervisor)
        supervisor.__class__._canary_hash_program=policy.FILE_HASH_PROGRAM
        state={'container':'shopping-mcp-codec-'+'2'*32,'generation':'g-'+'2'*32,'owner':'3'*32,'manifest':{'imageId':'sha256:'+'a'*64}}
        args=['run','--rm','--pull=never',*supervisor._container_args(state),'--entrypoint=node',state['manifest']['imageId'],'--input-type=module','-e',policy.FILE_HASH_PROGRAM]
        self.guard.call(args,self.raw,supervisor=supervisor)
        self.assertEqual(self.calls[-1],tuple(['run','--label',c.OWNER_LABEL+'='+self.ns.nonce,*args[1:]]))
        self.assertIn(state['container'],self.record['codecs'])
        bad=list(args);bad[bad.index('--network=none')]='--network=host'
        with self.assertRaises(c.Blocked):self.guard.call(bad,self.raw,supervisor=supervisor)


class Checkpoints(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.h=object.__new__(c.Harness);self.h.root=Path(self.temp.name);self.h.ns=c.Namespace('012345abcdef')
        self.h.record={'phases':{},'io':{}};self.snapshots=[]
        self.h.persist=lambda:self.snapshots.append(json.loads(json.dumps(self.h.record)))

    def test_missing_prior_phase_never_calls_action(self):
        self.h.phase_B=Mock()
        with patch.object(c.os,'uname',return_value=SimpleNamespace(machine='amd64')):
            with self.assertRaisesRegex(c.Blocked,'PHASE_PREREQUISITE'):self.h.run('B')
        self.h.phase_B.assert_not_called();self.assertEqual(self.h.record['phases'],{})

    def test_started_and_failed_phase_cannot_silently_restart(self):
        self.h.record['phases']['source']={'status':'RUNNING'};self.h.source=Mock()
        with self.assertRaisesRegex(c.Blocked,'INTERRUPTED_PHASE'):self.h.run('source')
        self.h.source.assert_not_called()
        self.h.record['phases']['source']['status']='BLOCKED'
        with self.assertRaisesRegex(c.Blocked,'INTERRUPTED_PHASE'):self.h.run('source')
        self.h.source.assert_not_called()

    def test_success_is_idempotent_and_running_is_durable_before_work(self):
        def work():
            self.assertEqual(self.snapshots[-1]['phases']['source']['status'],'RUNNING');return {'readOnly':True}
        self.h.source=Mock(side_effect=work)
        self.h.run('source');self.h.run('source')
        self.h.source.assert_called_once();self.assertEqual(self.h.record['phases']['source']['status'],'PASSED')

    def test_real_failure_is_blocked_and_keeps_private_checkpoint(self):
        self.h.source=Mock(side_effect=c.Blocked('EXACT_MAIN_CI'))
        with self.assertRaisesRegex(c.Blocked,'EXACT_MAIN_CI'):self.h.run('source')
        self.assertEqual(self.snapshots[-1]['phases']['source']['status'],'BLOCKED')
        self.assertEqual(self.snapshots[-1]['phases']['source']['code'],'EXACT_MAIN_CI')

    def test_controller_only_overrides_io_boundary(self):
        spec=importlib.util.spec_from_file_location('canary_update_policy',ROOT/'deploy/gcp/update.py')
        actual=importlib.util.module_from_spec(spec);spec.loader.exec_module(actual)
        self.h.module=actual;self.h.lock=None;controller=self.h.controller()
        for method in ('activate','restore','recover_codec','poll','preflight_mcp','health','epoch_control','stop_clients','source','release'):
            self.assertIs(getattr(type(controller),method),getattr(actual.Updater,method))


class Manifest(unittest.TestCase):
    def manifest(self):
        image=lambda component,n:'ghcr.io/yapweijun1996/online-shopping-'+component+'@sha256:'+n*64
        return {'version':1,'nonce':'012345abcdef','candidate':{'sha':'a'*40,'backend':image('backend','1'),'frontend':image('frontend','2'),'codec':image('backend','3')},
                'previous':{'sha':c.PREVIOUS,'backend':image('backend','4'),'frontend':image('frontend','5')},'verifyRunId':1,'publicationRunId':2,
                'policyHashes':{**c.SOURCE_PINS,'compose.gcp.yaml':'6'*64,'deploy/gcp/compose.mcp.yaml':'7'*64},
                'helperHashes':{'qa-gcp-mcp-canary.py':'8'*64,'qa-gcp-mcp-canary.mjs':'9'*64}}

    def test_closed_reviewed_manifest_rejects_context_and_boolean_ci_proof(self):
        value=self.manifest();self.assertEqual(c.validate_manifest(value).nonce,value['nonce'])
        value['dockerContext']='production'
        with self.assertRaises(c.Blocked):c.validate_manifest(value)
        value=self.manifest();value['verifyRunId']=True
        with self.assertRaises(c.Blocked):c.validate_manifest(value)
        value=self.manifest();value['version']=True
        with self.assertRaises(c.Blocked):c.validate_manifest(value)

    def test_codec_is_separate_and_old_revision_policy_cannot_be_replaced(self):
        value=self.manifest();value['candidate']['codec']=value['candidate']['backend']
        with self.assertRaises(c.Blocked):c.validate_manifest(value)
        value=self.manifest();value['previous']['sha']='b'*40
        with self.assertRaises(c.Blocked):c.validate_manifest(value)
        value=self.manifest();value['policyHashes']['deploy/gcp/update.py']='0'*64
        with self.assertRaises(c.Blocked):c.validate_manifest(value)


if __name__=='__main__':unittest.main()
