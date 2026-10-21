import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

export class QrError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (code, status = 409) => { throw new QrError(status, code); };
const digest = value => createHash('sha256').update(value).digest('hex');
export const validPeer = value => typeof value === 'string' && /^[0-9]{1,30}@(s\.whatsapp\.net|lid)$/.test(value);
export const validCode = value => typeof value === 'string' && /^[A-Z_]{2,40}$/.test(value);
const string = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max && value.isWellFormed() && !value.includes('\0');
const printable = (value, max) => string(value, 1, max) && /^[\x20-\x7e]+$/.test(value);
const recordIdentity = row => row && typeof row.type === 'string' && /^[a-z-]{2,40}$/.test(row.type) && printable(row.id, 200) && row.type !== 'creds';
const invalid = () => fail('INVALID_BODY', 400);

export function createWhatsAppQrStore({ store, secretBox, shopId = 'default', now = () => Date.now() }) {
  if (shopId !== 'default' && (typeof shopId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(shopId))) throw new Error('Invalid WhatsApp QR shop identity.');
  const context = (generation, type, id, chunk) => `WHATSAPP_QR:${shopId}:${generation}:${type}:${id}:${chunk}`;
  const peerContext = `WHATSAPP_QR:${shopId}:peer-key`;
  const threadContext = id => `WHATSAPP_QR:${shopId}:peer:${id}`;
  async function expirePair(session, time, at) {
    if (session.desired !== 'PAIR' || session.state === 'CONNECTED' || !(time - Date.parse(session.pair_started_at) > 120000)) return;
    const changed = await store.get("UPDATE whatsapp_qr_session SET desired = 'OFF', qr_text = NULL, qr_expires_at = NULL, last_error = 'PAIRING_TIMEOUT', revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ? RETURNING revision", at, session.revision);
    if (!changed) fail('REVISION');
    Object.assign(session, { desired: 'OFF', qr_text: null, qr_expires_at: null, last_error: 'PAIRING_TIMEOUT', revision: changed.revision });
  }
  const transact = (worker, generation, fn, control = false) => store.transaction(async () => {
    const session = await store.get(`SELECT * FROM whatsapp_qr_session WHERE id = 1${store.dialect === 'postgres' ? ' FOR UPDATE' : ''}`);
    const time = now(), at = new Date(time).toISOString();
    if (!control && generation !== session.generation) fail('STALE_GENERATION');
    if (control) {
      if (session.lease_owner !== worker && session.lease_expires_at > at) fail('LEASE_HELD');
    } else if (session.lease_owner !== worker || !(session.lease_expires_at > at)) fail('LEASE_HELD');
    // The row lock serializes every operation; revision CAS also fences future callers using this row.
    const changed = await store.get(`UPDATE whatsapp_qr_session SET revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ? RETURNING id`, at, session.revision);
    if (!changed) fail('REVISION');
    session.revision++;
    return fn(session, time, at);
  });
  async function peerKey(session, at) {
    if (session.peer_key_sealed) return secretBox.open(Buffer.from(session.peer_key_sealed), session.peer_key_id, peerContext);
    const key = randomBytes(32).toString('base64'), sealed = secretBox.seal(key, peerContext);
    await store.run('UPDATE whatsapp_qr_session SET peer_key_sealed = ?, peer_key_id = ?, updated_at = ? WHERE id = 1', sealed.sealed, sealed.keyId, at);
    session.peer_key_sealed = sealed.sealed; session.peer_key_id = sealed.keyId;
    return key;
  }
  const hash = (key, value) => createHmac('sha256', Buffer.from(key, 'base64')).update(value).digest('hex');
  async function writeRecord(generation, type, id, value, at) {
    await store.run('DELETE FROM whatsapp_qr_auth WHERE generation = ? AND record_type = ? AND record_id = ?', generation, type, id);
    const chunks = [];
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 4096, value.length);
      // UTF-8 encryption must not replace a surrogate pair split between chunks.
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
      chunks.push(value.slice(start, end)); start = end;
    }
    const count = chunks.length, sum = digest(value);
    for (let index = 0; index < count; index++) {
      const sealed = secretBox.seal(chunks[index], context(generation, type, id, index));
      await store.run(`INSERT INTO whatsapp_qr_auth (generation,record_type,record_id,chunk_index,chunk_count,ciphertext,key_id,digest,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, generation, type, id, index, count, sealed.sealed, sealed.keyId, sum, at);
    }
  }
  return {
    sellerTransaction: fn => store.transaction(async () => {
      const session = await store.get(`SELECT * FROM whatsapp_qr_session WHERE id = 1${store.dialect === 'postgres' ? ' FOR UPDATE' : ''}`);
      const time = now(), at = new Date(time).toISOString();
      const changed = await store.get('UPDATE whatsapp_qr_session SET revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ? RETURNING id', at, session.revision);
      if (!changed) fail('REVISION');
      session.revision++;
      await expirePair(session, time, at);
      return fn(session, time, at);
    }),
    phoneHash: async (phone, session = null, initialize = false) => {
      session ??= await store.get('SELECT * FROM whatsapp_qr_session WHERE id = 1');
      if (!session.peer_key_sealed && !initialize) return null;
      return hash(await peerKey(session, new Date(now()).toISOString()), phone.replace(/\D/g, ''));
    },
    maskPeer: thread => {
      if (!thread.peer_sealed || thread.suppressed_at) return null;
      const peer = secretBox.open(Buffer.from(thread.peer_sealed), thread.peer_key_id, threadContext(thread.id));
      return peer.endsWith('@lid') ? 'Hidden' : `+••••${peer.split('@')[0].slice(-4)}`;
    },
    control: worker => transact(worker, null, async (session, time, at) => {
      await expirePair(session, time, at);
      await store.run('UPDATE whatsapp_qr_session SET lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, qr_text = CASE WHEN qr_expires_at <= ? THEN NULL ELSE qr_text END, qr_expires_at = CASE WHEN qr_expires_at <= ? THEN NULL ELSE qr_expires_at END WHERE id = 1', worker, new Date(time + 60000).toISOString(), at, at, at);
      await store.run(`UPDATE message_thread_message SET body = NULL WHERE id IN (SELECT id FROM message_thread_message WHERE body IS NOT NULL AND created_at < ? ORDER BY created_at,id LIMIT 200)`, new Date(time - 30 * 86400000).toISOString());
      await store.run(`UPDATE message_thread_message SET status = 'RECONCILE', updated_at = ? WHERE status = 'SENDING' AND id IN (SELECT id FROM message_thread_message WHERE status = 'SENDING' AND lease_expires_at <= ? ORDER BY created_at,id LIMIT 200)`, at, at);
      return { generation: session.generation, desired: session.desired, leaseSeconds: 60, pollMs: 2000 };
    }, true),
    state: (worker, body) => transact(worker, body.generation, async (session, time, at) => {
      if (!['IDLE','PAIRING','CONNECTING','CONNECTED','RECONNECTING','LOGGED_OUT','ERROR'].includes(body.state)) invalid();
      if (body.qr !== undefined && (body.state !== 'PAIRING' || !printable(body.qr, 1024))) invalid();
      if (body.phone !== undefined && (typeof body.phone !== 'string' || !/^\d{8,15}$/.test(body.phone))) invalid();
      if (body.reason !== undefined && !validCode(body.reason)) invalid();
      let masked = session.phone_masked, phoneHash = session.phone_hash;
      if (body.phone) {
        masked = `+${body.phone.slice(0, 2)}${'•'.repeat(body.phone.length - 6)}${body.phone.slice(-4)}`;
        phoneHash = hash(await peerKey(session, at), body.phone);
      }
      const timedOut = session.desired === 'OFF' && session.last_error === 'PAIRING_TIMEOUT';
      const qr = timedOut ? null : body.qr ?? null;
      await store.run(`UPDATE whatsapp_qr_session SET state = ?, desired = ?, qr_text = ?, qr_expires_at = ?, phone_masked = ?, phone_hash = ?, last_error = ?, auth_version = ? WHERE id = 1`, body.state, body.state === 'LOGGED_OUT' ? 'OFF' : body.state === 'CONNECTED' && session.desired === 'PAIR' ? 'RUN' : session.desired, qr, qr ? new Date(time + 60000).toISOString() : null, masked, phoneHash, timedOut ? session.last_error : body.reason ?? (body.state === 'IDLE' && session.last_error === 'PAIRING_TIMEOUT' ? session.last_error : null), body.state === 'LOGGED_OUT' ? session.auth_version + 1 : session.auth_version);
      if (body.state === 'LOGGED_OUT') await store.run('DELETE FROM whatsapp_qr_auth');
    }),
    getAuth: (worker, generation) => transact(worker, generation, async session => {
      const rows = await store.all('SELECT * FROM whatsapp_qr_auth WHERE generation = ? ORDER BY record_type,record_id,chunk_index', generation);
      const groups = new Map();
      for (const row of rows) {
        const key = JSON.stringify([row.record_type, row.record_id]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      let creds = null; const keys = [];
      for (const chunks of groups.values()) {
        try {
          const first = chunks[0];
          if (chunks.length !== first.chunk_count) continue;
          let value = '';
          for (let index = 0; index < chunks.length; index++) {
            const row = chunks[index];
            if (row.chunk_index !== index || row.chunk_count !== chunks.length || row.digest !== first.digest) throw new Error('CHUNKS');
            value += secretBox.open(Buffer.from(row.ciphertext), row.key_id, context(generation, row.record_type, row.record_id, index));
          }
          if (digest(value) !== first.digest) continue;
          if (first.record_type === 'creds') creds = value;
          else keys.push({ type: first.record_type, id: first.record_id, value });
        } catch { /* Corrupt or unavailable-key records are never returned to the worker. */ }
      }
      return { version: session.auth_version, creds, keys };
    }),
    putAuth: (worker, body) => transact(worker, body.generation, async (session, time, at) => {
      if (!Number.isSafeInteger(body.version) || body.version < 0) invalid();
      if (body.version !== session.auth_version) fail('AUTH_VERSION');
      const sets = body.set ?? [], deletes = body.delete ?? [];
      if (!Array.isArray(sets) || !Array.isArray(deletes) || sets.length + deletes.length > 500 || !sets.every(row => recordIdentity(row) && string(row.value, 1, 262144)) || !deletes.every(recordIdentity)) invalid();
      if (body.creds !== undefined && !string(body.creds, 1, 262144)) invalid();
      for (const row of deletes) await store.run('DELETE FROM whatsapp_qr_auth WHERE generation = ? AND record_type = ? AND record_id = ?', body.generation, row.type, row.id);
      for (const row of sets) await writeRecord(body.generation, row.type, row.id, row.value, at);
      if (body.creds !== undefined) await writeRecord(body.generation, 'creds', 'creds', body.creds, at);
      const count = await store.get("SELECT COUNT(*) AS count FROM (SELECT record_type,record_id FROM whatsapp_qr_auth WHERE generation = ? AND record_type <> 'creds' GROUP BY record_type,record_id) AS records", body.generation);
      if (Number(count.count) > 5000) fail('AUTH_LIMIT', 400);
      const result = await store.get('UPDATE whatsapp_qr_session SET auth_version = auth_version + 1 WHERE id = 1 AND auth_version = ? RETURNING auth_version', body.version);
      if (!result) fail('AUTH_VERSION');
      return { version: result.auth_version };
    }),
    inbound: (worker, body) => transact(worker, body.generation, async (session, time, at) => {
      if (!Array.isArray(body.messages) || body.messages.length > 50 || !body.messages.every(row => row && printable(row.id, 128) && validPeer(row.peer) && string(row.name, 0, 200) && string(row.text, 1, 4096) && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) && /T.*Z$/.test(row.at) && Date.parse(row.at) <= time)) invalid();
      const key = await peerKey(session, at); let accepted = 0, duplicates = 0;
      for (const row of body.messages) {
        if (await store.get("SELECT id FROM message_thread_message WHERE direction = 'IN' AND provider_message_id = ?", row.id)) { duplicates++; continue; }
        const peerHash = hash(key, row.peer), receivedAt = new Date(row.at).toISOString();
        const phoneHash = row.peer.endsWith('@s.whatsapp.net') ? hash(key, row.peer.split('@')[0]) : null;
        const suppression = phoneHash ? await store.get('SELECT created_at FROM message_peer_suppression WHERE phone_hash = ?', phoneHash) : null;
        let thread = await store.get('SELECT id,suppressed_at FROM message_thread WHERE peer_hash = ?', peerHash);
        if (!thread) {
          thread = { id: randomUUID(), suppressed_at: suppression?.created_at ?? null };
          const sealed = thread.suppressed_at ? null : secretBox.seal(row.peer, threadContext(thread.id));
          await store.run(`INSERT INTO message_thread (id,provider,peer_hash,peer_sealed,peer_key_id,display_name,phone_hash,suppressed_at,created_at,updated_at) VALUES (?,'WHATSAPP_QR',?,?,?,?,?,?,?,?)`, thread.id, peerHash, sealed?.sealed ?? null, sealed?.keyId ?? session.peer_key_id, thread.suppressed_at ? null : row.name, phoneHash, thread.suppressed_at, at, at);
        } else if (suppression && !thread.suppressed_at) {
          thread.suppressed_at = suppression.created_at;
          await store.run('UPDATE message_thread SET suppressed_at = ?, display_name = NULL, peer_sealed = NULL WHERE id = ?', thread.suppressed_at, thread.id);
          await store.run('UPDATE message_thread_message SET body = NULL WHERE thread_id = ?', thread.id);
        }
        await store.run(`INSERT INTO message_thread_message (id,thread_id,direction,provider_message_id,body,status,generation,created_at,updated_at) VALUES (?,?,'IN',?,?,'RECEIVED',?,?,?)`, randomUUID(), thread.id, row.id, thread.suppressed_at ? null : row.text, body.generation, receivedAt, at);
        await store.run(`UPDATE message_thread SET display_name = ?, last_inbound_at = CASE WHEN last_inbound_at IS NULL OR last_inbound_at < ? THEN ? ELSE last_inbound_at END, last_message_at = CASE WHEN last_message_at IS NULL OR last_message_at < ? THEN ? ELSE last_message_at END, unread_count = unread_count + 1, updated_at = ? WHERE id = ?`, thread.suppressed_at ? null : row.name, receivedAt, receivedAt, receivedAt, receivedAt, at, thread.id);
        accepted++;
      }
      return { accepted, duplicates };
    }),
    claim: (worker, body) => transact(worker, body.generation, async (session, time, at) => {
      const cutoff = new Date(time - 86400000).toISOString();
      await store.run(`UPDATE message_thread_message SET status = 'FAILED', error_code = 'NOT_ELIGIBLE', updated_at = ? WHERE direction = 'OUT' AND status = 'QUEUED' AND (generation <> ? OR ? <> 'CONNECTED' OR body IS NULL OR thread_id IN (SELECT id FROM message_thread WHERE suppressed_at IS NOT NULL OR last_inbound_at IS NULL OR last_inbound_at < ?))`, at, body.generation, session.state, cutoff);
      if (session.state !== 'CONNECTED' || (session.last_claim_at && time - Date.parse(session.last_claim_at) < 5000) || await store.get("SELECT id FROM message_thread_message WHERE status = 'SENDING' LIMIT 1")) return { reply: null };
      const row = await store.get(`SELECT m.*,t.peer_sealed,t.peer_key_id FROM message_thread_message m JOIN message_thread t ON t.id = m.thread_id WHERE m.status = 'QUEUED' AND m.direction = 'OUT' AND m.generation = ? ORDER BY m.created_at,m.id LIMIT 1`, body.generation);
      if (!row) return { reply: null };
      const peer = secretBox.open(Buffer.from(row.peer_sealed), row.peer_key_id, threadContext(row.thread_id));
      if (!validPeer(peer)) fail('INVALID_PEER');
      const changed = await store.get("UPDATE message_thread_message SET status = 'SENDING', attempts = attempts + 1, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED' RETURNING id", new Date(time + 60000).toISOString(), at, row.id);
      if (!changed) fail('REPLY_STATUS');
      await store.run('UPDATE whatsapp_qr_session SET last_claim_at = ? WHERE id = 1', at);
      return { reply: { id: row.id, peer, text: row.body } };
    }),
    result: (worker, id, body) => transact(worker, body.generation, async (session, time, at) => {
      if (!['SENT','FAILED','UNKNOWN'].includes(body.status) || (body.status === 'SENT' && !printable(body.providerMessageId, 128)) || (body.status === 'FAILED' && !validCode(body.code))) invalid();
      const changed = await store.get(`UPDATE message_thread_message SET status = ?, provider_message_id = ?, error_code = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND direction = 'OUT' AND status = 'SENDING' AND generation = ? AND lease_expires_at > ? RETURNING thread_id`, body.status === 'UNKNOWN' ? 'RECONCILE' : body.status, body.providerMessageId ?? null, body.code ?? null, at, id, body.generation, at);
      if (!changed) fail('REPLY_STATUS');
      if (body.status === 'SENT') await store.run('UPDATE message_thread SET last_message_at = ?, updated_at = ? WHERE id = ?', at, at, changed.thread_id);
    }),
  };
}
