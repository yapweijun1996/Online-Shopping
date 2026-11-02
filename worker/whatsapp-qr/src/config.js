import { readFileSync } from 'node:fs';
export function readConfig(env = process.env) {
  const url = new URL(env.WHATSAPP_QR_BACKEND_URL || 'http://backend:3001/internal/whatsapp-qr');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('CONFIG_URL');
  if (!env.WHATSAPP_QR_TOKEN_FILE) throw new Error('CONFIG_TOKEN');
  const token = readFileSync(env.WHATSAPP_QR_TOKEN_FILE, 'utf8').split(/\r?\n/)[0];
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('CONFIG_TOKEN');
  return { url: url.href.replace(/\/$/, ''), token };
}
