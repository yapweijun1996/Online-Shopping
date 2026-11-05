# Media storage foundation (schema31)

This isolated development schema grants no media authority. The five media tools
remain absent; production activation stays rejected. No route, UI, decoder,
business service, new rate table or registry is installed by this checkpoint.
The existing v1 definitions and stock/order semantics remain unchanged.

Schema31 adds a nullable operation media-policy marker and ten shared SQLite/PG
tables: retained policy, quota, stage, source chunk, single-use pin, manifest page,
asset reference, challenge delivery, media approval evidence and metadata event.
All new internal foreign keys use RESTRICT. There is no foreign key to product,
listing or OAuth grant; reset/credential cleanup cannot cascade experimental bytes.
Cross-row graph/policy/proof validation belongs to trusted later application code,
not a row count CHECK or permission inferred from the existence of a row.
`catalog-media-v1` is reserved DDL, with no expanded catalog effects or authorization.

## Integrity and retention

The operation-storage inventory is version2. Fresh SQL includes the complete
shared DDL and self-contained physical fingerprint metadata. Explicit30→31
migration first verifies the exact legacy version1 DDL and physical manifest,
then adds the nullable marker/media tables and replaces only compatibility
metadata within the same transaction. Existing operations retain null markers.
Unknown, partial and tampered prototypes fail closed. An ordinary request cannot
upgrade version1 storage. Readiness checks schema31 and all media objects even
when v2 features are off. PostgreSQL upgrades remain operator opt-in and preserve
the tenant-role grant boundary. No new CHECK uses nested BETWEEN expressions.

Source limit512KiB, canonical512KiB and thumbnail80KiB are separate. Initial codec
policy keeps source/canonical MIME equal but stores both fields. Chunk maximum36KiB,
15chunks/stage; active quotas12/account-client and24/tenant, reserved bytes16/32MiB.
Each stage reserves declared source +606208bytes before append, retaining quota
and its slot until every canonical/thumbnail/source byte is gone. Canonical fields
are present only in BOUND; consume clears them atomically. Terminal source chunks
may await bounded garbage collection. No public READY state exists.

Stages capture immutable begin-request/idempotency hashes, original binding,
server-generated correlation ID and receipt horizon derived at begin from the
trusted grant's absolute expiry plus90days. They retain a nullable logical
operation ID after seal/pin cleanup. No later deleted-grant lookup reconstructs
this horizon. A scrubbed tombstone can answer duplicate identity only; it cannot
supply upload/commit/approval authority or regenerate bytes.

Upload expiry is begin+15minutes and absolute expiry begin+25minutes, never renewed.
Validation lease is45seconds clipped to upload expiry, with at most2explicit
attempts. Coordinator budget30seconds and5seconds/decode are constants only in
this batch: no decode runs here, and future code must keep it outside BOTH locks
and refuse a new decode with less than5seconds budget. An operation is at most
10minutes from seal and never beyond the stage absolute bound.

Complete graph limits remain fail-closed:300products,2listings,32old+10new/42total
assets,512records,16pages×16KiB,32records/page; old16MiB +new8MiB =24MiB. These
constants do not implement a planner or authorize truncated review. Retained
minimal policy survives raw proposal/page/asset cleanup until parent receipt
expiry. Model text, image bytes/hashes, challenges and credentials never belong
in media audit events; events contain fixed outcomes and trusted identity only.

## Restore and activation boundary

SQLite→PostgreSQL import excludes all live stage/quota/pin/page/asset/delivery/
evidence/policy state and reconstructs compatibility metadata. Metadata media
history is imported separately, without stage/grant foreign keys. External epoch
rotation remains mandatory after an authorized restore. Schema and byte retention
are not consent, human approval or an immutable codec build attestation.

The internal storage/maintenance checkpoint below implements atomic source append,
lease/CAS, pin/install, consume, byte scrub and exact quota release.
Every cleanup transaction must count metadata/quota/audit writes within100rows
and1MiB. A maximum1,130,496byte stage cannot be erased in one such transaction.
Expiry must run its bounded approved-operation batch before proof cleanup, leave
remaining APPROVED backlog intact, drain children before parent deletes and retain
minimal policy to the original receipt horizon. New media tools stay ineligible
until authority, byte delivery/ACK, real image review, service effects, rollback,
restore and both-database acceptance are implemented separately.

