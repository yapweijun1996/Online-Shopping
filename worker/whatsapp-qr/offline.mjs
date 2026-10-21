import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

// Spike-only in-memory storage. No database, socket, credentials file or production API.
export function storage(key = randomBytes(32)) {
  const records = new Map();
  return {
    records,
    put(id, value) {
      const text = JSON.stringify(value, BufferJSON.replacer);
      const chunks = [];
      for (let offset = 0; offset < text.length; offset += 4096) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(`spike:tenant:connection:1:${id}:${chunks.length}`));
        const body = Buffer.concat([cipher.update(text.slice(offset, offset + 4096), 'utf8'), cipher.final()]);
        chunks.push({ iv, body, tag: cipher.getAuthTag() });
      }
      records.set(id, { chunks, digest: createHash('sha256').update(text).digest('hex') });
    },
    get(id) {
      const record = records.get(id);
      if (!record) return null;
      const text = record.chunks.map(({ iv, body, tag }, index) => {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(`spike:tenant:connection:1:${id}:${index}`));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      }).join('');
      if (createHash('sha256').update(text).digest('hex') !== record.digest) throw new Error('incomplete record');
      return JSON.parse(text, BufferJSON.reviver);
    },
    delete(id) { records.delete(id); }
  };
}

export async function workload(count = 100) {
  const store = storage();
  const creds = initAuthCreds();
  store.put('creds', creds);
  // Mirrors socket.js pair-device's four-field composition; not the socket event path.
  const qr = ['synthetic-reference', creds.noiseKey.public.toString('base64'),
    creds.signedIdentityKey.public.toString('base64'), creds.advSecretKey].join(',');
  const png = await QRCode.toBuffer(qr, { type: 'png' });
  for (let i = 0; i < count; i++) {
    store.put(`session:${i}`, { binary: randomBytes(16384) });
    store.get(`session:${i}`);
  }
  const appKey = proto.Message.AppStateSyncKeyData.fromObject({ keyData: randomBytes(32) });
  store.put('app-state-sync-key', appKey);
  return { store, creds, qr, png, appKey };
}
