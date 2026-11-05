import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mediaFixture } from './helpers/mcp-media-storage-fixture.js';
import { mediaHash } from '../src/mcp/media-storage.js';
import { clearMediaChallenge } from '../src/mcp/media-maintenance.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: page bytes, delivery branches, RESTRICT children and atomic challenge refresh are closed`,
  {skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
    const f=await mediaFixture(t,dialect),op=await f.operation('d'.repeat(64)),challenge=randomUUID(),end=new Date(Date.parse(f.now)+60000).toISOString();
    await f.store.run('INSERT INTO mcp_v2_approval_challenge(id,operation_id,nonce_hash,created_at,expires_at)VALUES(?,?,?,?,?)',challenge,op,mediaHash(challenge),f.now,end);
    const page=(index,json='{}',records=1)=>f.store.run('INSERT INTO mcp_v2_media_manifest_page(operation_id,page_index,page_json,page_hash,record_count,created_at)VALUES(?,?,?,?,?,?)',op,index,json,mediaHash(json),records,f.now);
    await assert.rejects(page(16));await assert.rejects(page(0,'{}',33));await assert.rejects(page(0,JSON.stringify({name:'漢'.repeat(6000)})));
    await page(0);await assert.rejects(page(0));
    await assert.rejects(f.store.run("INSERT INTO mcp_v2_media_delivery(challenge_id,operation_id,kind,item_key,manifest_root,expected_hash,nonce_hash,issued_at,expires_at,page_index)VALUES(?,?,'ASSET','0',?,?,?,?,?,0)",challenge,op,'f'.repeat(64),mediaHash('{}'),'e'.repeat(64),f.now,end));
    await f.store.run("INSERT INTO mcp_v2_media_delivery(challenge_id,operation_id,kind,item_key,manifest_root,expected_hash,nonce_hash,issued_at,expires_at,page_index)VALUES(?,?,'PAGE','0',?,?,?,?,?,0)",challenge,op,'f'.repeat(64),mediaHash('{}'),'e'.repeat(64),f.now,end);
    await assert.rejects(f.store.run('DELETE FROM mcp_v2_approval_challenge WHERE id=?',challenge));await assert.rejects(f.store.run('DELETE FROM mcp_v2_media_manifest_page WHERE operation_id=?',op));
    await assert.rejects(clearMediaChallenge(f.store,randomUUID(),challenge));
    assert.equal(await clearMediaChallenge(f.store,op,challenge),1);
    await f.store.run('DELETE FROM mcp_v2_approval_challenge WHERE id=?',challenge);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_delivery')).n,0);
  });
