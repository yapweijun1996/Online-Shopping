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

The next storage/maintenance checkpoint must implement atomic source append,
lease/CAS, pin/install, consume, complete byte scrub and exact quota release.
Every cleanup transaction must count metadata/quota/audit writes within100rows
and1MiB. A maximum1,130,496byte stage cannot be erased in one such transaction.
Expiry must run its bounded approved-operation batch before proof cleanup, leave
remaining APPROVED backlog intact, drain children before parent deletes and retain
minimal policy to the original receipt horizon. New media tools stay ineligible
until authority, byte delivery/ACK, real image review, service effects, rollback,
restore and both-database acceptance are implemented separately.
