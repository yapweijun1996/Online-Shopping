import { timingSafeEqual } from 'node:crypto';
import { ApiError, json, readJson } from '../http.js';
import { createWhatsAppQrStore, QrError } from './store.js';

const prefix = '/internal/whatsapp-qr/v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createWhatsAppQrInternalApi({ store, secretBox, token, now }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('Invalid WhatsApp QR worker token.');
  const expected = Buffer.from(`Bearer ${token}`), data = createWhatsAppQrStore({ store, secretBox, now });
  return async request => {
    const supplied = Buffer.from(request.headers.get('authorization') ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const url = new URL(request.url), path = url.pathname, method = request.method;
    const result = path.match(/^\/internal\/whatsapp-qr\/v1\/replies\/([0-9a-f-]{36})\/result$/i);
    const route = method === 'GET' && path === `${prefix}/control` ? 'control'
      : method === 'GET' && path === `${prefix}/auth` ? 'getAuth'
      : method === 'PUT' && path === `${prefix}/auth` ? 'putAuth'
      : method === 'POST' && path === `${prefix}/state` ? 'state'
      : method === 'POST' && path === `${prefix}/inbound` ? 'inbound'
      : method === 'POST' && path === `${prefix}/replies/claim` ? 'claim'
      : method === 'POST' && result && uuid.test(result[1]) ? 'result' : null;
    if (!route) return json(404, { error: 'NOT_FOUND' });
    try {
      const worker = request.headers.get('x-worker-id');
      if (!uuid.test(worker ?? '')) throw new QrError(400, 'INVALID_WORKER_ID');
      if (route === 'control') return json(200, await data.control(worker));
      if (route === 'getAuth') {
        const raw = url.searchParams.get('generation');
        if (!/^[1-9]\d*$/.test(raw ?? '') || !Number.isSafeInteger(Number(raw))) throw new QrError(400, 'INVALID_GENERATION');
        return json(200, await data.getAuth(worker, Number(raw)));
      }
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new QrError(415, 'JSON_REQUIRED');
      const body = await readJson(request, route === 'putAuth' ? 256 * 1024 : 64 * 1024);
      if (!Number.isSafeInteger(body.generation) || body.generation < 1) throw new QrError(400, 'INVALID_GENERATION');
      const value = route === 'result' ? await data.result(worker, result[1], body) : await data[route](worker, body);
      return value === undefined ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : json(200, value);
    } catch (error) {
      if (error instanceof QrError || error instanceof ApiError) return json(error.status, { error: error.code });
      return json(500, { error: 'INTERNAL_ERROR' });
    }
  };
}
