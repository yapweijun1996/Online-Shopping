import { deploymentProfileAllowsProduction } from './deployment-profile.js';
import { ApiError } from '../http.js';
import { SqlLimiter } from '../limiter.js';
import { operationEpochHash } from './operation-epoch.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { verifyMediaAuthority } from './operation-authorization.js';
import { MEDIA_LIMITS } from './media-schema.js';
import { mediaContext, withMediaWriter } from './media-storage.js';
import { readMediaSnapshot, loadOldMediaAsset } from './media-resources.js';
import { decodeViaSocket } from './media-codec-client.js';
import { createMediaNativeSession } from './media-native.js';
import { isMediaHash, isMediaUuid, mediaObject } from './media-policy.js';
import { makeUploadAdapter } from './media-upload-adapter.js';
import { assertUploadThumbnail } from './media-upload-policy.js';
import { recordMcpAudit } from './audit.js';

const invalid = () => { throw new ApiError(400, 'MEDIA_INPUT', 'Invalid media upload input.'); };
const changed = () => { throw new ApiError(409, 'MEDIA_RESOURCE_CHANGED', 'Media resource changed. Reopen its review.'); };
const denied = () => { throw new ApiError(403, 'FORBIDDEN', 'Media authorization failed.'); };
const coordinators = new WeakSet();
export const isMediaCoordinator = value => coordinators.has(value);

/** Strict canonical independently encoded parts keep every model string <=4096. */
export function decodeMediaParts(parts) {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 12 || Reflect.ownKeys(parts).length !== parts.length + 1) invalid();
  const buffers = [];
  for (let index = 0; index < parts.length; index++) {
    const field = Object.getOwnPropertyDescriptor(parts, String(index));
    if (!field || !Object.hasOwn(field, 'value')) invalid();
    const part = field.value;
    if (typeof part !== 'string' || !part.length || part.length > 4096 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part)) invalid();
    const bytes = Buffer.from(part, 'base64');
    if (!bytes.length || bytes.length > 3072 || bytes.toString('base64') !== part) invalid();
    buffers.push(bytes);
  }
  const bytes = Buffer.concat(buffers);
  if (bytes.length > MEDIA_LIMITS.chunkBytes) invalid();
  return bytes;
}
const readOnly = store => Object.freeze({ dialect: store.dialect, get: (sql, ...args) => {
  if (!/^SELECT\b/.test(sql) || sql.includes(';')) throw new TypeError('Read-only media query required.');
  return store.get(sql, ...args);
}, all: (sql, ...args) => {
  if (!/^SELECT\b/.test(sql) || sql.includes(';')) throw new TypeError('Read-only media query required.');
  return store.all(sql, ...args);
} });