## Internal writer and hygiene checkpoint

`withMediaWriter(store, trustedContext, callback)` joins the caller's existing
writer transaction and supplies an ephemeral callback-only capability. The
caller must already hold the platform lifecycle fence and verify live authority;
these functions cannot authenticate a token, select a tenant store, establish
product ownership or grant permission. Context contains tenant/revision, original
account/auth-version/client/grant, epoch/build, issuer/resource and the trusted
grant expiry. Production code must use the authoritative clock; injected clocks
in synthetic tests are not model arguments. The clock is captured after acquiring
the store transaction so lock wait cannot create a stale lease start.

The writer offers begin, append, get, claimValidation, bind, boundBytes, consume,
discard and failValidation. Begin hashes exact normalized declarations and binds
the original idempotency key. Append hashes actual immutable byte copies, requires
sequential offsets, acknowledges only exact-byte repeats and rejects conflicts.
Quota rows and stages change atomically. Counter mismatches deny new work; no
positive quota is inferred or reset from a counter. Zero counters may be pruned
only when no reserved stage remains.

Claim verifies all bounded chunks and the complete source hash before freezing a
version/token lease. It returns source bytes to the trusted coordinator, which
must return from the transaction/release both locks BEFORE any codec call.
Reclaim is explicit, only after lease expiry and at most the second attempt;
native validation failure is terminal, never automatically retried. Bind takes
only trusted decoder output, verifies its source hash, same-format MIME, declared
codec digest, size/dimensions and actual canonical/thumbnail hashes. The new
server-created operation must reuse the stage correlation ID and original receipt
horizon. A stage has one global pin, cannot be transferred/rebound, and retains its
operation ID after pin cleanup. Bound bytes are rehashed on internal retrieval.
Consume requires the same pin/policy/current approved operation and atomically
clears canonical/thumbnail fields; source chunks and quota remain until garbage.
No commerce effect, receipt, approval decision or native decode is performed here.

`storeMediaPolicy` writes only direct upload/layout descriptors; catalog policy
remains reserved DDL. Its hash is SHA256 of canonical JSON with exactly
`policyId, manifestRoot, graphRevision, codecDigest, pageCount, assetCount,
effectCount` (shared `MEDIA_POLICY_DESCRIPTOR_FIELDS`). Fixed tool/scopes/capability,
marker and exact parent times are separately validated. Later manifest/authority
code must compare the retained descriptor/hash to the hash-bound proposal and
validate every actual page/asset/effect; storing this header is not that proof.

`maintainMedia` runs only under the trusted cleanup fence, in separate transactions
with explicit100-row/1MiB byte+metadata reservations. A full maximum stage needs
multiple passes. Faults roll back its current byte/quota/audit transaction; earlier
bounded metadata phases can remain committed. Source bytes, canonical/thumbnail
bytes, stage updates, quota updates and events all count. Slots/reservation are
released only after every byte is absent. Tombstones retain immutable begin hash,
idempotency hash, correlation and operation link until the captured receipt horizon.
Minimal policy waits for parent receipt expiry. Terminal proof children drain in
RESTRICT order; approved backlog beyond the expiry batch remains untouched.
Existing operation redaction/expiry/deletions are also bounded by serialized bytes.
The host cleanup CLI works with switches off and its private suspended-tenant
hygiene fence, while ordinary suspended business authority remains denied.

Future authenticated challenge refresh must invoke `clearMediaChallenge` within
its platform-first writer flow before guarded challenge deletion. It atomically
clears at most58 delivery records and refuses consumed/evidenced or oversized
challenges. The existing human route is not changed here; media remains unavailable
until that separate integration is reviewed. Weighted APPEND240calls/12MiB per15min
constants are reserved for the later persistent limiter class. No new limiter
storage or exemption from existing HTTP/account/shop budgets is installed.
