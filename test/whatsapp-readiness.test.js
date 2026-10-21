import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createWhatsAppTransport } from '../src/whatsapp-transport.js';
import { openDatabase } from '../src/db.js';
import { createSecretBox, parseKeyFile } from '../src/secret-box.js';
import { checkWhatsAppReadiness, saveWhatsAppConnection } from '../src/integration-connections.js';
import { receiveWhatsAppWebhook } from '../src/whatsapp-inbound.js';
const input = { environment: 'SANDBOX', accessToken: 'fictional-token-123456789012345', appSecret: 'fictional-secret-1234567890', phoneNumberId: '123456', businessAccountId: '654321' };
const approved = ['order_submitted', 'order_confirmed', 'order_rejected', 'order_shipped'].flatMap(name => ['en', 'ms', 'zh_CN', 'vi', 'th', 'ja', 'ko'].map(language => ({ name, language, status: 'APPROVED' })));
const json = body => new Response(JSON.stringify(body));
const provider = (override = {}) => createWhatsAppTransport({ timeoutMs: 5, fetchImpl: async url => {
  const kind = url.includes('/phone_numbers') ? 'phoneOwnership' : url.includes('/subscribed_apps') ? 'appSubscription' : 'templates';
  if (override[kind]) return override[kind](url);
  return json({ data: kind === 'phoneOwnership' ? [{ id: input.phoneNumberId }] : kind === 'appSubscription' ? [{}] : approved });
} });
for (const id of ['phoneOwnership', 'appSubscription', 'templates']) {
  test(`${id} reports PASS, FAIL and UNKNOWN without provider text`, async () => {
    assert.equal((await provider().readiness(input)).checks.find(c => c.id === id).status, 'PASS');
    assert.equal((await provider({ [id]: () => json({ data: [] }) }).readiness(input)).checks.find(c => c.id === id).status, 'FAIL');
    const result = await provider({ [id]: () => { throw Error(input.accessToken); } }).readiness(input);
    assert.equal(result.checks.find(c => c.id === id).status, 'UNKNOWN');
    assert.ok(!JSON.stringify(result).includes(input.accessToken));
  });
}
for (const [name, response] of [
  ['redirect', () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } })],
  ['oversize', () => json({ data: [], padding: 'x'.repeat(17000) })],
  ['timeout', () => new Promise(() => {})],
]) test(`${name} never passes any remote check`, async () => {
  const result = await createWhatsAppTransport({ timeoutMs: 5, fetchImpl: response }).readiness(input);
  assert.deepEqual(result.checks.map(c => c.status), ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
});
test('template pagination is capped and refuses off-host next URLs without forwarding bearer', async () => {
  for (const next of ['https://graph.facebook.com/v21.0/654321/message_templates?after=a', 'https://evil.example/?access_token=bad']) {
    let calls = 0;
    const transport = createWhatsAppTransport({ fetchImpl: async url => {
      assert.equal(new URL(url).hostname, 'graph.facebook.com'); calls++;
      return json({ data: [], paging: { next } });
    } });
    const result = await transport.readiness(input);
    assert.equal(calls, next.includes('evil') ? 3 : 7);
    assert.equal(result.checks.find(c => c.id === 'templates').status, 'UNKNOWN');
    assert.equal(result.templates[0].status, 'UNKNOWN');
  }
});
test('templates retain approved, pending, rejected and missing across pages', async () => {
  let page = 0;
  const result = await provider({ templates: () => json(++page === 1 ? { data: [{ ...approved[0], status: 'PENDING' }], paging: { next: 'https://graph.facebook.com/page2' } } : { data: [{ ...approved[1], status: 'REJECTED' }, approved[2]] }) }).readiness(input);
  assert.deepEqual(result.templates.slice(0, 4).map(t => t.status), ['PENDING', 'REJECTED', 'APPROVED', 'MISSING']);
});
test('App Secret proof belongs to the signed phone and is cleared on rotation', async t => {
  const store = await openDatabase(':memory:'); t.after(() => store.close());
  const box = createSecretBox(parseKeyFile(`k=${randomBytes(32).toString('base64')}`));
  const transport = { ...provider(), verify: async () => ({ ok: true }) };
  await saveWhatsAppConnection(store, box, transport, input, 'fixture');
  const status = async () => (await checkWhatsAppReadiness(store, box, transport, 'SANDBOX')).checks.find(c => c.id === 'appSecret').status;
  assert.equal(await status(), 'UNKNOWN');
  const rawBody = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: input.phoneNumberId }, messages: [{ id: 'wamid.fixture-message', from: '15555550100', timestamp: '1760000100', type: 'text', text: { body: 'Fixture' } }] } }] }] }));
  await assert.rejects(receiveWhatsAppWebhook(store, box, { rawBody, signature: 'sha256=wrong' }));
  assert.equal(await status(), 'UNKNOWN');
  const unrelated = Buffer.from(rawBody.toString().replace(input.phoneNumberId, '999999'));
  await receiveWhatsAppWebhook(store, box, { rawBody: unrelated,
    signature: 'sha256=' + createHmac('sha256', input.appSecret).update(unrelated).digest('hex') });
  assert.equal(await status(), 'UNKNOWN', 'a provider-wide valid receipt for another phone is not proof');
  const signature = 'sha256=' + createHmac('sha256', input.appSecret).update(rawBody).digest('hex');
  await receiveWhatsAppWebhook(store, box, { rawBody, signature });
  assert.equal(await status(), 'PASS');
  await saveWhatsAppConnection(store, box, transport, input, 'fixture');
  assert.equal(await status(), 'UNKNOWN');
  await receiveWhatsAppWebhook(store, box, { rawBody, signature });
  assert.equal(await status(), 'UNKNOWN', 'old body replay cannot re-prove rotated credentials');
});
test('shared phone and App Secret prove both environments without changing message routing', async t => {
  const store = await openDatabase(':memory:'); t.after(() => store.close());
  const box = createSecretBox(parseKeyFile(`k=${randomBytes(32).toString('base64')}`));
  const transport = { ...provider(), verify: async () => ({ ok: true }) };
  for (const environment of ['SANDBOX', 'PRODUCTION']) {
    await saveWhatsAppConnection(store, box, transport, { ...input, environment }, 'fixture');
  }
  const rawBody = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: input.phoneNumberId }, messages: [{ id: 'wamid.shared-phone', from: '15555550100', timestamp: '1760000100', type: 'text', text: { body: 'Fixture' } }] } }] }] }));
  const signature = 'sha256=' + createHmac('sha256', input.appSecret).update(rawBody).digest('hex');
  assert.equal((await receiveWhatsAppWebhook(store, box, { rawBody, signature })).messages, 1);
  const stored = await store.all(`SELECT c.environment FROM message_inbound m
    JOIN integration_connection c ON c.id = m.connection_id WHERE m.provider_message_id = ?`, 'wamid.shared-phone');
  assert.deepEqual(stored.map(row => row.environment), ['PRODUCTION']);
  for (const environment of ['PRODUCTION', 'SANDBOX']) {
    const readiness = await checkWhatsAppReadiness(store, box, transport, environment);
    assert.equal(readiness.checks.find(c => c.id === 'appSecret').status, 'PASS', environment);
  }
});
