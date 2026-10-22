// Normalizes WhatsApp events into the rows the backend accepts: direct one-to-one text only (no groups, status,
// broadcasts, newsletters, media or the account's own self-chat). `out` marks a message the linked phone itself sent;
// `history` marks the one-off import that WhatsApp sends right after linking. Every row is checked here exactly as the
// backend checks it, so one odd message from a customer's client can never get a whole batch refused.
const PEER = /^([0-9]{1,30})(?:[.:][0-9]+)?@(s\.whatsapp\.net|lid)$/;
const ALLOWED = ['conversation', 'extendedTextMessage', 'messageContextInfo'];
export const HISTORY_DAYS = 30, HISTORY_LIMIT = 5000;

const seconds = value => typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
const wellFormed = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0');
// Truncates by code point so a surrogate pair is never cut in half.
const clip = (value, max) => { const text = [...String(value ?? '')].slice(0, max).join(''); return wellFormed(text) ? text : ''; };
export const digits = jid => /^([0-9]+)/.exec(String(jid ?? ''))?.[1] ?? null;

function convert(message, { names = new Map(), now = Date.now(), self = new Set() } = {}) {
  const { key = {}, message: body, pushName = '' } = message;
  const text = body?.conversation ?? body?.extendedTextMessage?.text;
  if (!body || Object.keys(body).some(name => !ALLOWED.includes(name))) return null;
  const peer = PEER.exec(key.remoteJid || '');
  if (!peer || typeof key.id !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(key.id) || !wellFormed(text) || text.length < 1 || text.length > 4096) return null;
  if (self.has(peer[1])) return null;
  const time = seconds(message.messageTimestamp);
  if (!Number.isFinite(time) || time < 0 || time > 8640000000000) return null;
  const jid = `${peer[1]}@${peer[2]}`, out = key.fromMe === true;
  // A message the phone sent carries the owner's own push name, never the customer's.
  const name = out ? '' : clip(pushName || names.get(jid), 200);
  // A LID address hides the phone number; WhatsApp may give it as the alternate JID, which lets erasure and order matching work.
  const alt = peer[2] === 'lid' ? PEER.exec(key.remoteJidAlt || '') : null;
  const phone = alt && alt[2] === 's.whatsapp.net' && /^[0-9]{8,15}$/.test(alt[1]) ? alt[1] : null;
  if (phone && self.has(phone)) return null;
  // A clock that is ahead of the backend must not make the batch invalid.
  return { id: key.id, peer: jid, name, at: new Date(Math.min(time * 1000, now)).toISOString(), text, ...(phone ? { phone } : {}), ...(out ? { out: true } : {}) };
}

/* Live events: new messages ('notify') and messages other devices of this account sent ('append'). */
export function filterMessages(event, options = {}) {
  if (event.type !== 'notify' && event.type !== 'append') return [];
  return (event.messages || []).flatMap(message => convert(message, options) ?? []);
}

/* One 'messaging-history.set' event: only the last HISTORY_DAYS days, at most `limit` newest messages, names from chats/contacts. */
export function filterHistory(event, { now = Date.now(), limit = HISTORY_LIMIT, self = new Set() } = {}) {
  const names = new Map();
  for (const chat of event.chats || []) if (typeof chat?.id === 'string' && typeof chat.name === 'string' && chat.name) names.set(chat.id, chat.name);
  for (const contact of event.contacts || []) {
    const name = contact?.name || contact?.notify;
    if (typeof contact?.id === 'string' && typeof name === 'string' && name && !names.has(contact.id)) names.set(contact.id, name);
  }
  const since = now - HISTORY_DAYS * 86400000;
  return (event.messages || []).flatMap(message => convert(message, { names, now, self }) ?? [])
    .filter(row => Date.parse(row.at) >= since)
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, Math.max(0, limit)).reverse().map(row => ({ ...row, history: true }));
}
