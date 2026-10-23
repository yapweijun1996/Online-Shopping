import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createQrSellerApi } from '../src/whatsapp-qr/seller-api.js';
async function fixture(t, provider) {
 const store = await openDatabase(':memory:'); t.after(() => store.close());
 await store.run("INSERT INTO message_thread(id,provider,peer_hash,peer_sealed,peer_key_id,created_at,updated_at) VALUES ('thread','WHATSAPP_QR','hash',?,'key','now','now')", Buffer.from('sealed'));
 await store.run('UPDATE ai_setting SET enabled = 1, level = 1');
 const api = createQrSellerApi({ store, ai: { enabled: true }, provider });
 const invoke = () => api({ request: new Request('https://example.test/api/v1/seller/chats/thread/suggestions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), url: new URL('https://example.test/api/v1/seller/chats/thread/suggestions'), account: { username: 'fixture' }, allow() {} });
 return { store, invoke };
}
test('A5 pending calls reserve worst-case budget and failures retain reservation', async t => {
 let release, entered;
 const pending = new Promise(resolve => { release = resolve; });
 const started = new Promise(resolve => { entered = resolve; });
 const { store, invoke } = await fixture(t, { complete: async () => { entered(); await pending; throw new Error('offline'); } });
 const request = invoke(); await started;
 const query = store.transaction(() => store.get('SELECT input_tokens,outcome FROM ai_usage LIMIT 1'));
 const result = await Promise.race([query, new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]);
 release(); await request;
 assert.notEqual(result, 'blocked'); assert.ok(result.input_tokens >= 8000); assert.equal(result.outcome, 'ERROR');
 assert.ok((await store.get('SELECT input_tokens FROM ai_usage LIMIT 1')).input_tokens >= result.input_tokens);
});
test('review 7: level zero disables suggestions', async t => {
 const { store, invoke } = await fixture(t, { complete: async () => { throw new Error('must not run'); } });
 await store.run('UPDATE ai_setting SET level = 0');
 assert.equal((await (await invoke()).json()).error.code, 'AI_DISABLED');
});
test('review 5: capped callers cannot append usage or audit rows', async t => {
 const { store, invoke } = await fixture(t, {});
 await store.run('UPDATE ai_setting SET daily_token_cap = 1000');
 await store.run("INSERT INTO ai_usage(id,day,kind,actor,input_tokens,output_tokens,outcome,created_at) VALUES ('cap',?,'SUGGEST','fixture',1000,0,'OK','now')", new Date().toISOString().slice(0,10));
 for(let i=0;i<10;i++) assert.equal((await invoke()).status,429);
 assert.equal((await store.get('SELECT COUNT(*) AS n FROM ai_usage')).n,1);
 assert.equal((await store.get('SELECT COUNT(*) AS n FROM ai_suggestion_audit')).n,0);
});
test('review 8: route retention deletes at most 200 expired rows per table', async t => {
 const { store, invoke } = await fixture(t, {});
 await store.run('UPDATE ai_setting SET level = 0');
 for(let i=0;i<201;i++) {
 await store.run("INSERT INTO ai_usage(id,day,kind,actor,input_tokens,output_tokens,outcome,created_at) VALUES (?, '2000-01-01','SUGGEST','fixture',0,0,'ERROR','2000-01-01')",String(i));
 await store.run("INSERT INTO ai_suggestion_audit(id,actor,thread_id,created_at) VALUES (?,'fixture','thread','2000-01-01')",String(i));
 }
 await invoke();
 for(const table of ['ai_usage','ai_suggestion_audit']) assert.equal((await store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n,1);
});
test('review 2: concurrent requests cannot pass a reserved daily cap', async t => {
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const { store, invoke } = await fixture(t, { complete: async () => { calls++; entered(); await pending; throw new Error('offline'); } });
  await store.run('UPDATE ai_setting SET daily_token_cap = 16000');
  const first = invoke(); await started;
  const responses = await Promise.all([invoke(), invoke(), invoke()]);
  const reserved = await store.get('SELECT SUM(input_tokens + output_tokens) AS tokens FROM ai_usage');
  release(); await first;
  assert.equal(calls, 1);
  assert.deepEqual(responses.map(r => r.status), [429, 429, 429]);
  assert.ok(reserved.tokens >= 8000 && reserved.tokens <= 16000);
});
test('A5 successful suggestions settle reserved tokens to observed usage', async t => {
 const { store, invoke } = await fixture(t, { complete: async () => ({ content: [{ type: 'tool_use', id: 'finish', name: 'submit_suggestion', input: { reply: 'Ready', handoff: false, handoffReason: null, order: null } }], usage: { input_tokens: 12, output_tokens: 8 } }) });
 assert.equal((await invoke()).status, 200);
 assert.deepEqual({ ...await store.get('SELECT input_tokens,output_tokens,actor FROM ai_usage') }, { input_tokens: 12, output_tokens: 8, actor: 'fixture' });
});
test('A5 unexpected failures log only error code and class', async t => {
 const previous = console.error, lines = [];
 console.error = line => lines.push(line); t.after(() => { console.error = previous; });
 const { invoke } = await fixture(t, { complete: async () => { throw Object.assign(new TypeError('private prompt'), { code: 'E_FIXTURE' }); } });
 assert.equal((await invoke()).status, 502);
 assert.deepEqual(lines, ['E_FIXTURE TypeError']);
});
test('A5 thread limiter rejection does not consume shop quota', async t => {
 const { store, invoke } = await fixture(t, { complete: async () => ({ content: [{ type: 'tool_use', id: 'finish', name: 'submit_suggestion', input: { reply: 'Ready', handoff: false, handoffReason: null, order: null } }], usage: { input_tokens: 1, output_tokens: 1 } }) });
 for (let i = 0; i < 6; i++) assert.equal((await invoke()).status, 200);
 const before = await store.all("SELECT * FROM rate_limit_attempt WHERE bucket = 'ai-suggest-shop'");
 assert.equal((await invoke()).status, 429);
 assert.deepEqual(await store.all("SELECT * FROM rate_limit_attempt WHERE bucket = 'ai-suggest-shop'"), before);
});
