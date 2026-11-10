# Bounded media tools

The isolated2026-11-10 change adds `media.upload_file` to the five existing tools.
It accepts ChatGPT file parameters, restricts the source download, computes the
source size/hash and prepares the existing image approval. See
[file upload](../MCP_MEDIA_FILE_UPLOAD.md) for the actual security boundary and
pending live acceptance. The development-foundation status below is historical;
it is not the status of the later production profile activation.

Status: the built-in development factory is available (`MEDIA_TOOLS_ACCEPTED=true`); the independent media feature flag remains off by default. Production activation is blocked. No reserved catalog-media expansion, new MCP server or generic HTTP/SQL tool is introduced. The final frozen-source validation summary distinguishes actual default-constructor native/browser acceptance from synthetic decoder and storage tests.

The exact schemas, descriptions, examples and limits are generated from the same `MEDIA_TOOL_CONTRACTS` used by registration into [03-MEDIA-IMPLEMENTED.json](03-MEDIA-IMPLEMENTED.json). Regenerate with `node scripts/export-media-contracts.js`. Examples are synthetic argument shapes, not valid resource ownership, complete image bytes or evidence of approval.

## Trusted development configuration

`MCP_V2_MEDIA_ENABLED=1` additionally requires explicit `NODE_ENV=development` or `test`, enabled safe MCP v2, manual shop mode and no quick login. `readConfig` returns `mcpMedia:{enabled:false}` otherwise. Production activation is rejected. The enabled descriptor contains socketPath,tokenFile,codecDigest and never the plaintext token.

- `MCP_V2_MEDIA_SOCKET_PATH`: absolute, canonical existing sealed socket path.
- `MCP_V2_MEDIA_TOKEN_FILE`: absolute, canonical token file in the same private launcher base.
- `MCP_V2_MEDIA_CODEC_IDENTITY`: trusted configured `sha256:<64lowercasehex>` artifact identity.

The fixed Linux development launcher policy requires host uid/gid1000, private base0700, socket directory0710, token0640 owned1000:1000, and socket0660 owned10001:1000. Token is exactly43 canonical base64url characters. The token file is opened without symlink following and checked again by descriptor before reading; no token is serialized into configuration output, MCP data, proposals or logs. Token/socket storage must be outside the database and public directories. Invalid/missing worker configuration rejects activation; unavailable decoding fails closed with no prepared business authority. The local host/launcher/worker and configured identity remain trusted; the CODEC wire string and configured digest are not remote attestation. No Docker socket is supplied to the application.

## Tool contracts

| Name | Scope / capability | Behavior |
| --- | --- | --- |
| media.list | media.read / catalog.write | Bounded current graph revision and paginated member/image identities. No image bytes, URL, stock/price or customer data. Default5/max25 members; source300 products,32old content keys/16MiB physical bytes. Oversized metadata page rejects503; reduce limit, no truncation. |
| media.prepare_upload | media.write / catalog.write | Root object `{input:<one closed command>}`. `begin` binds existing product/slot/revision and immutable intent; `append` carries canonical parts and offset; `seal` creates the durable HIGH image operation; `discard` aborts an unbound stage. |
| media.upload_file | media.write / catalog.write | Top-level owned product/slot/revision/idempotency key and ChatGPT file object. Restricted download and exact source hashing feed existing staged preparation. Returns the existing first-party approval proposal, never approval or commit. |
| media.commit_upload | media.write / catalog.write | Only operationId. Current authority, policy, frame, pin, native-derived thumbnail, full graph, human review evidence and actual bytes are rechecked. |
| media.preview_layout | media.write / catalog.write | Existing product/revision, gallery UUIDs or literal main, explicit removeMain boolean. Outer normal preview idempotencyKey. All before/after product/listing effects are immutable HIGH review metadata. No new image payloads or cross-product selection. |
| media.commit_layout | media.write / catalog.write | Only operationId. Applies the exact approved existing-image selection using shared services/history. |

All legacy8 tool definition objects, input schemas and response contracts remain unchanged. Fresh per-scope evidence/current RBAC/tenant/mode/grant/epoch/build are checked at the actual boundary, never supplied by a model argument. Write preparation is not approval. Human password,challenge,nonce,mediaReviewed and identity fields are not MCP input properties.

Stage output is a fixed `{action,stage,operation}` object: exactly one nullable payload is populated. Seal supplies the first-party review URL and operation ID; nonce/password never enter a URL. Both commit tools return only productId,listingId,revision receipts on success. Caller-selected idempotency keys identify exact immutable intent, never authority.

## Limits and transaction ordering

MCP transport remains64KiB request,4096-character strings and256KiB response. Read/staged DTOs are additionally64KiB. APPEND is1–12 independently canonical base64 strings, each<=4096characters/3072decodedbytes, total<=36864bytes. A fully validated registered command with fresh current consented media.write uses the existing coordinator's persistent240attempt class; protocol does not also charge ordinary120. Other commands retain the ordinary120 path after the existing initial transport/authentication checks; an invalid bearer still fails before that path. Old-epoch or removed consent cannot select APPEND240. Failed valid APPEND attempts consume240 class. IP300/shop600 remain unchanged. `240*36864=8,847,360` bytes is below the nominal12MiB window, without a new rate table or weighted bypass.

Each SQL phase obtains platform lifecycle fence before tenant writer. Native source validation runs outside both locks through a shared fixed5second call/30second session policy. Lease45seconds clipped to upload expiry15minutes, two explicit attempts, original absolute25minute lifetime and bounded storage quotas/cleanup are unchanged. Complete content revision rechecks include old physical thumbnails whose setters do not change timestamps. No full graph or response is truncated.

## Gallery semantics and business writes

