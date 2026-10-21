import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
const encode = value => JSON.stringify(value, BufferJSON.replacer);
const decode = value => typeof value === 'string' ? JSON.parse(value, BufferJSON.reviver) : JSON.parse(JSON.stringify(value), BufferJSON.reviver);
export async function loadAuth(client, generation, onFailure) {
  const snapshot = await client.request(`/v1/auth?generation=${generation}`);
  let version = snapshot.version;
  const creds = snapshot.creds == null ? initAuthCreds() : decode(snapshot.creds);
  const records = new Map(snapshot.keys.map(row => [`${row.type}:${row.id}`, decode(row.value)]));
  let queue = Promise.resolve(); let failed = false;
  const enqueue = operation => {
    const next = queue.then(async () => { if (failed) throw new Error('AUTH_STOPPED'); return operation(); });
    queue = next.catch(error => { if (!failed) { failed = true; onFailure(error); } });
    return next;
  };
  async function persist(items, includeCreds) {
    for (let offset = 0; offset < Math.max(1, items.length); offset += 500) {
      const batch = items.slice(offset, offset + 500);
      const result = await client.request('/v1/auth', { generation, version, ...(includeCreds && offset === 0 ? { creds: encode(creds) } : {}), set: batch.filter(row => row.value != null).map(row => ({ ...row, value: encode(row.value) })), delete: batch.filter(row => row.value == null).map(({ type, id }) => ({ type, id })) }, 'PUT');
      version = result.version;
    }
  }
  return {
    state: { creds, keys: {
      async get(type, ids) { await queue; if (failed) throw new Error('AUTH_STOPPED'); const result = {}; for (const id of ids) { let value = records.get(`${type}:${id}`); if (value != null) { if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value); result[id] = value; } } return result; },
      set(data) { const items = Object.entries(data).flatMap(([type, entries]) => Object.entries(entries).map(([id, value]) => ({ type, id, value }))); return enqueue(async () => { await persist(items, true); for (const { type, id, value } of items) { if (value == null) records.delete(`${type}:${id}`); else records.set(`${type}:${id}`, value); } }); }
    } },
    saveCreds(update) { return enqueue(async () => { Object.assign(creds, update); await persist([], true); }); },
    flush() { return queue; }
  };
}