/** Trusted construction only; bearer is a transport credential, never model input. */
export function createMediaCoordinator({ store, binding, tenantGuard, epoch, buildDigest, codec,
  enabled = false, quickLogin, production, profile, decode = decodeViaSocket }) {
  if (enabled !== true || quickLogin !== false || (![true,false].includes(production) || (production === true && (!deploymentProfileAllowsProduction(profile) || decode !== decodeViaSocket))) || !store?.transaction ||
      typeof tenantGuard?.withActiveTenant !== 'function' || !isMediaHash(buildDigest) || !codec || !isMediaHash(codec.digest) ||
      typeof codec.socketPath !== 'string' || !codec.socketPath.startsWith('/') ||
      !/^[A-Za-z0-9_-]{43}$/.test(codec.token ?? '') || typeof decode !== 'function') throw new TypeError('Explicit safe media coordinator configuration required.');
  try {
    const issuer = new URL(binding.issuer);
    if (!binding.tenantId || typeof binding.tenantId !== 'string' || issuer.protocol !== 'https:' || issuer.username ||
        issuer.password || issuer.search || issuer.hash || binding.resource !== binding.issuer + '/mcp') throw 0;
  } catch { throw new TypeError('Secure media binding required.'); }
  if (production === true && (binding?.mcpV2?.enabled !== true || !deploymentProfileAllowsProduction(binding.mcpV2.profile) ||
      canonicalOperationJson(binding.mcpV2.profile) !== canonicalOperationJson(profile) || binding.mcpV2.epoch !== epoch || binding.mcpV2.buildDigest !== buildDigest ||
      typeof binding.mcpV2.epochFile !== 'string' || !binding.mcpV2.epochFile.startsWith('/'))) throw new TypeError('Production media requires its validated epoch binding.');
  binding = Object.freeze({ tenantId: binding.tenantId, issuer: binding.issuer, resource: binding.resource, mcpV2: binding.mcpV2 });
  codec = Object.freeze({ ...codec });
  const epochHash = operationEpochHash(epoch), read = readOnly(store);
  const appendLimiter = new SqlLimiter(store, 'mcp:v2:media-append', { limit: MEDIA_LIMITS.appendCalls, windowMs: MEDIA_LIMITS.rateWindowMs });
  const ordinaryLimiter = new SqlLimiter(store, 'mcp:v2:media-stage', { limit: 120, windowMs: MEDIA_LIMITS.rateWindowMs });
  const guarded = work => tenantGuard.withActiveTenant(binding.tenantId, tenant => {
    if (!Number.isSafeInteger(tenant?.revision) || tenant.revision < 0) denied();
    return store.transaction(() => work(tenant.revision));
  });
  const authority = (bearer, tenantRevision) => verifyMediaAuthority(store, { bearer, binding, epochHash, buildDigest, tenantRevision });
  // Reservation is a separate committed phase: failed chunks still consume an attempt.
  const reserve = (bearer, append) => guarded(async revision => {
    const context = await authority(bearer, revision);
    const key = JSON.stringify([context.tenantId, context.accountId, context.clientId]);
    if (!await (append ? appendLimiter : ordinaryLimiter).attempt(key)) throw new ApiError(429, 'MEDIA_RATE_LIMIT', 'Media upload rate exceeded.');
  });
  const write = (bearer, work) => guarded(async revision => {
    const context = await authority(bearer, revision);
    return withMediaWriter(store, context, writer => work(writer, context, read));
  });
  const shape = (value, fields) => { try { mediaObject(value, fields); } catch { invalid(); } };
  const auditStage = async (writer,context,stage,action) => {
    const stored=await writer.inspect(stage.stageId);
    await recordMcpAudit(store,{tenantId:context.tenantId,accountId:context.accountId,clientId:context.clientId,grantId:context.grantId,
      toolName:'media.prepare_upload',resourceId:stored.productId,operationId:null,correlationId:stored.correlationId,event:'CALL',
      outcome:`STAGE_${action}${stage.replayed?'_REPLAY':''}`,durationMs:0,resultCount:1});
    return stage;
  };
  const inspectTarget = async (reader, productId, slot, expectedRevision) => {
    const snapshot = await readMediaSnapshot(reader, productId);
    if (snapshot.revision !== expectedRevision) changed();
    const view = snapshot.views.find(value => value.productId === productId);
    const target = snapshot.before.products.find(value => value.productId === productId);
    if (!view || !target) changed();
    if (slot === 'GALLERY' && view.role === 'variant') throw new ApiError(409, 'GALLERY_SHARED', 'Edit the shared gallery on its main variant.');
    if (slot === 'GALLERY' && !target.mainAssetKey) throw new ApiError(400, 'MEDIA_MAIN_REQUIRED', 'Add a main image first.');
    return snapshot;
  };
  const begin = async (bearer, input) => {
    await reserve(bearer, false);
    shape(input, ['productId','targetSlot','expectedRevision','sourceSha256','sourceMime','declaredBytes','idempotencyKey']);
    input = { ...input };
    if (!isMediaUuid(input.productId) || !['MAIN','GALLERY'].includes(input.targetSlot) || !isMediaHash(input.expectedRevision)) invalid();
    return write(bearer, async (writer, context, reader) => {
      const stage = await writer.begin({ ...input, codecDigest: codec.digest });
      // Invalid new targets roll back their stage/quota/audit atomically. Existing
      // immutable begin intent remains replayable after later portal changes.
      if(!stage.replayed)await inspectTarget(reader, input.productId, input.targetSlot, input.expectedRevision);
      return auditStage(writer,context,stage,'BEGIN');
    });
  };
  const append = async (bearer, input) => {
    let exact = false;
    try { mediaObject(input, ['stageId','offset','dataParts']); exact = isMediaUuid(input.stageId) &&
      Number.isSafeInteger(input.offset) && input.offset >= 0 && input.offset <= MEDIA_LIMITS.sourceBytes &&
      Array.isArray(input.dataParts) && input.dataParts.length >= 1 && input.dataParts.length <= 12; } catch { /* Ordinary failsafe class. */ }
    await reserve(bearer, exact);
    if (!exact) invalid();
    const stageId = input.stageId, offset = input.offset, bytes = decodeMediaParts(input.dataParts);
    return write(bearer, async (writer,context) => auditStage(writer,context,await writer.append(stageId,offset,bytes),'APPEND'));
  };
  const discard = async (bearer, input) => {
    await reserve(bearer, false);
    shape(input, ['stageId']); if (!isMediaUuid(input.stageId)) invalid();
    const id = input.stageId;
    return write(bearer, async (writer,context) => auditStage(writer,context,await writer.discard(id),'DISCARD'));
  };
  const hooks = Object.freeze({
    policyId: 'media-upload-v1', codecDigest: codec.digest,
    async capture(reader, args, trustedContext, writer) {
      shape(args, ['stageId']); if (!isMediaUuid(args.stageId)) invalid();
      const context = mediaContext(trustedContext), stage = await writer.inspect(args.stageId);
      if (context.tenantId !== binding.tenantId || context.issuer !== binding.issuer || context.resource !== binding.resource ||
          context.epochHash !== epochHash || context.buildDigest !== buildDigest || stage.codecDigest !== codec.digest) denied();
      const snapshot = await inspectTarget(reader, stage.productId, stage.targetSlot, stage.expectedRevision);
      const old = [];
      for (const asset of snapshot.assets) old.push({ ref: asset, bytes: (await loadOldMediaAsset(reader, snapshot, asset)).data });
      const lease = await writer.claimValidation(stage.stageId);
      return { resourceId: stage.productId, expectedRevision: snapshot.revision, resources: { context, stage, snapshot, old, lease } };
    },
    async resolve(captured, { signal, deadline: engineDeadline }) {
      if (!captured || !Number.isFinite(engineDeadline)) invalid();
      const native = createMediaNativeSession(codec, { signal, deadline: engineDeadline, decode });
      const packet = await native.decode(captured.lease.source, captured.lease.sourceMime, captured.lease.sourceSha256);
      for (const asset of captured.old) await native.decode(asset.bytes, asset.ref.mime, asset.ref.byte_sha256);
      const result = { sourceSha256: packet.sourceSha256, image: Buffer.from(packet.image), thumbnail: Buffer.from(packet.thumbnail),
        mime: packet.mime, width: packet.width, height: packet.height, codecDigest: codec.digest };
      // Source/old bytes are unnecessary after native validation; do not carry them into final planning.
      return { context: captured.context, stage: captured.stage, snapshot: captured.snapshot, lease: {
        stageId: captured.lease.stageId, leaseToken: captured.lease.leaseToken, version: captured.lease.version,
        leaseUntil: captured.lease.leaseUntil, correlationId: captured.lease.correlationId }, result };
    },
    async persistResources(writer, envelope, resources, context) {
      const identity = mediaContext(context), expected = mediaContext(resources.context);
      if (canonicalOperationJson(identity) !== canonicalOperationJson(expected) || envelope.resourceId !== resources.stage.productId ||
          envelope.expectedRevision !== resources.stage.expectedRevision || envelope.correlationId !== resources.lease.correlationId) denied();
      await inspectTarget(read, resources.stage.productId, resources.stage.targetSlot, resources.stage.expectedRevision);
      await writer.bind(resources.stage.stageId, resources.lease.leaseToken, resources.lease.version, resources.result, envelope.operationId);
      const bound = await writer.boundBytes(resources.stage.stageId, envelope.operationId);
      assertUploadThumbnail(envelope.proposal.thumbnail, bound.thumbnail);
    },
    async consumeResources(writer, envelope, context) {
      mediaContext(context);
      await writer.consume(envelope.proposal.stageId, envelope.operationId);
    },
  });
  const coordinator = Object.freeze({ begin, append, discard, uploadAdapter: makeUploadAdapter({ hooks }) });
  coordinators.add(coordinator);
  return coordinator;
}
