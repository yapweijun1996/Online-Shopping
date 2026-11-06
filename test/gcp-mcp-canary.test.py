#!/usr/bin/env python3
"""Offline guards by default; --compose-parser-only explicitly tests config parsing."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('canary',ROOT/'scripts/qa-gcp-mcp-canary.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)


def namespace_only(value, ns):
    """Expected pre-fix namespace changes; all other input dictionaries survive."""
    result=copy.deepcopy(value)
    for key,network in result['networks'].items():
        network.pop('external',None);network.pop('ipam',None)
        network.update(name=ns.project+'_'+key,internal=True)
        network.setdefault('labels',{})[c.OWNER_LABEL]=ns.nonce
    result['volumes']['pg_data']['name']=ns.project+'_pg_data'
    result['volumes']['pg_data'].setdefault('labels',{})[c.OWNER_LABEL]=ns.nonce
    for service in result['services'].values():service.setdefault('labels',{})[c.OWNER_LABEL]=ns.nonce
    return result


def release_mounts():
    return {
        'frontend':[{'type':'volume','source':'${RELEASE_DIR:?Release required}/deploy/gcp/Caddyfile',
                     'target':'/etc/caddy/Caddyfile','read_only':True,'volume':{}}],
        'postgres':[{'type':'volume','source':'pg_data','target':'/var/lib/postgresql/data','volume':{}},
                    {'type':'volume','source':'${RELEASE_DIR:?Release required}/src/postgres/schema.sql',
                     'target':'/docker-entrypoint-initdb.d/01-schema.sql','read_only':True,'volume':{}},
                    {'type':'volume','source':'${RELEASE_DIR:?Release required}/deploy/init-postgres.sh',
                     'target':'/docker-entrypoint-initdb.d/02-app-role.sh','read_only':True,'volume':{}}],
    }


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
        self.assertEqual(calls[-1][-1],full['Id'])

    def test_mutation_uses_proven_id_and_refuses_foreign_owner(self):
        self.guard.owned(self.app(),self.ns.app('backend'))
        def actual(*args,**kwargs):
            self.calls.append(args)
            return json.dumps(self.app()) if args[0]=='inspect' else 'removed'
        self.assertEqual(self.guard.call(['rm','-f','1'*64],actual),'removed')
        self.assertEqual(self.calls[-1],('rm','-f','1'*64))
        value=self.app();value['Config']['Labels'][c.OWNER_LABEL]='foreign'
        with self.assertRaises(c.Blocked):self.guard.call(['rm','-f','1'*64],lambda *a,**kw:json.dumps(value))

    def test_name_replacement_cannot_redirect_kill_remove_or_exec(self):
        self.guard.programs.add('SAFE_PROGRAM')
        for command,target_index in [(['kill','--signal=KILL',self.ns.app('backend')],2),
                                     (['rm','-f',self.ns.app('backend')],2),
                                     (['exec',self.ns.app('backend'),'node','-e','SAFE_PROGRAM'],1)]:
            calls=[]
            def actual(*args,**kwargs):
                calls.append(args)
                if args[0]=='inspect':return json.dumps(self.app())
                # The inspected owner disappeared; a foreign container now owns
                # the same name. Docker must receive the proven old ID only.
                self.assertEqual(args[target_index],'1'*64)
                raise c.Blocked('OWNED_ID_GONE')
            with self.subTest(command=command),self.assertRaisesRegex(c.Blocked,'OWNED_ID_GONE'):
                self.guard.call(command,actual)
            self.assertEqual(calls[-1][target_index],'1'*64)

    def test_known_id_is_inspected_by_id_and_cannot_follow_a_reused_name(self):
        self.guard.owned(self.app(),self.ns.app('backend'))
        calls=[]
        def actual(*args,**kwargs):
            calls.append(args);self.assertEqual(args[-1],'1'*64)
            raise c.Blocked('OWNED_ID_GONE')
        with self.assertRaisesRegex(c.Blocked,'OWNED_ID_GONE'):self.guard.call(['rm','-f','1'*64],actual)
        self.assertEqual(len(calls),1)

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

    def release_compose(self):
        value={'name':self.ns.project,'services':{s:{'image':s,'mem_limit':192,'read_only':True,
                'environment':{'MCP_ENABLED':'${MCP_ENABLED:-0}'}} for s in c.SERVICES},
               'networks':{'edge':{'external':True},'private':{},'egress':{'ipam':{'config':[{'subnet':'192.168.247.0/24'}]}}},
               'volumes':{'pg_data':{}}}
        for name,mounts in release_mounts().items():value['services'][name]['volumes']=mounts
        return value

    def test_only_three_reviewed_readonly_release_files_become_bind_mounts(self):
        value=self.release_compose();before=copy.deepcopy(value)
        expected=namespace_only(value,self.ns)
        for name,indices in [('frontend',(0,)),('postgres',(1,2))]:
            for index in indices:
                mount=expected['services'][name]['volumes'][index]
                mount['type']='bind';del mount['volume']
        self.assertEqual(c.transform_compose(value,self.ns),expected)
        self.assertEqual(value,before)
        self.assertEqual(expected['services']['postgres']['volumes'][0],before['services']['postgres']['volumes'][0])

    def test_release_bind_source_readonly_and_volume_options_fail_closed(self):
        changes=[{'source':'/opt/other/Caddyfile'},{'source':'${RELEASE_DIR}/deploy/gcp/Caddyfile'},
                 {'read_only':False},{'type':'tmpfs'},{'volume':{'nocopy':True}},{'unexpected':True}]
        for change in changes:
            value=self.release_compose();value['services']['frontend']['volumes'][0].update(change)
            with self.subTest(change=change),self.assertRaisesRegex(c.Blocked,'COMPOSE_RELEASE_BIND'):
                c.transform_compose(value,self.ns)

    def test_unlisted_service_or_target_never_gets_a_bind_conversion(self):
        value=self.release_compose()
        unrelated=copy.deepcopy(value['services']['frontend']['volumes'][0])
        unrelated['target']='/elsewhere/Caddyfile'
        value['services']['frontend']['volumes'].append(unrelated)
        value['services']['backend']['volumes']=[copy.deepcopy(value['services']['frontend']['volumes'][0])]
        result=c.transform_compose(value,self.ns)
        self.assertEqual(result['services']['frontend']['volumes'][1],unrelated)
        self.assertEqual(result['services']['backend']['volumes'],value['services']['backend']['volumes'])

    def test_already_bind_release_mounts_keep_existing_bind_options(self):
        value=self.release_compose();mount=value['services']['frontend']['volumes'][0]
        mount['type']='bind';mount['bind']={'create_host_path':False};del mount['volume']
        self.assertEqual(c.transform_compose(value,self.ns)['services']['frontend']['volumes'][0],mount)

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


class Cleanup(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.h=object.__new__(c.Harness);self.h.root=Path(self.temp.name);self.h.ns=c.Namespace('012345abcdef')
        self.h.ns.root=self.h.root
        (self.h.root/'compose.yaml').write_text('{"invalid":"rendered fixture"}')
        (self.h.root/'images.env').write_text('SYNTHETIC_ONLY=1\n')
        self.h.record={'io':{}};self.h.persist=Mock();self.h.step=Mock();self.h.controller=Mock()
        self.h.guard=c.DockerGuard(self.h.ns,set(),self.h.record['io'],self.h.persist)
        self.h.guard.compose_hash=c.digest((self.h.root/'compose.yaml').read_bytes())
        self.names=[];self.resources={};self.calls=[];self.containers={}
        self.h.raw=self.raw

    def raw(self,*args,**kwargs):
        self.calls.append(args)
        if args[0]=='ps':
            return '\n'.join(self.names if args[-1]=='{{.Names}}' else [self.containers[n]['Id'] for n in self.names])
        if args[0]=='inspect':return json.dumps(self.containers[args[-1]])
        if args[0] in ('network','volume'):
            kind,action=args[:2]
            if action=='ls':
                name=args[3].removeprefix('name=^').removesuffix('$')
                return name if (kind,name) in self.resources else ''
            if action=='inspect':return json.dumps([self.resources[(kind,args[2])]])
            if action=='rm':del self.resources[(kind,args[2])];return ''
        self.fail('Unexpected Docker dispatch: '+repr(args))

    def resource(self,kind,logical,**labels):
        name=self.h.ns.project+'_'+logical
        self.resources[(kind,name)]={'Name':name,'Labels':{c.OWNER_LABEL:self.h.ns.nonce,c.PROJECT_LABEL:self.h.ns.project,**labels}}
        return name

    def test_rendered_invalid_empty_project_cleans_only_proven_owned_resources(self):
        network=self.resource('network','edge');volume=self.resource('volume','pg_data')
        self.h.cleanup()
        self.h.controller.assert_not_called()
        self.assertEqual([x for x in self.calls if x[1:2]==('rm',)], [('network','rm',network),('volume','rm',volume)])
        self.assertEqual(self.resources,{})
        self.assertEqual(self.h.record['cleanup']['status'],'PASSED')
        self.assertEqual(self.calls[0][:4],('ps','-a','--no-trunc','--filter'))

    def test_empty_project_does_not_allow_foreign_resource_cleanup(self):
        self.resource('volume','pg_data',**{c.OWNER_LABEL:'other'})
        with self.assertRaisesRegex(c.Blocked,'RESOURCE_OWNER'):self.h.cleanup()
        self.assertFalse(any(x[1:2]==('rm',) for x in self.calls))
        self.h.controller.assert_not_called()

    def test_existing_project_cannot_skip_stop_or_foreign_container_checks(self):
        name=self.h.ns.app('backend');self.names=[name]
        self.containers[name]={'Id':'1'*64,'Name':'/'+name,'Config':{'Labels':{
            c.OWNER_LABEL:'other',c.PROJECT_LABEL:self.h.ns.project,'com.docker.compose.service':'backend'}}}
        prefix=['compose','--project-name',self.h.ns.project,'--env-file',str(self.h.root/'runtime.env'),
                '--env-file',str(self.h.root/'images.env'),'-f',str(self.h.root/'compose.yaml'),
                '--profile','whatsapp-qr','--profile','whatsapp-qr-slot1']
        stop=Mock(side_effect=lambda compose:self.h.guard.call(compose+['stop','--timeout','35','frontend'],self.raw))
        self.h.controller.return_value=SimpleNamespace(compose=lambda release:prefix,stop_clients=stop)
        with self.assertRaisesRegex(c.Blocked,'OWNER_LABEL'):self.h.cleanup()
        stop.assert_called_once_with(prefix)
        self.assertFalse(any(x[0] in ('compose','rm') or x[1:2]==('rm',) for x in self.calls))

    def test_unrendered_project_with_containers_still_fails_closed(self):
        self.h.guard.compose_hash=None;self.names=[self.h.ns.app('backend')]
        with self.assertRaisesRegex(c.Blocked,'UNRENDERED_PROJECT_EXISTS'):self.h.cleanup()
        self.h.controller.assert_not_called()
        self.assertEqual(len(self.calls),1)


class Checkpoints(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.h=object.__new__(c.Harness);self.h.root=Path(self.temp.name);self.h.ns=c.Namespace('012345abcdef')
        self.h.manifest={'nonce':self.h.ns.nonce};self.h.base_images=set();self.snapshots=[]
        self.h.record={'version':1,'nonce':self.h.ns.nonce,'manifestHash':c.digest(json.dumps(self.h.manifest,sort_keys=True).encode()),'phases':{},'io':{}}
        self.h.guard=c.DockerGuard(self.h.ns,set(),self.h.record['io'],lambda:None)
        def persist():
            self.snapshots.append(json.loads(json.dumps(self.h.record)))
            c.private_json(self.h.root/'canary.json',self.h.record)
        self.h.persist=persist;self.h.persist()
        # CI is unprivileged; fixture files are synthetic temp files. The actual
        # run() lock and disk reload remain real, not an in-memory substitute.
        self.reader=patch.object(c,'read_private',side_effect=lambda path,*args:json.loads(Path(path).read_text()))
        self.reader.start();self.addCleanup(self.reader.stop)

    def test_missing_prior_phase_never_calls_action(self):
        self.h.phase_B=Mock()
        with patch.object(c.os,'uname',return_value=SimpleNamespace(machine='amd64')):
            with self.assertRaisesRegex(c.Blocked,'PHASE_PREREQUISITE'):self.h.run('B')
        self.h.phase_B.assert_not_called();self.assertEqual(self.h.record['phases'],{})

    def test_started_and_failed_phase_cannot_silently_restart(self):
        self.h.record['phases']['source']={'status':'RUNNING'};self.h.persist();self.h.source=Mock()
        with self.assertRaisesRegex(c.Blocked,'INTERRUPTED_PHASE'):self.h.run('source')
        self.h.source.assert_not_called()
        self.h.record['phases']['source']['status']='BLOCKED'
        self.h.persist()
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

    def test_kernel_shared_lock_cannot_be_taken_by_a_second_process(self):
        with open(self.h.root/'update.lock','w') as handle:
            c.fcntl.flock(handle,c.fcntl.LOCK_EX|c.fcntl.LOCK_NB);self.h.lock_probe()
        with self.assertRaisesRegex(c.Blocked,'SHARED_LOCK_CONTENTION'):self.h.lock_probe()

    def test_two_preconstructed_harnesses_reload_phase_and_io_inside_real_lock(self):
        self.h.record['phases']['source']={'status':'PASSED'};self.h.persist()
        first=self.h
        second=object.__new__(c.Harness)
        second.root=first.root;second.ns=first.ns;second.manifest=first.manifest;second.base_images=set()
        second.record=json.loads((first.root/'canary.json').read_text())
        second.guard=c.DockerGuard(second.ns,set(),second.record['io'],lambda:None)
        second.persist=lambda:c.private_json(second.root/'canary.json',second.record)
        actions=[]
        def phase():
            actions.append('A');first.record['imageIds']=['sha256:'+'2'*64]
            first.record['io']['ids']={'3'*64:first.ns.app('backend')};first.record['composeHash']='4'*64
            return {'fixture':True}
        first.phase_A=phase;second.phase_A=lambda:actions.append('DUPLICATE')
        with patch.object(c.os,'uname',return_value=SimpleNamespace(machine='amd64')):
            first.run('A');second.run('A')
        self.assertEqual(actions,['A'])
        self.assertIs(second.guard.record,second.record['io'])
        self.assertIn('sha256:'+'2'*64,second.guard.images)
        self.assertEqual(second.guard.compose_hash,'4'*64)
        self.assertEqual(second.guard.record['ids'],{'3'*64:first.ns.app('backend')})


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


class ClientAssertions(unittest.TestCase):
    """Pure client assertions/recorded requests only; Node builtins, no app/DB."""
    def setUp(self):
        self.source=(ROOT/'scripts/qa-gcp-mcp-canary.mjs').read_text()

    def node(self,program):
        result=subprocess.run(['node','--input-type=module','-e',program],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_full_legacy_definition_hash_rejects_same_names_with_changed_schema(self):
        functions=self.source[self.source.index('function canonicalDefinitions('):self.source.index('const legacyScopes')]
        self.node("""import{createHash}from'node:crypto';import assert from'node:assert/strict';
