export function filterMessages(event) {
  if (event.type !== 'notify') return [];
  return (event.messages || []).flatMap(message => {
    const { key = {}, message: body, pushName = '' } = message;
    const text = body?.conversation ?? body?.extendedTextMessage?.text;
    if (!body || Object.keys(body).some(key => !['conversation', 'extendedTextMessage', 'messageContextInfo'].includes(key))) return [];
    if (key.fromMe || !/^[0-9]+(?:[.:][0-9]+)?@(s\.whatsapp\.net|lid)$/.test(key.remoteJid || '') || typeof key.id !== 'string' || key.id.length < 1 || key.id.length > 128 || typeof text !== 'string' || text.length < 1 || text.length > 4096) return [];
    const seconds = Number(message.messageTimestamp);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 8640000000000) return [];
    return [{ id: key.id, peer: key.remoteJid, name: String(pushName).slice(0, 200), at: new Date(seconds * 1000).toISOString(), text }];
  });
}
