import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ApiError, json, readBody } from '../http.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { mediaHash } from './media-policy.js';
import { detectMediaMime } from './media-file-download.js';
import { uploadMediaBytes } from './media-file-upload.js';
import { MEDIA_LIMITS } from './media-schema.js';

const TTL = 300000;
let outstanding = 0, receiving = 0;
const unavailable = () => { throw new ApiError(410, 'MEDIA_UPLOAD_UNAVAILABLE', 'Upload link expired or already used. Request a new upload link.'); };
const conflict = () => { throw new ApiError(409, 'MEDIA_UPLOAD_CONFLICT', 'Upload intent changed. Use a new idempotency key.'); };
const inputError = () => { throw new ApiError(400, 'MEDIA_UPLOAD_CONTENT', 'Image size, format or SHA-256 does not match the upload request.'); };
const target = args => ({ productId: args.productId, targetSlot: args.targetSlot, expectedRevision: args.expectedRevision });

// This bounded capability is deliberately process-local. Restart or a different
// instance fails closed; no signing key or OAuth bearer is persisted or returned.
// After successful PUT the existing database stage/proposal is durable.
export function createMediaUploadUrls({ binding, coordinator, prepare }) {
  const key = randomBytes(32), records = new Map();
  const sign = body => createHmac('sha256', key).update(binding.issuer + '\n' + body).digest('base64url');
  function remove(id, record) {
    if (records.get(id) !== record) return;
    records.delete(id); outstanding--; record.bearer = null; clearTimeout(record.timer);
  }
  function lookup(token) {
    if (typeof token !== 'string' || token.length > 160 ||
        !/^[0-9a-f-]{36}\.[0-9]{13}\.[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/.test(token)) unavailable();
    const split = token.lastIndexOf('.'), body = token.slice(0, split), mac = token.slice(split + 1);
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(sign(body)))) unavailable();
    const record = records.get(token.slice(0, 36));
    if (!record || record.token !== token || record.used || Date.now() >= record.expires) unavailable();
    return record;
  }
  async function authorize(record, bearer = record.bearer) {
    const context = await coordinator.preflight(bearer, target(record.args));
    if (canonicalOperationJson(context) !== record.context) throw new ApiError(403, 'FORBIDDEN', 'Upload authorization changed.');
  }
  const result = record => ({ stageId: record.stageId, uploadUrl: binding.issuer + '/media/upload/' + record.token,
    method: 'PUT', expiresAt: new Date(record.expires).toISOString() });
  async function issue(args, bearer) {
    const context = await coordinator.preflight(bearer, target(args));
    const now = Date.now();
    for (const [id, record] of records) if (record.expires <= now) remove(id, record);
    const owner = canonicalOperationJson([context.tenantId, context.accountId, context.clientId]);
    const identity = mediaHash(canonicalOperationJson(['media.request_upload_url', owner, context.grantId, args.idempotencyKey]));
    // Stable across restarts for the database's existing idempotency contract.
    const stageId = `${identity.slice(0,8)}-${identity.slice(8,12)}-5${identity.slice(13,16)}-8${identity.slice(17,20)}-${identity.slice(20,32)}`;
    const requestHash = mediaHash(canonicalOperationJson(args)), existing = records.get(stageId);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.context !== canonicalOperationJson(context)) conflict();
      if (existing.used) unavailable();
      return result(existing);
    }
    if (records.size >= MEDIA_LIMITS.tenantSlots || outstanding >= 256 ||
        [...records.values()].filter(record => record.owner === owner).length >= MEDIA_LIMITS.clientSlots) {
      throw new ApiError(429, 'MEDIA_QUOTA', 'Upload link quota exceeded. Retry after existing links expire.');
    }
    const expires = Math.min(now + TTL, Date.parse(context.grantExpiresAt));
    if (expires <= now) unavailable();
    const body = stageId + '.' + expires + '.' + randomBytes(24).toString('base64url');
    const record = { stageId, token: body + '.' + sign(body), expires, owner, args: { ...args }, requestHash,
      context: canonicalOperationJson(context), bearer, used: false };
    records.set(stageId, record); outstanding++;
    record.timer = setTimeout(() => remove(stageId, record), expires - now); record.timer.unref();
    return result(record);
  }
  async function handle(request, token) {
    const record = lookup(token);
    await authorize(record);
    // Recheck after asynchronous authorization so concurrent PUTs cannot claim twice.
    lookup(token);
    if (request.method === 'GET') {
      const html = (await readFile(new URL('./upload-picker.html', import.meta.url), 'utf8'))
        .replace('UPLOAD_BYTES', String(record.args.declaredBytes));
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (request.method !== 'PUT') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or PUT.', { Allow: 'GET, PUT' });
    if (receiving >= 4) throw new ApiError(503, 'MEDIA_BUSY', 'Image upload is busy. Retry later.');
    const bearer = record.bearer;
    record.used = true; record.bearer = null; receiving++;
    try {
      const length = request.headers.get('content-length'), encoding = request.headers.get('content-encoding');
      const mime = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if ((length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== record.args.declaredBytes)) ||
          (encoding && encoding !== 'identity') || (mime && mime !== 'application/octet-stream' && mime !== record.args.sourceMime)) inputError();
      const bytes = Buffer.from(await readBody(request, record.args.declaredBytes, Math.max(1, Math.min(10000, record.expires - Date.now()))));
      if (Date.now() >= record.expires) unavailable();
      if (bytes.length !== record.args.declaredBytes || bytes.length > MEDIA_LIMITS.sourceBytes ||
          detectMediaMime(bytes) !== record.args.sourceMime ||
          (record.args.sourceSha256 && mediaHash(bytes) !== record.args.sourceSha256)) inputError();
      await authorize(record, bearer);
      // Namespaced keys prevent collisions with a caller's existing Base64 intent.
      const operation = await uploadMediaBytes({ args: { ...record.args,
        idempotencyKey: mediaHash('media.request_upload_url:begin:' + record.args.idempotencyKey) },
      bytes, mime: record.args.sourceMime, stageId: record.stageId, bearer, coordinator, prepare });
      operation.reviewUrl = binding.issuer + '/oauth/operation?operationId=' + operation.operationId;
      return json(201, { stageId: record.stageId, sourceSha256: mediaHash(bytes), byteLength: bytes.length, operation });
    } finally { receiving--; }
  }
  return Object.freeze({ issue, handle });
}
