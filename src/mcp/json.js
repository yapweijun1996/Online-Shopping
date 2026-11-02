// JSON.parse validates syntax first; the token scan then detects duplicate decoded
// object keys (including escaped spellings) without changing string contents.
export function parseJson(text) {
  const value = JSON.parse(text), objects = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"\s*:|"(?:\\[\s\S]|[^"\\])*"|[{}]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (token.endsWith(':')) {
      const key = JSON.parse(token.slice(0, -1).trimEnd()), keys = objects.at(-1);
      if (keys.has(key)) throw new SyntaxError('Duplicate JSON key.');
      keys.add(key);
    }
  }
  return value;
}
