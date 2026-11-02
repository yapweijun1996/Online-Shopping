import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiStudioProvider, cleanSuggestion } from '../src/ai-studio/provider.js';

const KEY = 'sk-test-secret-key-0001';
const image = { mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
const categories = [{ code: 'BAGS', label: 'Bags' }, { code: 'SHOES', label: 'Shoes' }];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const message = (text) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
function provider(handler, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls); };
  return { calls, api: createOpenAiStudioProvider({ apiKey: KEY, fetchImpl, ...options }) };
}

test('analyze sends a strict schema with the photo and returns cleaned plain-text suggestions', async () => {
  const { calls, api } = provider(() => json(message(JSON.stringify({ name: '  Leather <b>tote</b> bag ', description: 'A brown bag.\nWith straps.', category: 'BAGS', tags: ['bag', ' leather '] }))));
  const result = await api.analyze({ image, categories });
  assert.deepEqual(result, { name: 'Leather b tote /b bag', description: 'A brown bag. With straps.', category: 'BAGS', tags: ['bag', 'leather'] });
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(init.body);
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format.schema.properties.category.enum, ['BAGS', 'SHOES', null]);
  assert.match(body.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
});

test('model output outside the schema is never trusted', async () => {
  assert.equal(cleanSuggestion({ name: 'A', description: 'B', category: 'OTHER', tags: 'x' }, ['BAGS']).category, null);
  assert.throws(() => cleanSuggestion({ name: '', description: 'B' }, []), { code: 'STUDIO_BAD_RESPONSE' });
  assert.throws(() => cleanSuggestion('text', []), { code: 'STUDIO_BAD_RESPONSE' });
  const long = cleanSuggestion({ name: 'n'.repeat(500), description: 'd'.repeat(5000), category: null, tags: Array(30).fill('t') }, []);
  assert.equal(long.name.length, 120); assert.equal(long.description.length, 2000); assert.equal(long.tags.length, 8);
});

test('refusal, incomplete and malformed answers fail with coded errors', async () => {
  const cases = [
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }, 'STUDIO_REFUSED'],
    [{ status: 'incomplete', output: [] }, 'STUDIO_BAD_RESPONSE'],
    [message('not json'), 'STUDIO_BAD_RESPONSE'],
    [{ status: 'completed' }, 'STUDIO_BAD_RESPONSE']
  ];
  for (const [body, code] of cases) await assert.rejects(provider(() => json(body)).api.analyze({ image, categories }), { code });
});

test('HTTP failures map to safe codes and never expose the key or provider body', async () => {
  for (const [status, code] of [[401, 'STUDIO_KEY_REJECTED'], [429, 'STUDIO_RATE_LIMITED'], [400, 'STUDIO_REQUEST_REJECTED'], [503, 'STUDIO_UNAVAILABLE']]) {
    const error = await provider(() => json({ error: { message: `bad key ${KEY}` } }, status)).api.analyze({ image, categories }).catch((e) => e);
    assert.equal(error.code, code);
    assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), /sk-test/);
  }
});

test('a redirect, an oversized body and a network failure are refused', async () => {
  const redirected = provider(() => { throw new TypeError('unexpected redirect'); });
  await assert.rejects(redirected.api.analyze({ image, categories }), { code: 'STUDIO_UNAVAILABLE' });
  const huge = provider(() => new Response('x'.repeat(1024 * 1024 + 10)));
  await assert.rejects(huge.api.analyze({ image, categories }), { code: 'STUDIO_BAD_RESPONSE' });
});

test('edit posts multipart to the images endpoint and returns the decoded image', async () => {
  const png = Buffer.from('RIFFxxxxWEBPdata');
  const { calls, api } = provider(() => json({ data: [{ b64_json: png.toString('base64') }] }));
  const result = await api.edit({ image, prompt: 'studio shot' });
  assert.equal(result.mime, 'image/webp'); assert.deepEqual(result.data, png);
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.openai.com/v1/images/edits');
  assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get('model'), 'gpt-image-2.5-sunburst');
  assert.equal(init.body.get('output_format'), 'webp');
  assert.equal(init.headers['content-type'], undefined);
});

test('a timed-out or malformed edit is marked ambiguous because it may have been billed', async () => {
  const slow = provider((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' })))), { timeoutMs: 20 });
  await assert.rejects(slow.api.edit({ image, prompt: 'p' }), { code: 'STUDIO_TIMEOUT', ambiguous: true });
  const bad = provider(() => json({ data: [{ b64_json: 'not base64!!' }] }));
  await assert.rejects(bad.api.edit({ image, prompt: 'p' }), { code: 'STUDIO_BAD_RESPONSE', ambiguous: true });
  const rejected = provider(() => json({}, 400));
  const error = await rejected.api.edit({ image, prompt: 'p' }).catch((e) => e);
  assert.equal(error.code, 'STUDIO_REQUEST_REJECTED'); assert.notEqual(error.ambiguous, true);
});

test('validateKey is a read-only models call', async () => {
  const { calls, api } = provider(() => json({ data: [] }));
  assert.equal(await api.validateKey(), true);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models'); assert.equal(calls[0].init.method, 'GET');
  await assert.rejects(provider(() => json({}, 401)).api.validateKey(), { code: 'STUDIO_KEY_REJECTED' });
  assert.throws(() => createOpenAiStudioProvider({ apiKey: '' }), { code: 'STUDIO_KEY_MISSING' });
});

test('failures while reading the body are sanitized and edits stay ambiguous', async () => {
  const stalled = () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { status: 200 });
  const stall = await provider(stalled, { timeoutMs: 30 }).api.edit({ image, prompt: 'p' }).catch((e) => e);
  assert.equal(stall.code, 'STUDIO_TIMEOUT'); assert.equal(stall.ambiguous, true);
  const leaky = () => new Response(new ReadableStream({ pull(controller) { controller.error(Object.assign(new Error(`socket ${KEY}`), { code: 'ECONNRESET' })); } }), { status: 200 });
  const reset = await provider(leaky).api.edit({ image, prompt: 'p' }).catch((e) => e);
  assert.equal(reset.code, 'STUDIO_BAD_RESPONSE'); assert.equal(reset.ambiguous, true);
  assert.doesNotMatch(JSON.stringify({ message: reset.message, ...reset }), /sk-test|ECONNRESET/);
  const huge = provider(() => new Response('x'.repeat(16 * 1024 * 1024 + 10)));
  const big = await huge.api.edit({ image, prompt: 'p' }).catch((e) => e);
  assert.equal(big.code, 'STUDIO_BAD_RESPONSE'); assert.equal(big.ambiguous, true);
  const analyzeReset = await provider(leaky).api.analyze({ image, categories }).catch((e) => e);
  assert.equal(analyzeReset.code, 'STUDIO_BAD_RESPONSE'); assert.notEqual(analyzeReset.ambiguous, true);
});
