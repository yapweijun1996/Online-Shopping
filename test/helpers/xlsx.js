import { inflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';
export function unzip(bytes) {
  const data = Buffer.from(bytes), files = {};
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  let cursor = data.readUInt32LE(end + 16);
  for (let i = 0; i < data.readUInt16LE(end + 10); i++) {
    assert.equal(data.readUInt32LE(cursor), 0x02014b50);
    const method = data.readUInt16LE(cursor + 10), size = data.readUInt32LE(cursor + 20);
    const nameLength = data.readUInt16LE(cursor + 28), extra = data.readUInt16LE(cursor + 30), comment = data.readUInt16LE(cursor + 32);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const local = data.readUInt32LE(cursor + 42), start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const body = data.subarray(start, start + size);
    assert.ok(method === 0 || method === 8);
    files[name] = (method === 8 ? inflateRawSync(body) : body).toString();
    cursor += 46 + nameLength + extra + comment;
  }
  return files;
}
export function assertBalanced(xml) {
  const stack = [];
  for (const tag of xml.matchAll(/<\/?([\w:]+)\b[^>]*>/g)) {
    if (tag[0].startsWith('</')) assert.equal(stack.pop(), tag[1]);
    else if (!tag[0].endsWith('/>')) stack.push(tag[1]);
  }
  assert.deepEqual(stack, []);
}