const need=(ok,code)=>{if(!ok)throw Error(code)};const hash=v=>createHash('sha256').update(v).digest('hex');
"""+functions+"""
const tools=Array.from({length:8},(_,i)=>({name:'read.'+i,description:'Frozen definition',inputSchema:{type:'object',additionalProperties:false},outputSchema:{type:'string',maxLength:32}}));
const baseline=hash(JSON.stringify(canonicalDefinitions(tools)));
assert.equal(assertLegacyDefinitions(tools,baseline),baseline);
const changed=structuredClone(tools);changed[0].outputSchema.maxLength=64;
assert.deepEqual(changed.map(x=>x.name),tools.map(x=>x.name));
assert.throws(()=>assertLegacyDefinitions(changed,baseline),/LEGACY_BASELINE_MISMATCH/);
assert.throws(()=>assertLegacyDefinitions(tools,undefined),/LEGACY_BASELINE_REQUIRED/);
assert.throws(()=>assertLegacyDefinitions(tools,'candidate-self-hash'),/LEGACY_BASELINE_REQUIRED/);
""")

    def test_actual_company_helper_uses_five_paid_attempts_with_preview_and_replay(self):
        functions=self.source[self.source.index('async function passwordApproval('):self.source.index('async function full()')]
        self.node("""import assert from'node:assert/strict';
