import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProvider } from '../src/ai/provider.js';
import { submitSuggestion } from '../src/ai/agent.js';
import { buildMessages } from '../src/ai/prompt.js';
import { createTools } from '../src/ai/tools.js';
const result = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } };
test('A5 strict wire schemas omit unsupported constraints without changing local schemas', async () => {
 let body;
 const provider = createAnthropicProvider({ fetchImpl: async (_, options) => { body = JSON.parse(options.body); return Response.json(result); } });
 await provider.complete({ tools: [...createTools({ store: {} }).definitions, submitSuggestion] });
 assert.doesNotMatch(JSON.stringify(body.tools), /"(?:minimum|maximum|minLength|maxLength|minItems|maxItems)":/);
 assert.equal(submitSuggestion.input_schema.properties.reply.maxLength, 1000);
});
test('A5 phone redaction recognises separators unicode and masked numbers', () => {
 for (const value of ['0312-34-5678','1234-56-789012','012.345.6789','012/345/6789','MY-0123456789','AB-601234567890','０１２３４５６７８９','+••••1234']) assert.match(buildMessages([{ body: value }])[0].content, /\[phone omitted\]/, value);
 for (const value of ['OS-00000042','DEMO-00000007','2026-10-24','2 * 3','RM 49.90','3 pcs']) assert.ok(buildMessages([{ body: value }])[0].content.includes(value), value);
});
test('A5 rejected provider output retains billed usage', async () => {
 const provider = createAnthropicProvider({ fetchImpl: async () => Response.json({ ...result, stop_reason: 'max_tokens' }) });
 await assert.rejects(provider.complete({}), error => { assert.deepEqual(error.usage, { inputTokens: 12, outputTokens: 3 }); return true; });
});
test('A5 HTTP errors cancel provider bodies', async () => {
 let cancelled = false;
 const provider = createAnthropicProvider({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 500 }) });
 await assert.rejects(provider.complete({}));
 assert.equal(cancelled, true);
});
test('A5 worker control purges AI metadata with AI disabled in bounded batches', async t => {
 const { openDatabase } = await import('../src/db.js');
 const { createWhatsAppQrStore } = await import('../src/whatsapp-qr/store.js');
 const store = await openDatabase(':memory:'); t.after(() => store.close());
 for (let i = 0; i < 201; i++) {
  await store.run("INSERT INTO ai_usage(id,day,kind,actor,input_tokens,output_tokens,outcome,created_at) VALUES (?,'2000-01-01','SUGGEST','fixture',0,0,'ERROR','2000-01-01')", String(i));
  await store.run("INSERT INTO ai_suggestion_audit(id,actor,thread_id,created_at) VALUES (?,'fixture','','2000-01-01')", String(i));
 }
 await createWhatsAppQrStore({ store }).control('fixture');
 for (const table of ['ai_usage','ai_suggestion_audit']) assert.equal((await store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n, 1);
});
test('A5 oversized search queries are clipped before catalog lookup', async () => {
 let parameters;
 const tools = createTools({ store: { all: async (_, ...args) => { parameters = args; return []; } } });
 await tools.run('search_products', { query: 'x'.repeat(81) });
 assert.deepEqual(parameters, Array(3).fill(`%${'x'.repeat(80)}%`));
});
