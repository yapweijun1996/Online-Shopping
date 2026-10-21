import { randomUUID } from 'node:crypto';
export class ApiError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
export class Client {
  constructor({ url, token, workerId = randomUUID() }) { Object.assign(this, { url, token, workerId }); }
  async request(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(this.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${this.token}`, 'X-Worker-Id': this.workerId, 'Content-Type': 'application/json', ...(this.bindingEpoch ? { 'X-Binding-Epoch': String(this.bindingEpoch) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const chunks = []; let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 512 * 1024) throw new ApiError('RESPONSE_LIMIT', response.status); chunks.push(value); } }
      catch (error) { await reader.cancel(); throw error; }
      finally { reader.releaseLock(); }
    }
    let data;
    try { data = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { throw new ApiError('RESPONSE_JSON', response.status); }
    if (!response.ok) throw new ApiError(response.status === 401 ? 'UNAUTHORIZED' : ['QR_REVOKED', 'STALE_GENERATION', 'LEASE_HELD', 'AUTH_VERSION'].includes(data?.error) ? data.error : 'BACKEND_ERROR', response.status);
    const epoch = Number(response.headers.get('x-binding-epoch'));
    if (Number.isSafeInteger(epoch) && epoch > 0) this.bindingEpoch = epoch;
    return data;
  }
}
