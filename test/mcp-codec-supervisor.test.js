import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./mcp-codec-supervisor.test.py',import.meta.url));
test('supervisor manifest grammar fails closed without Docker or privileged fixtures',()=>{
 const result=spawnSync('python3',[script,'Validation'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
});
test('owned root supervisor fault recovery and actual native generation lifecycle', {skip:process.env.MEDIA_CODEC_SUPERVISOR_TEST!=='1'},()=>{
 const result=spawnSync('sudo',['-n','env','NODE_ENV=test','MEDIA_CODEC_SUPERVISOR_TEST=1','python3',script],{encoding:'utf8',timeout:120000,maxBuffer:65536});
 assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/OK/);
});
