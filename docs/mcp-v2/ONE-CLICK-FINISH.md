# One-click Approve & Finish

Updated 2026-11-08. This document describes the prepared-operation coordinator.
The unified new-product/new-image parent contract is documented separately.
Implementation and local validation do not establish that a production release
or a particular seller operation has completed.

## Seller review and approval

An authenticated seller opens the first-party operation review page, reviews
all metadata, price, stock, publication state and exact physical images, then
explicitly clicks **Approve & Finish**. The existing seller login session is
sufficient; operation approval does not request another password. Session and
account validity, Origin/CSRF, expiring session-bound challenge, preview hash,
PAGE/ASSET evidence, original live OAuth grant and consent, capability, tenant,
epoch and build are still mandatory. A job or progress marker grants no authority.

The backend approves each exact pending proposal, executes its existing atomic
operation engine, reads back all affected product/listing projections and freshly
hashed image roles, then records a receipt and progress. This includes metadata
of affected sibling variants, not only the selected product. `active:true`
publishes through the existing catalog service; no Shopee listing is changed.

## Batch, failure and recovery

`/oauth/operation?operationIds=<uuid>,<uuid>` accepts one to five distinct
operations under one original client/grant. Each proposal receives an explicit
review acknowledgment. Execution is a sequence of atomic individual commits;
earlier successes survive a later failure. Responses contain `FINISHED`,
`PARTIAL` or `IN_PROGRESS` and per-item state/error/receipt.

Same-origin seller-cookie APIs (mutations also require CSRF):

- `POST /api/v1/seller/mcp/finishes`: `{items:[{operationId,previewHash}],idempotencyKey}`.
- `GET .../finishes/:jobId`: bounded owner progress and receipts.
- `POST .../:jobId/approve`: `{items:[{operationId,previewHash,challenge,mediaReviewed:true}]}`. This must be the exact ordered set of currently pending operations; approved or committed items are omitted.
- `POST .../:jobId/resume`: `{}`. Missing approval is never granted.
- `POST .../:jobId/revalidate`: `{operationId,idempotencyKey}`. Prepares a replacement catalog proposal requiring renewed review.

Prepare idempotency binds ordered operation IDs/hashes, original client/grant,
account and tenant. Only job IDs enter browser sessionStorage. Challenges stay in
page memory. An optional legacy password field is inert, never used or stored.
No background daemon is installed: the backend request performs execution and a
later explicit Resume reconciles an interrupted request from durable receipts.
Committed operations are read back, never reapplied; stock and commit audit must
not duplicate. If current content differs from the committed expected projection,
verification returns `VERIFY_CHANGED` rather than claiming completion.

A renewed login can inspect its own job with the original grant still valid.
An approval bound to another seller session becomes
`RENEWED_APPROVAL_REQUIRED`; Resume cannot execute it. Revalidation prepares a
new unapproved operation, and the current session must review and explicitly
approve it. Existing committed receipts may be reconciled under current authority.
Expired/revoked sessions, grants or consent never gain authority from saved jobs.

## Stale revisions

A catalog change can invalidate another prepared operation's base revision.
`STALE_REVISION` holds that item. Revalidation reruns the original normalized
intent under its original live grant/native path and stores a new proposal and
source/replacement audit mapping. Every replacement requires complete new review,
image acknowledgments and approval. No old approval or preview hash is changed
or transferred. This implementation makes no content-equivalence auto-rebase
claim. Expired/consumed media requires safe restaging, never resurrection.

## Production storage and gates

`MCP_V2_FINISH_ENABLED` defaults to `0`. Enabling requires safe MCP v2 and, in
production, the existing complete trusted seller-operations profile and native
media configuration. Production startup asserts preinstalled optional storage
and permissions; it does not create, repair, migrate or grant tables.

See [FINISH-PRODUCTION-RELEASE.md](FINISH-PRODUCTION-RELEASE.md) for the explicit
owner-run SQLite/PostgreSQL extension installer, structural manifests, exact app
DML grants, backups and rollback. Base schema remains 35. Source DDL and actual
structural fingerprints are both checked. Bounded tenant cleanup retires finish
metadata after 90 days; linked operation receipt removal still cascades progress.
Batches cap at five, jobs at 1,000/account, mutations at 120/account/15 minutes,
and progress reads at 600/account/15 minutes.

## Validation and release evidence

The original isolated implementation's historical suite counts remain in
`/srv/agent-workstation/artifacts/shop-finish-20261108/`; they predate the current
session policy and production hardening. Current scoped hardening evidence is in
`/srv/agent-workstation/artifacts/shop-finish-production-hardening-20261108/`.
Final integrated browser/security acceptance and live release receipts must be
reported separately. The historical SPL2 committed/Petal Nut M5 and SPL3 stale
case has not been changed or independently live-verified by these local tests.
