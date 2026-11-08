# Unified create, exact images and publication parent

Implemented 2026-11-08. Local acceptance is separate from a production release
or completion of any live seller proposal. The optional finish extension uses
base shop schema35; it does not modify the original schema34 MCP manifests.

## Contract and authority

With finish enabled and the trusted catalog-create/native runtime available,
`catalog.prepare_create` accepts three closed actions:

- `begin`: `{product:<original create input>,images:[{sourceSha256,sourceMime,declaredBytes}],idempotencyKey}`.
- `append`: `{draftId,index,offset,dataParts}` using the existing bounded canonical base64 chunk grammar.
- `discard`: `{draftId}` before the draft binds to a proposal.

These values are inside the ordinary MCP `{input:...}` wrapper. The first image
is the new product's own main. Remaining images append in order to the listing
gallery. For a shared listing, the existing holder must already own a main and
its inherited gallery positions are preserved. Canonically duplicate new image
positions, inherited gallery duplicates and an oversized complete gallery fail
closed; they are never silently collapsed or reordered.

The coordinator requires the original live `catalog.write` and `media.write`
grant, consent, account/auth version, tenant/lifecycle fence, epoch and build.
A draft contains server-generated provisional product/listing IDs and immutable
normalized intent; it creates no commerce rows. Its stages use the existing
quotas, sequential chunks, upload/absolute expiry, validation leases, native
codec, operation pins and single consumption. There is no public missing-product
switch, authority selector or unrestricted media-stage exemption.

After all chunks, call `catalog.preview_create` with the original product fields
plus `draftId` and the ordinary idempotency key. Native decoding occurs outside
writer/tenant locks. New and old images together use one existing native session
with at most33 calls and its original absolute deadline; all graph/page/byte
bounds still apply. A source requiring more work returns an explicit safe error.

## One immutable approval

The parent keeps tool `catalog.preview_create`, resource `catalog`, HIGH risk,
and `catalog-media-v1` dual-scope authority. Its additional closed
`creationMedia` binding identifies the owned draft, ordered stage/source/native
hashes, native dimensions and canonical thumbnail facts. Canonical PAGE records
use version2; legacy image-free CREATE remains version1 with zero stages.
Existing-product uploads and UPDATE retain their own strict policies.

The final proposal includes full metadata, price, currency, stock, options,
final active state, all affected existing siblings, inherited exact images, new
exact images, main/holder/variant roles and ordered galleries. A logged-in owner
must acknowledge every actual PAGE and unique full ASSET through expiring nonce
proof and explicitly approve the exact parent. Origin/CSRF, session/challenge,
preview hash, original live grant/consent, tenant, revision, CAS and audit checks
remain mandatory. Operation approval does not ask for another password. No child
approval, challenge or image proof is synthesized or copied.

## Atomic commit and recovery

The original operation engine commits one local transaction:

1. Revalidate the full immutable parent, original server IDs, authority and staged native facts.
2. Use the existing planned product, initial inventory and history services to create inactive.
3. Verify that initial creation and all unaffected rows match the original service plan.
4. Apply exact own-main/gallery bytes through the existing image and history services.
5. Apply final `active:true` only after images, still inside the same transaction.
6. Verify full new metadata/options/stock, unaffected metadata, physical roles/gallery order, canonical image and thumbnail hashes; consume each stage once and retain the parent receipt/audit.

A service/audit/native/verification failure rolls back commerce and consumption.
An authorized identical committed retry returns the original minimal receipt.
No Shopee API or existing external listing is touched.

A batch contains at most five parent operations. Commits are individually atomic,
so an earlier success remains complete when a later item becomes stale. Progress,
partial failures and receipts survive page reload; Resume never grants approval.
The conservative revision policy requires a fresh complete review after **any**
stale catalog dependency, including an unrelated preceding CREATE. It does not
claim automatic semantic-equivalence rebasing.

For an uncommitted bound parent whose original source chunks and draft remain
available, revalidation copies those exact sources into a new quota-owned draft
and validation leases, preserving the original provisional product/listing IDs.
Native decoding and the complete review run again. The replacement has no prior
approval or image acknowledgments. Missing/expired sources or quota limits stop
with safe restaging/retry guidance; a consumed/committed creation is never cloned.
A new sibling or changed shared gallery appears in the replacement review rather
than inheriting old approval.

## Storage, tests and evidence

The explicit optional installer creates draft, draft-stage, draft-event and
schema-marker tables. Startup asserts source DDL and actual structural manifest
plus required app DML; production handlers perform no DDL. Metadata markers are
SELECT-only for the app role. Tenant cleanup explicitly budgets at most100 total
child/parent deletions, preserving linked operation evidence until terminal state,
receipt horizon and stage scrubbing. Existing receipt/media maintenance skips
remaining draft references rather than failing a whole cleanup batch.

`test/mcp-catalog-create-parent-browser.test.js` uses the actual default factory,
OAuth/session, HTTPS, native container and Chrome on SQLite and disposable
PostgreSQL. It checks no preapproval commerce, exact two-image approval and final
publication/read-back, batch partial/reload/stale renewal with original IDs and
fresh proof, shared-sibling material changes, duplicate images, consent/authority,
expiry, atomic image-service rollback and concurrent idempotent commits. Isolated
fault injection is a rollback/negative test, not evidence of a live incident's
root cause. Existing image-free CREATE and standalone media regressions remain
required. Screenshots cover320/390/1440 widths and light/dark themes.

Local evidence: `/srv/agent-workstation/artifacts/shop-finish-composite-parent-20261108/`.
A published-artifact canary, full integrated regression/security review and an
operator-confirmed release remain separate gates; no live product completion is
implied by these tests.