const need=(ok,code)=>{if(!ok)throw Error(code)};const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);const secret=()=> 'a'.repeat(43);
let input={action:'on',nonce:'012345abcdef'},state={password:'correct',full:{session:{'X-CSRF-Token':'valid'}}},evidence={},marker=null,next=0,proposal,paid=0,badCsrf=0;
const commits=new Map();
async function business(){return{marker}}
async function query(){return[{n:1}]}
async function rpc(){return{status:403}}
async function tool(family,name,args){
 if(name==='company.get')return{company:{revision:'r'.repeat(64),availabilityText:marker}};
 if(name==='company.preview_update'){proposal={operationId:'op'+(++next),previewHash:'h'.repeat(64),status:'PENDING_APPROVAL',marker:args.input.changes.availabilityText};return proposal}
 if(name==='company.commit_update'){const replayed=commits.has(args.operationId);const result={revision:'receipt-'+args.operationId};commits.set(args.operationId,result);marker=proposal.marker;return{status:'COMMITTED',result,replayed}}
 throw Error('UNKNOWN_FIXTURE_TOOL');
}
async function request(path,method,body,headers){
 if(method==='GET')return{status:200,data:{previewHash:proposal.previewHash,challenge:'c'.repeat(43),proposal:{after:{availabilityText:proposal.marker}}}};
 if(headers['X-CSRF-Token']==='wrong'){badCsrf++;return{status:403}}
 paid++;return{status:body.password==='correct'?200:403};
}
"""+functions+"""
await company({wrongPassword:true});assert.equal(paid,2);assert.equal(state.approvalAttempts,2);
// C uses the already committed receipt; no company approval is performed.
await tool(state.full,'company.commit_update',{operationId:state.committed.operationId});assert.equal(paid,2);
input.action='pending';await company({pending:true});assert.equal(paid,3);
input.action='epoch-fenced';await company({previewOnly:true});assert.equal(paid,3);
input.action='restore-finished';await company();assert.equal(paid,4);
input.action='fallback-marker';await company();assert.equal(paid,5);assert.equal(state.approvalAttempts,5);
assert.equal(badCsrf,4);assert.equal(state.wrongPasswordTested,true);
await assert.rejects(passwordApproval('/approval',{},{}),/APPROVAL_BUDGET/);assert.equal(paid,5);
""")

    def test_missing_or_wrong_published_baseline_has_no_candidate_fallback(self):
        h=object.__new__(c.Harness);h.record={};h.manifest={'previous':{'backend':'PINNED_OLD_IMAGE'}}
        with self.assertRaisesRegex(c.Blocked,'LEGACY_BASELINE_REQUIRED'):h.legacy_hash()
        h.record['legacyContract']={'revision':c.PREVIOUS,'backend':'PINNED_OLD_IMAGE','count':8,'sha256':'a'*64}
        self.assertEqual(h.legacy_hash(),'a'*64)
        h.record['legacyContract']['backend']='CANDIDATE_IMAGE'
        with self.assertRaisesRegex(c.Blocked,'LEGACY_BASELINE_REQUIRED'):h.legacy_hash()


def compose_parser_only():
    """Opt-in real config parser; an absent Docker socket prevents daemon access."""
    check=unittest.TestCase();ns=c.Namespace('012345abcdef')
    with tempfile.TemporaryDirectory(prefix='mcp-canary-compose-parser-') as directory:
        folder=Path(directory);docker_config=folder/'docker';docker_config.mkdir()
        (docker_config/'config.json').write_text('{}')
        release=folder/'nonexistent-release'/c.PREVIOUS
        environment=folder/'synthetic.env'
        environment.write_text('SHOP_HOST=shop.example.invalid\nSELLER_HOST=seller.example.invalid\nADMIN_USERNAME=synthetic_owner\n'
            'APP_REVISION='+c.PREVIOUS+'\nRELEASE_DIR='+str(release)+'\nSECRETS_DIR='+str(folder/'nonexistent-secrets')+'\n'
            'BACKEND_IMAGE=ghcr.io/yapweijun1996/online-shopping-backend@sha256:'+'1'*64+'\n'
            'FRONTEND_IMAGE=ghcr.io/yapweijun1996/online-shopping-frontend@sha256:'+'2'*64+'\n')
        prefix=['docker','--host=unix://'+str(folder/'absent-daemon.sock'),'--config',str(docker_config),'compose',
                '--project-name',ns.project,'--env-file',str(environment)]
        def parse(path,unexpanded=False):
            args=prefix+['-f',str(path),'--profile','whatsapp-qr','--profile','whatsapp-qr-slot1','config']
            if unexpanded:args+=['--no-interpolate','--no-path-resolution']
            return subprocess.run(args+['--format','json'],capture_output=True,text=True,timeout=30,
                env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'HOME':str(folder),'LC_ALL':'C'})
        normalized=parse(ROOT/'compose.gcp.yaml',True)
        check.assertEqual(normalized.returncode,0,normalized.stderr)
        original=json.loads(normalized.stdout);broken=namespace_only(original,ns)
        fixed=c.transform_compose(original,ns);expected=copy.deepcopy(broken);changed=0
        for service,indices in [('frontend',(0,)),('postgres',(1,2))]:
            for index in indices:
                check.assertEqual(original['services'][service]['volumes'][index],release_mounts()[service][index])
                mount=expected['services'][service]['volumes'][index]
                mount['type']='bind';del mount['volume'];changed+=1
        check.assertEqual(fixed,expected)  # Every other normalized dictionary is unchanged.
        for name,value in [('before.json',broken),('after.json',fixed)]:
            (folder/name).write_text(json.dumps(value))
        before=parse(folder/'before.json');after=parse(folder/'after.json')
        check.assertNotEqual(before.returncode,0)
        check.assertIn('refers to undefined volume',before.stderr)
        check.assertEqual(after.returncode,0,after.stderr)
        parsed=json.loads(after.stdout)
        for service,indices in [('frontend',(0,)),('postgres',(1,2))]:
            for index in indices:
                mount=parsed['services'][service]['volumes'][index]
                check.assertEqual(mount['type'],'bind');check.assertIs(mount['read_only'],True)
                check.assertTrue(mount['source'].startswith(str(release)+'/'))
        check.assertEqual(parsed['services']['postgres']['volumes'][0],original['services']['postgres']['volumes'][0])
        check.assertFalse(release.exists());check.assertFalse((folder/'absent-daemon.sock').exists())
        print(json.dumps({'status':'PASSED','scope':'COMPOSE_PARSER_ONLY','changedReadonlyMounts':changed,
            'originalRejected':True,'fixedAccepted':True,'otherDictionariesUnchanged':True,
            'postgresNamedVolumeUnchanged':True,'releaseFilesAbsent':True,'daemonSocketAbsent':True}))


if __name__=='__main__':
    if sys.argv[1:]==['--compose-parser-only']:compose_parser_only()
    else:unittest.main()
