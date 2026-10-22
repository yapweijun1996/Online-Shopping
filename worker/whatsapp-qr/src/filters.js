// Normalizes WhatsApp events into the rows the backend accepts: direct one-to-one text only (no groups, status,
// broadcasts, newsletters or media). `out` marks a message the linked phone itself sent; `history` marks the one-off
// import that WhatsApp sends right after linking.
const PEER = /^([0-9]+)(?:[.:][0-9]+)?@(s\.whatsapp\.net|lid)$/;
const ALLOWED = ['conversation', 'extendedTextMessage', 'messageContextInfo'];
export const HISTORY_DAYS = 30, HISTORY_LIMIT = 5000;

const seconds = value => typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
function convert(message, names = new Map()) {
  const { key = {}, message: body, pushName = '' } = message;
  const text = body?.conversation ?? body?.extendedTextMessage?.text;
  if (!body || Object.keys(body).some(name => !ALLOWED.includes(name))) return null;
  const peer = PEER.exec(key.remoteJid || '');
  if (!peer || typeof key.id !== 'string' || key.id.length < 1 || key.id.length > 128 || typeof text !== 'string' || text.length < 1 || text.length > 4096) return null;
  const time = seconds(message.messageTimestamp);
  if (!Number.isFinite(time) || time < 0 || time > 8640000000000) return null;
  const jid = `${peer[1]}@${peer[2]}`, out = key.fromMe === true;
  // A message the phone sent carries the owner's own push name, never the customer's.
  const name = out ? '' : String(pushName || names.get(jid) || '').slice(0, 200);
  return { id: key.id, peer: jid, name, at: new Date(time * 1000).toISOString(), text, ...(out ? { out: true } : {}) };
}

/* Live events: new messages ('notify') and messages other devices of this account sent ('append'). */
export function filterMessages(event) {
  if (event.type !== 'notify' && event.type !== 'append') return [];
  return (event.messages || []).flatMap(message => convert(message) ?? []);
}

/* One 'messaging-history.set' event: only the last HISTORY_DAYS days, newest HISTORY_LIMIT messages, names from chats/contacts. */
export function filterHistory(event, now = Date.now()) {
  const names = new Map();
  for (const chat of event.chats || []) if (typeof chat?.id === 'string' && typeof chat.name === 'string' && chat.name) names.set(chat.id, chat.name);
  for (const contact of event.contacts || []) {
    const name = contact?.name || contact?.notify;
    if (typeof contact?.id === 'string' && typeof name === 'string' && name && !names.has(contact.id)) names.set(contact.id, name);
  }
  const since = now - HISTORY_DAYS * 86400000;
  return (event.messages || []).flatMap(message => convert(message, names) ?? [])
    .filter(row => Date.parse(row.at) >= since && Date.parse(row.at) <= now)
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, HISTORY_LIMIT).reverse().map(row => ({ ...row, history: true }));
}
