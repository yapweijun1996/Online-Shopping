export const aiError = code => Object.assign(new Error('AI service could not complete the request.'), { code });
const unsupported = new Set(['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
function wireSchema(value) {
  if (Array.isArray(value)) return value.map(wireSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !unsupported.has(key)).map(([key, child]) => [key, wireSchema(child)]));
}
export function createAnthropicProvider({ apiKey, model, fetchImpl = fetch, timeoutMs = 20000 }) {
  return { async complete({ system, messages, tools, maxTokens = 2000, signal: deadline }) {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(deadline ? [deadline] : [])]);
    let usage;
    try {
      const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST', redirect: 'error', signal,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, tools: tools?.map(tool => ({ ...tool, input_schema: wireSchema(tool.input_schema) })), output_config: { effort: 'low' } })
      });
      if (!response.ok) { await response.body?.cancel(); throw aiError('AI_UNAVAILABLE'); }
      if (!response.body) throw aiError('AI_BAD_RESPONSE');
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 512 * 1024) { await reader.cancel(); throw aiError('AI_BAD_RESPONSE'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw aiError('AI_BAD_RESPONSE'); }
      if (Number.isSafeInteger(result.usage?.input_tokens) && result.usage.input_tokens >= 0 && Number.isSafeInteger(result.usage?.output_tokens) && result.usage.output_tokens >= 0) usage = { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens };
      if (!Array.isArray(result.content) || !result.content.length || typeof result.stop_reason !== 'string' || ['max_tokens', 'refusal'].includes(result.stop_reason) ||
          !Number.isSafeInteger(result.usage?.input_tokens) || result.usage.input_tokens < 0 ||
          !Number.isSafeInteger(result.usage?.output_tokens) || result.usage.output_tokens < 0 ||
          result.content.some(b => !b || (['thinking', 'redacted_thinking'].includes(b.type) ? false : b.type === 'text' ? typeof b.text !== 'string' : b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string' || !b.input || typeof b.input !== 'object' || Array.isArray(b.input)))) throw aiError('AI_BAD_RESPONSE');
      return result;
    } catch (error) {
      const code = signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError' ? 'AI_TIMEOUT' : ['AI_BAD_RESPONSE', 'AI_UNAVAILABLE'].includes(error.code) ? error.code : 'AI_UNAVAILABLE';
      throw Object.assign(aiError(code), usage ? { usage } : {});
    }
  } };
}
