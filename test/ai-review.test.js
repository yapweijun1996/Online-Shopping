import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProvider } from '../src/ai/provider.js';
import { buildMessages } from '../src/ai/prompt.js';
const response = { content: [{ type: 'thinking', thinking: 'private', signature: 'signed' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } };
test('review 3: provider preserves thinking and rejects incomplete output', async () => {
  let body;
  const provider = createAnthropicProvider({ fetchImpl: async (_, options) => { body = JSON.parse(options.body); return Response.json(response); } });
  assert.deepEqual((await provider.complete({ messages: [], tools: [] })).content, response.content);
  assert.equal(body.max_tokens, 2000);
  assert.deepEqual(body.output_config, { effort: 'low' });
  for (const key of ['temperature', 'top_p', 'top_k', 'tool_choice']) assert.equal(Object.hasOwn(body, key), false);
  for (const stop_reason of ['max_tokens', 'refusal']) await assert.rejects(createAnthropicProvider({ fetchImpl: async () => Response.json({ ...response, content: [{ type: 'text', text: 'partial' }], stop_reason }) }).complete({}), { code: 'AI_BAD_RESPONSE' });
});
test('review 4: phone redaction preserves order numbers dates and arithmetic', () => {
  const text = buildMessages([{ body: 'OS-00000042 2026-10-24 2 * 3 +60 12-345 6789; 0123456789; 012 345 6789' }])[0].content;
  for (const value of ['OS-00000042', '2026-10-24', '2 * 3']) assert.ok(text.includes(value), value);
  for (const value of ['+60 12-345 6789', '0123456789', '012 345 6789']) assert.equal(text.includes(value), false, value);
});
