import { createHash, randomUUID } from 'node:crypto';
import { ApiError, json, readJson } from '../http.js';
import { SqlLimiter } from '../limiter.js';
import { createWhatsAppQrStore } from './store.js';

const missing = () => { throw new ApiError(404, 'NOT_FOUND', 'Not found.'); };
const message = row => ({ id: row.id, direction: row.direction, text: row.body, status: row.status, errorCode: row.error_code, createdAt: row.created_at, actor: row.actor });
const reason = (s, t, time) => s.desired === 'OFF' || s.state !== 'CONNECTED' ? 'NOT_CONNECTED' : t.suppressed_at ? 'SUPPRESSED' : !t.last_inbound_at || Date.parse(t.last_inbound_at) < time - 86400000 ? 'WINDOW_EXPIRED' : null;
const integer = (value, fallback, max) => {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new ApiError(400, 'INVALID_QUERY', 'Invalid pagination.');
  return Number(value);
};
export function createQrSellerApi({ store, secretBox, shopId = 'default', now = Date.now }) {
  const qr = createWhatsAppQrStore({ store, secretBox, shopId, now });
  const limiter = (bucket, limit, windowMs) => new SqlLimiter(store, bucket, { limit, windowMs, now });
  const shopPair = limiter('qr-pair-shop', 3, 900000), addressPair = limiter('qr-pair-address', 5, 900000);
  const shopReply = limiter('qr-reply-shop', 20, 3600000), threadReply = limiter('qr-reply-thread', 5, 60000);
  const limited = seconds => json(429, { error: { code: 'RATE_LIMITED', message: 'Too many attempts.' } }, { 'Retry-After': String(seconds), 'Cache-Control': 'no-store' });
  const denyLimit = seconds => { const error = new ApiError(429, 'RATE_LIMITED', 'Too many attempts.'); error.retryAfter = seconds; throw error; };
  return async ({ request, url, account, allow, clientAddress }) => {
    const path = url.pathname, method = request.method;
    const connection = /^\/api\/v1\/seller\/integrations\/whatsapp-qr(?:\/(acknowledge|pair|disconnect))?$/.exec(path);
    const chat = /^\/api\/v1\/seller\/chats(?:\/([^/]+)\/(messages|read|replies|orders))?$/.exec(path);
    if (!connection && !chat) return missing();
    if (connection && method === 'POST') allow('settings.write');
    if (chat) allow(chat[2] === 'replies' ? 'chats.reply' : 'orders.fulfil');
    const body = method === 'POST' ? await readJson(request, 32768) : null;
    return qr.sellerTransaction(async (session, time, at) => {
      if (connection) {
        const status = () => ({ available: true, desired: session.desired, state: session.state, generation: session.generation, phoneMasked: session.phone_masked, lastError: session.last_error, acknowledged: session.ack_notice_version === '1', qr: account.role === 'OWNER' && session.state === 'PAIRING' && session.qr_expires_at > at ? session.qr_text : null, qrExpiresAt: session.state === 'PAIRING' && session.qr_expires_at > at ? session.qr_expires_at : null });
        if (method === 'GET' && !connection[1]) return json(200, status());
        if (method !== 'POST' || !connection[1]) return missing();
        const action = connection[1];
        if (action === 'acknowledge') {
          if (body.noticeVersion !== 1 || Object.keys(body).length !== 1) throw new ApiError(400, 'INVALID_BODY', 'Notice version 1 required.');
          await store.run("UPDATE whatsapp_qr_session SET acknowledged_at = ?, acknowledged_by = ?, ack_notice_version = '1' WHERE id = 1", at, account.username);
        } else if (action === 'pair') {
          if (session.ack_notice_version !== '1') throw new ApiError(409, 'ACKNOWLEDGEMENT_REQUIRED', 'Acknowledge the risk first.');
          if (!await shopPair.attempt('default') || !await addressPair.attempt(clientAddress)) return limited(900);
          if (session.desired === 'OFF' || ['LOGGED_OUT','ERROR','IDLE'].includes(session.state)) {
            await store.run("UPDATE whatsapp_qr_session SET generation = generation + 1, auth_version = 0, desired = 'PAIR', pair_started_at = ?, last_error = NULL, qr_text = NULL, qr_expires_at = NULL WHERE id = 1", at);
            await store.run('DELETE FROM whatsapp_qr_auth');
          }
        } else {
          await store.run("UPDATE whatsapp_qr_session SET generation = generation + 1, auth_version = 0, desired = 'OFF', qr_text = NULL, qr_expires_at = NULL WHERE id = 1");
          await store.run('DELETE FROM whatsapp_qr_auth');
          await store.run("UPDATE message_thread_message SET status = 'CANCELLED', updated_at = ? WHERE direction = 'OUT' AND status = 'QUEUED'", at);
        }
        await store.run("INSERT INTO integration_audit (id,provider,environment,action,actor,detail,created_at) VALUES (?,'WHATSAPP_QR','PRODUCTION',?,?,?,?)", randomUUID(), { acknowledge: 'RISK_ACKNOWLEDGED', pair: 'CONNECT', disconnect: 'DISCONNECT' }[action], account.username, action === 'acknowledge' ? 'noticeVersion=1' : null, at);
        return json(200, { ok: true });
      }
      const id = chat[1], action = chat[2];
      if (!id && method === 'GET') {
        const rows = await store.all('SELECT message_thread.*, (SELECT body FROM message_thread_message WHERE thread_id = message_thread.id ORDER BY created_at DESC,id DESC LIMIT 1) AS last_message_text FROM message_thread ORDER BY last_message_at DESC,id DESC LIMIT ? OFFSET ?', integer(url.searchParams.get('limit'), 50, 50), integer(url.searchParams.get('offset'), 0, 10000));
        return json(200, rows.map(t => ({ id: t.id, displayName: t.display_name, peerMasked: qr.maskPeer(t), lastMessageText: t.last_message_text, lastMessageAt: t.last_message_at, lastInboundAt: t.last_inbound_at, unreadCount: t.unread_count, canReply: !reason(session, t, time), replyWindowEndsAt: t.last_inbound_at ? new Date(Date.parse(t.last_inbound_at) + 86400000).toISOString() : null })));
      }
      const thread = await store.get('SELECT * FROM message_thread WHERE id = ?', id);
      if (!thread) return missing();
      if (method === 'GET' && action === 'messages') {
        const before = url.searchParams.get('before');
        const cursor = before ? await store.get('SELECT created_at,id FROM message_thread_message WHERE id = ? AND thread_id = ?', before, id) : null;
        if (before && !cursor) throw new ApiError(400, 'INVALID_QUERY', 'Invalid cursor.');
        const rows = await store.all(`SELECT * FROM message_thread_message WHERE thread_id = ?${cursor ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`, id, ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []), integer(url.searchParams.get('limit'), 100, 100));
        return json(200, rows.reverse().map(message));
      }
      if (method === 'GET' && action === 'orders') {
        if (!thread.phone_hash || thread.suppressed_at) return json(200, { suggested: [] });
        const orders = await store.all('SELECT * FROM (SELECT id,order_no,status,submitted_at,buyer_phone,contact_erased_at FROM shop_order ORDER BY submitted_at DESC,id DESC LIMIT 500) AS recent WHERE contact_erased_at IS NULL ORDER BY submitted_at DESC,id DESC');
        const recipients = orders.length ? await store.all(`SELECT order_id,recipient_phone FROM delivery WHERE order_id IN (${orders.map(() => '?').join(',')})`, ...orders.map(order => order.id)) : [];
        const phonesByOrder = new Map();
        for (const row of recipients) {
          if (!phonesByOrder.has(row.order_id)) phonesByOrder.set(row.order_id, []);
          phonesByOrder.get(row.order_id).push(row.recipient_phone);
        }
        const matches = [];
        for (const order of orders) {
          const phones = [order.buyer_phone, ...(phonesByOrder.get(order.id) ?? [])];
          if ((await Promise.all(phones.filter(Boolean).map(p => qr.phoneHash(p, session)))).includes(thread.phone_hash)) matches.push({ id: order.id, orderNo: order.order_no, status: order.status, submittedAt: order.submitted_at });
          if (matches.length === 5) break;
        }
        return json(200, { suggested: matches });
      }
      if (method === 'POST' && action === 'read') {
        await store.run('UPDATE message_thread SET unread_count = 0, updated_at = ? WHERE id = ?', at, id);
        return json(200, { unreadCount: 0 });
      }
      if (method === 'POST' && action === 'replies') {
        const key = request.headers.get('Idempotency-Key'), text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key) || !text || text.length > 4096 || !text.isWellFormed() || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text) || Object.keys(body).some(k => k !== 'text')) throw new ApiError(400, 'INVALID_BODY', 'Invalid reply.');
        const digest = createHash('sha256').update(JSON.stringify([id, text])).digest('hex');
        const previous = await store.get('SELECT * FROM message_thread_message WHERE idempotency_key = ?', key);
        if (previous) {
          if (previous.body_digest !== digest) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Intent already used.');
          return json(200, message(previous));
        }
        const why = reason(session, thread, time);
        if (why) return json(409, { error: { code: 'NOT_ELIGIBLE', message: 'This thread is not eligible for a reply.' }, reason: why });
        const queued = await store.get("SELECT COUNT(*) AS count FROM message_thread_message WHERE direction = 'OUT' AND status IN ('QUEUED','SENDING')");
        if (Number(queued.count) >= 50) return limited(60);
        if (!await shopReply.attempt('default')) denyLimit(3600);
        if (!await threadReply.attempt(id)) denyLimit(60);
        const messageId = randomUUID();
        await store.run("INSERT INTO message_thread_message (id,thread_id,direction,body,status,generation,actor,idempotency_key,body_digest,created_at,updated_at) VALUES (?,?,'OUT',?,'QUEUED',?,?,?,?,?,?)", messageId, id, text, session.generation, account.username, key, digest, at, at);
        await store.run('UPDATE message_thread SET last_message_at = ?, updated_at = ? WHERE id = ?', at, at, id);
        return json(201, message(await store.get('SELECT * FROM message_thread_message WHERE id = ?', messageId)));
      }
      return missing();
    }).catch(error => {
      if (error.retryAfter) return limited(error.retryAfter);
      throw error;
    });
  };
}
