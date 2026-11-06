import test from 'node:test';
import assert from 'node:assert/strict';
import {codecContainerEnvironment,startContainer} from '../media-codec/scripts/dev-container.js';

test('private QA codec environment defaults to development and permits only explicit boolean production',async()=>{
 assert.equal(codecContainerEnvironment(),'NODE_ENV=development');
 assert.equal(codecContainerEnvironment(false),'NODE_ENV=development');
 assert.equal(codecContainerEnvironment(true),'NODE_ENV=production');
 for(const value of ['true','false',1,0,null,{},[]]){
  assert.throws(()=>codecContainerEnvironment(value),TypeError);
  // Valid image syntax: the invalid mode must reject before any host directory
  // or Docker command, even on a host without a Docker/native test lease.
  await assert.rejects(startContainer('sha256:'+'a'.repeat(64),{production:value}),TypeError);
 }
});
