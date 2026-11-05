# Internal media operation integration

This batch extends the existing operation engine. It does not register media tools,
add an upload endpoint, or enable image approval. The current ordinary human review
and approval handlers reject media operations. The internal SQL evidence fixture is
synthetic test data, not evidence of human review or an application approval flow.

## Fixed authority

`operationAuthorityPolicy` derives direct media HIGH risk, `media.write`, and current
`catalog.write` capability from the source-owned tool/policy pair. Reserved catalog
media requires both `catalog.write` and `media.write`, with independent epoch-bound
v2 consent for each. That reserved flow remains unregistered and cannot be installed
through a direct-media adapter. Existing null-marker ordinary operations retain their
policy and adapter interface.

`verifyMediaAuthority` supplies the exact storage context under the caller's existing
platform-to-tenant writer fence. It cannot select a shop or make a grant. Every prepare,
commit and committed replay still requires the live token, original grant, current
account/RBAC, production shop setup, tenant revision, build and epoch.

## Server adapter contract

An internal product adapter may have exactly these `media` properties:

```js
{ policyId, codecDigest, capture, resolve, persistResources, consumeResources }
```

The policy and codec digest come from trusted constructor configuration. MCP arguments
cannot supply authority, review, scope or policy flags. These functions are trusted
application code, not a sandbox or a plugin interface for untrusted code.

1. `capture(read, args, context, writer)` runs inside the first authorized writer fence.
   It returns `{resourceId, expectedRevision, resources}`. It may claim an existing
   upload lease. The SELECT facade and writer expire when their callbacks return.
2. `resolve(resources, {signal, deadline})` runs outside both fences. The deadline uses
   monotonic time and the engine aborts after 30 seconds. The trusted coordinator must
   honor cancellation and own the actual codec job termination; a Promise cannot kill
   native CPU work. The engine rejects late results and never persists them.
3. `preview(read, args, resolvedResources, context)` runs inside a fresh authorized
   writer fence and invokes the real business planner. It returns ordinary
   `{resourceId, expectedRevision, proposal}` plus `mediaManifest`. The engine compares
   the captured and current revision and injects `proposal.media` itself.
4. `persistResources(writer, immutableEnvelope, resources, context)` binds staged
   bytes. The engine atomically persists operation, fixed policy, pins and canonical
   frame. Upload correlation and receipt horizon come from the actual stage. Proposal
   creation time is taken after resolution; the original 10 minute expiry never extends.
5. The existing `apply` receives only the immutable stored proposal. Media-only apply
   context additionally contains `mediaContext`. Then
   `consumeResources(writer, immutableEnvelope, context)` must consume every stage in
   the same business/audit transaction. A missing consumption rolls the mutation back.

Private packets contain only bounded copied buffers and frozen plain metadata; no live
readers, writers, functions or Maps escape the first transaction. They never enter the
proposal, audit, receipt or MCP output. Source-owned adapters remain responsible for
their own temporary references and bounded decoding.

## Integrity, review and replay

The engine validates the retained fixed descriptor, canonical frame, target product,
stage ownership, correlation, receipt expiry, codec digest, actual canonical hashes,
MIME/length and intended main/gallery effect. It repeats live authority and resource
revision checks before returning a prepared operation.

`readMediaApprovalEvidence` is the shared same-transaction evidence validator. It
requires a matching consumed human challenge, current account/session/version binding,
descriptor/root/epoch/build/tenant revision, every expected PAGE and ASSET delivery with
its exact hash and acknowledged nonce record, and the matching APPROVE audit event.
Current approval/session, expiry and original grant checks remain mandatory. Missing,
partial, mismatched or expired evidence grants no right to apply.

All media effects, receipt validation, stage consumption, final authority/evidence
checks and COMMIT audit happen in one tenant transaction. Failure rolls back commerce
data, domain history, approval consumption and stage state; the existing separate
best-effort FAILED marker remains unchanged.

After the original proposal deadline, bounded maintenance removes raw proposal,
frames, pins and review evidence. A committed replay validates its retained descriptor
and strict minimal receipt under current authority, without claiming a stage, decoding,
loading frame pages or invoking apply. The retained receipt/policy expires at the
original grant absolute expiry plus 90 days. Purging it cannot revive an expired grant.

## Verification boundary

`test/mcp-media-engine.test.js` uses generated one-pixel PNG bytes, synthetic trusted
decoder hooks and explicitly synthetic SQL review evidence. It exercises actual
product services/history on disposable SQLite and PostgreSQL, transaction rollback,
replay/retention, authority races, immutable metadata, deadline abort and ordinary
human-handler denial. Native codec and actual upload coordinator acceptance are
separate suites. Successful internal tests do not enable the missing image review UI.