Preview/apply use existing shared planning, metadata validation and history. The first selected gallery entry is primary. Shared galleries have10 entries; a distinct variant main can remain separately first, yielding11 visible images. A variant cannot reorder the shared holder selection through MCP; its exact existing selection/main removal is supported. Main removal uses the same guard and explicit effective gallery as the portal. Static references and unsupported legacy resources fail closed.

Gallery-only service extraction removes the fabricated `{name:existing.name}` PATCH solely for media-only edits. Historical parent/holder/variant copy may differ: reorder/removal must not rename unreviewed members. Metadata validation, expected timestamp checks, overflow and legacy portal variant-ignore behavior remain shared; actual shared metadata edits still synchronize copies. New MCP selection validates variant ownership rather than silently accepting ignored foreign IDs. Domain/history/audit/approval consumption and operation state remain atomic. No unchanged stock is supplied or written from client data.

## Acceptance and rollback

Required final acceptance: bothSQLite+PostgreSQL real fresh OAuth/PKCE and seller login, actual registered MCP begin/append/seal or layout preview, actual isolated codec, protected old/new SHA checks plus `image.decode()` and explicit per-image ACK in Chromium, unchecked human acknowledgement/fresh password, then MCP commit/replay and public image behavior. Real old/new layout restoration and initially inactive product publication must be checked. HTTP-only ACK protocol tests and synthetic decoder fixtures do not establish this gate. Native-only tests are not human-review proof.

The following twelve acceptance dimensions map to executable evidence. The actual RPC matrix uses synthetic decoder packets and initially seeded consent, real Request/createApi/live authorization/store/services, and protected HTTP approval; it does not claim native or browser proof. Its named matrix1–12 cases run on both databases.

| Case | Evidence and proof layer |
| --- | --- |
| 1 Missing authentication | matrix1: all five registered RPC names reject401 before resource/business writes. |
| 2 Revocation | matrix2: revoked live grant rejects all five names401. Actual internal engine race tests separately revoke during native-resolution suspension. |
| 3 Missing scope/consent | matrix3: exact legacy8 listing, all five403; append-authority tests separately cover removed evidence, old epoch and raw scope strings with ordinary120 and zero chunks. |
| 4 Current RBAC | matrix4: Staff is ineligible, all five401; no cached Owner authority. |
| 5 Current shop mode/lifecycle | matrix5: persisted demo mode denies all five403. Coordinator/upload-engine tests separately cover tenant suspension/revision and final fenced rechecks. |
| 6 Tenant/resource binding | matrix6: foreign-tenant grant fails401 at all five names. matrix9 uses another real product's existing gallery UUID and rejects before operation creation. Platform fence ordering is tested in the existing operation-tool/engine suites. |
| 7 Immutable begin/idempotency | matrix7: unchanged begin retry returns original stage after portal main-image edit, changed intent conflicts, invalid new target rolls back quota/stage/event. Upload and layout RPC tests cover replay and simultaneous commit exactly once. |
| 8 Quota/transport/lease | matrix8: exact12-client-slot CAS and no partial13th allocation. APPEND RPC tests prove persistent240, canonical chunk size and no ordinary double charge; storage/coordinator tests cover expiry/lease races and strict bytes. |
| 9 Checksum/foreign references | matrix9: wrong whole-source checksum and foreign existing image selection create no operation/pin. Codec wire/native suites cover malformed/signature/bomb/deadline/isolation independently. |
| 10 Shared gallery effects | matrix10: complete10 shared/11 own-main variant metadata, shared reorder denial, approved own-main removal preserves holder10. Shared gallery-copy and hidden-main restoration tests prove portal/MCP parity with real commits. |
| 11 Complete revision/no-op | matrix11: distinct historical physical IDs with duplicate pixels remain represented, canonical assets deduplicate; identical preview replays; unchanged-timestamp thumbnail backfill invalidates approval; a fresh no-op commits/replays. Additional pagination test preserves all26 long-Unicode members over25+1 pages within exact DTO schemas/byte bounds. |
| 12 Transaction rollback | matrix12: injected mid-service insertion failure rolls back selection/history/approval consumption, records failed operation, and a newly approved retry succeeds. Gallery-copy and upload-engine tests separately fail COMMIT audit and verify business/history/stage consumption rollback. |

`mcp-media-tools-browser.test.js` is the separate native/browser acceptance layer. It uses the default createApi constructor without operationTools injection, actual readConfig and sealed worker/token paths, actual tenant registry, fresh DCR/PKCE/password login/consent, and the isolated native codec. Flow A creates an inactive product through MCP, uploads its main image, approves in Chromium and publishes through MCP; flow B uploads a gallery image, reorders and restores it through MCP. Each independent fixture uses three genuine approvals within the existing limiter. The browser verifies SHA/root/pages, image.decode and explicit per-asset ACK, unchecked review acknowledgement and fresh password; no approval/evidence rows are seeded. Full fresh-scope registration is exactly27 names at this source (without later orders/controls); old grants remain exact legacy8. The public image SHA/layout is checked after commit. Synthetic one-pixel image source data is generated locally, then actually decoded by the worker. No human eyesight or remote native attestation is claimed.

`mcp-media-default.test.js` separately proves media flag-off, explicit empty registrations, unsafe production/v2-off and missing-worker fail-closed behavior. Final commands, frozen fingerprints, test counts, skipped opt-ins and limitations belong to the outside validation summary. Targeted proof is not a claim that all logical cases ran through native/browser or that a source-wide suite was run here.

Rollback disables the feature/default registration gate, stops only the owned development codec through its trusted launcher, and runs existing bounded hygiene even for flag-off/suspended shops. It does not reverse committed commerce changes, delete audit/receipts early, downgrade schema or authorize a production restore. Retain the external epoch/restore policy and original receipt horizons.
