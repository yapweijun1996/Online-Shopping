import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Client } from '../src/client.js';
export const token = 'fictional_test_token_abcdefghijklmnopqrstuvwxyz';
export async function backend(t) {
  const db = { generation: 1, desired: 'PAIR', version: 0, creds: null, keys: new Map(), states: [], inbound: [], inboundRequests: [], results: [], replies: [], owner: null, until: 0, batches: [] };
  let generation = db.generation;
  Object.defineProperty(db, 'generation', {
    get: () => generation,
    set(value) { generation = value; db.version = 0; db.creds = null; db.keys.clear(); }
  });
  const server = http.createServer(async (req, res) => {
    const respond = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body == null ? undefined : JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${token}`) return respond(401);
    const url = new URL(req.url, 'http://fixture');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (url.pathname.endsWith('/inbound') && bytes.length > 64 * 1024) return respond(413);
    let body = bytes.toString('utf8');
    body = body ? JSON.parse(body) : {};
    if (url.pathname.endsWith('/control')) {
      if (db.owner && db.owner !== req.headers['x-worker-id'] && db.until > Date.now()) return respond(409, { error: 'LEASE_HELD' });
      db.owner = req.headers['x-worker-id']; db.until = Date.now() + 60000;
      return respond(200, { generation: db.generation, desired: db.desired, pollMs: 2000, leaseSeconds: 60 });
    }
    if (Number(req.method === 'GET' ? url.searchParams.get('generation') : body.generation) !== db.generation) return respond(409, { error: 'STALE_GENERATION' });
    if (req.method !== 'GET' && (db.owner !== req.headers['x-worker-id'] || db.until <= Date.now())) return respond(409, { error: 'LEASE_HELD' });
    if (url.pathname.endsWith('/auth')) {
      if (req.method === 'GET') return respond(200, { version: db.version, creds: db.creds, keys: [...db.keys.values()] });
      if (body.version !== db.version) return respond(409, { error: 'AUTH_VERSION' });
      if (body.set.length + body.delete.length > 500) return respond(400);
      db.batches.push(body.set.length + body.delete.length);
      if (body.creds !== undefined) db.creds = body.creds;
      for (const row of body.set) db.keys.set(`${row.type}:${row.id}`, row);
      for (const row of body.delete) db.keys.delete(`${row.type}:${row.id}`);
      return respond(200, { version: ++db.version });
    }
    if (url.pathname.endsWith('/state')) { db.states.push(body); if (body.state === 'CONNECTED') db.desired = 'RUN'; return respond(204); }
    if (url.pathname.endsWith('/inbound')) {
      if (body.messages.length > 50) return respond(400);
      db.inboundRequests.push({ bytes: bytes.length, count: body.messages.length });
      db.inbound.push(...body.messages); return respond(200, { accepted: body.messages.length, duplicates: 0 });
    }
    if (url.pathname.endsWith('/claim')) { await db.onClaim?.(); return respond(200, { reply: db.replies.shift() || null }); }
    if (url.pathname.endsWith('/result')) { db.results.push(body); return respond(204); }
    respond(404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { db, client: new Client({ url: `http://127.0.0.1:${server.address().port}`, token }) };
}
export function fakeSocket() {
  const ev = new EventEmitter(); ev.process = callback => ev.on('batch', callback);
  return { ev, user: { id: '60100000000:1@s.whatsapp.net' }, sent: [], ended: 0, loggedOut: 0,
    async sendMessage(peer, body) { this.sent.push({ peer, body }); return { key: { id: 'sent-id' } }; },
    async logout() { this.loggedOut++; }, end() { this.ended++; } };
}
export async function emit(session, events) { session.socket.ev.emit('batch', events); await session.events; }
