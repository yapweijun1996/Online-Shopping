# Catalog media UPDATE runtime gate

The independent catalog media UPDATE profile selects one fixed HIGH UPDATE pair with both catalog and media consent. CREATE remains RESERVED regardless of shared catalog-media grammar. All write flags remain off by default and production activation is blocked. Source review and the complete security/failure acceptance matrix are still in progress; component and native/browser checkpoints do not establish production readiness.

`MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED` accepts exactly `0` or `1`, defaults to `0`, and maps to `config.mcpCatalogMediaUpdate`. Enabling requires explicit development/test mode, manual shop, password login, enabled MCP v2 and the already validated sealed local media worker configuration. Constructor safety additionally requires the tenant lifecycle guard. Neither the flag nor the internal eligibility boolean is accepted in model arguments or tool schemas.

One source-owned eligibility rule permits only `catalog.preview_update`/`catalog.commit_update`, `catalog-media-v1`, and resource type `product`. Each runtime path still independently verifies its actual resource UUID, current account/grant/tenant binding, both fixed domain scopes and both epoch-bound consents. Constructor, policy storage, approval and operation-control plumbing defaults to denial. The static media policy keeps its RESERVED classification: no blanket RESERVED-to-DIRECT conversion exists. New-product CREATE and other resource/policy/tool substitutions remain denied.

The retained policy writer requires HIGH/product UUID/catalog.write/catalog.write and records exact `catalog.write media.write`. It remains an internal metadata function, not a caller or human authorization guard. Existing DIRECT policy and media scopes are unchanged. Operation controls require their own resource-control scope plus both original domain scopes and original grant identity/consent cutoff. A feature-off pending C operation cannot become a legacy safe UPDATE. A flag-on legacy safe pending UPDATE also cannot acquire the new media meaning; it needs a fresh preview under the matching constructor.

The default constructor selects the full UPDATE adapter when the flag is enabled and the existing safe adapter otherwise. It shares the existing media runtime with DIRECT tools. An invalid enabled configuration or missing worker fails closed; it cannot select a MEDIUM/catalog-only fallback. Explicit empty registrations stay empty. Safe CREATE and legacy eight read definitions retain their existing contracts.

Capture/final preview/review/delivery/ACK/approval/current-revision checks reuse the shared C2c normalized state/proposal reader and sole review assembler. The human path compares the entire immutable public proposal, exact final composite, descriptor and every canonical page, while keeping the raw B1 union snapshot separate for the existing exact byte loader. It does not replace raw media revision with composite revision or increase canonical limits. Native validation uses the existing session outside both database locks. COMMITTED receipt replay keeps current authority and retained metadata checks while avoiding deleted sources and expired frames.

Verification separates synthetic-decoder failure/race fixtures from actual native worker, fresh OAuth and real HTTPS Chromium default-constructor tests. The latter use real image SHA/decode/nonce acknowledgements, unchecked review confirmation and fresh password, without injected registrations, grants, tenant fences or human evidence. The remaining full matrix and independent root regression remain explicit acceptance gates.

## Authoritative schemas and profile

[03-CATALOG-MEDIA-UPDATE-IMPLEMENTED.json](03-CATALOG-MEDIA-UPDATE-IMPLEMENTED.json) contains the actual registry argument and `structuredContent` schemas and source-owned policies. Regenerate or verify it with Node24:

```sh
node docs/mcp-v2/export-catalog-media-update-contracts.mjs
node docs/mcp-v2/export-catalog-media-update-contracts.mjs --check
```

The exporter constructs `catalogMediaUpdateTool(runtime)` and `createOperationTools` without entering a tenant, running native work, issuing credentials or executing an operation. The input/output schema shapes are the same as the existing safe UPDATE pair; the profile changes the fixed policy and complete reviewed behavior, not the argument grammar. The original safe and v1 contract artifacts are unchanged.

| Tool | MCP arguments | Structured output | Fixed policy when enabled |
| --- | --- | --- | --- |
| `catalog.preview_update` | `{input:{id,changes},idempotencyKey}` | Operation ID, status, preview hash, expiry, replay flag and first-party review URL | `catalog.write` **and** `media.write`, current `catalog.write` capability, HIGH |
| `catalog.commit_update` | `{operationId}` | COMMITTED with minimal receipt/replay flag, or explicit EXPIRED/STALE_REVISION outcome | Same fixed dual scope, capability and HIGH policy |

`id` is an existing product UUID. `changes` is the closed shared catalog PATCH schema: SKU, shared name/description/category, price/currency/active, group/label and option UUID pairs. Existing service normalization, validation, case-sensitive/dialect uniqueness and shared option AFTER rules remain authoritative. Omitted fields stay omitted; the model cannot supply stock changes, image data, URLs, gallery commands, a listing UUID, planned identity, scopes, config, risk, approval, password, challenge or media acknowledgement. New private listing UUIDs are server-generated, immutable in the prepared intent and checked absent again by the shared apply service. Existing-target group moves/leave/SKU holder changes are supported; full CREATE, newborn/stage combinations and catalog+stock PATCH mixtures are not activated.

Every scope must be present in the access token, current original grant and separately bound current-epoch consent. A scope string alone is insufficient. Current RBAC must still permit `catalog.write` (the current eligible Owner/Manager roles); account, auth version, client, grant, issuer/resource, tenant revision, epoch and build digest remain bound. `tools/list` hides both UPDATE names when either domain scope is missing. The protocol's private required-scope query is not a model-controlled schema field. Safe CREATE retains its existing policy; no CREATE marker is permitted through the UPDATE eligibility exception.

## Review, limits and application

Preparation captures the complete bounded source/target catalog and physical media facts, performs native validation outside both locks, then recomputes them under the final platform-before-shop fence. Current and proposed metadata, complete literal SKU/name labels, real BEFORE/AFTER shopper visibility, holder/order and old source aliases are bound by the final composite and canonical manifest pages. The public proposal includes normalized literal intent, planned identity, complete changed metadata, fixed warning codes, all product labels, review binding and descriptor. Warnings identify target shared-field adoption, option clearing on group change and holder/visible-gallery effects. They are information, not permission.

The whole public proposal is at most48KiB; catalog source metadata has one cumulative8MiB budget, separately from B1's metadata8MiB and physical16MiB budgets. Both physical BEFORE and AFTER must fit16MiB; manifest oldBytes conservatively uses their maximum with newBytes0. Existing300-product/two-listing/32-old-asset/512-record/sixteen16KiB-page limits,64KiB RPC body,4096-character input string and256KiB RPC response caps are unchanged. Oversize state fails503 without clipping products, labels, positions or proof images. This profile creates no upload stages, pins or staging quota authority.

The seller opens the returned first-party URL. Every review/delivery/ACK/password phase rechecks the original live authority and the same complete composite, using raw B1 source identity only for the exact byte loader. The browser verifies canonical page/root hashes and every unique full image SHA, performs image decoding, and sends one-use nonce ACKs. The image confirmation starts unchecked; approval requires it plus the fresh password and the session/challenge/preview hash binding. Exact same-origin and CSRF checks apply even to an AI browser origin approved for OAuth. There is no `approved:true` MCP argument. These controls do not attest human eyesight or remote hardware identity.

Commit repeats current authority, current revision, complete proof and approval checks, then applies only stored normalized PATCH through the existing product/listing/gallery/options/history services in the same writer transaction as proof consumption and typed audit. Sharing copies/layout changes invalidate the holder's old Portal gallery revision. Business/history/stock/audit failures roll back together; no C path writes an unchanged client stock value. Operation CALL audits use actual preview/commit/replay names, original identity, operation/resource IDs and server correlation ID, with no proposal text, image bytes, password or nonce.

## Outcomes, idempotency and receipt

| Trigger | Exact transport behavior |
| --- | --- |
| Unknown/forged tool arguments, forbidden stock/image/identity fields, invalid normalized fields or missing target | HTTP200 JSON-RPC `-32602` Invalid params |
| Different canonical request using the same idempotency key, or stale prepare capture | HTTP200 JSON-RPC `-32009` Operation conflict |
| Missing either domain scope/consent at protocol filtering | HTTP403 `insufficient_scope`, `WWW-Authenticate: Bearer error="insufficient_scope", scope="catalog.write media.write"` |
| Invalid/revoked/expired token or grant | HTTP401 `invalid_token` |
| Failed current authority, disabled C profile, wrong original grant/tenant or invalid first-party proof | HTTP403; no legacy fallback |
| Oversize complete state, unavailable worker or decode deadline | HTTP503 `temporarily_unavailable`; no partial prepared authority |
| Expired approved decision | HTTP200 structured `{operationId,error:"EXPIRED"}`; no commerce |
| Current state changed after approval | HTTP200 structured `{operationId,error:"STALE_REVISION"}`; CONFLICT retires the proof without commerce |
| Unexpected domain/history/audit fault | Generic JSON-RPC `-32603`; domain/proof writer rolls back and the operation records failure metadata where possible |

An identical authorized prepare retry returns the original immutable operation, including its server planned UUID; it does not rebase a stale proposal. A changed request under that key conflicts. Concurrent prepares/commits serialize safely; commit and its identical retry apply once and return the same minimal `{productId,listingId,revision}` receipt. The receipt revision fingerprints the verified actual post-commit current target closure, after complete catalog/physical/view/thumbnail assertions. It is not the old review composite, a permission token or a supplied next-write precondition.

After operation expiry, bounded request-time/CLI hygiene removes proposal, frames and proof bytes while preserving the minimal receipt and retained policy until its grant-derived receipt horizon. Flag-on COMMITTED replay checks current original authority and retained metadata, then returns the receipt without reading the deleted old source or expired frame. Retention never revives an expired grant. Controls additionally require their own `operations.read`/`operations.cancel` scope and every original domain consent with the original creation cutoff; cancel never undoes COMMITTED commerce. Constructing/restarting the application with the UPDATE flag off prevents pending C from becoming a legacy safe operation. Enabling it cannot turn a legacy MEDIUM pending operation into this HIGH media operation; prepare again using the matching profile.

## Synthetic request and response examples

These UUIDs, hashes and dates demonstrate the generated schemas. They are not live identities, credentials or executable human approval. Send the usual Bearer, Accept and `MCP-Protocol-Version: 2025-06-18` headers.

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"catalog.preview_update","arguments":{"input":{"id":"10000000-0000-4000-8000-000000000002","changes":{"variantGroup":"TARGET","variantLabel":"Blue"}},"idempotencyKey":"synthetic-catalog-media-update"}}}
```

The returned `result.structuredContent` has this shape; `result.content` also contains its text representation:

```json
{"operationId":"10000000-0000-4000-8000-000000000001","status":"PENDING_APPROVAL","previewHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expiresAt":"2099-01-01T00:10:00.000Z","replayed":false,"reviewUrl":"https://synthetic.example/oauth/operation?operationId=10000000-0000-4000-8000-000000000001"}
```

After the real first-party approval flow:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"catalog.commit_update","arguments":{"operationId":"10000000-0000-4000-8000-000000000001"}}}
```

```json
{"operationId":"10000000-0000-4000-8000-000000000001","status":"COMMITTED","result":{"productId":"10000000-0000-4000-8000-000000000002","listingId":"10000000-0000-4000-8000-000000000003","revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"replayed":false}
```

## Reproducible acceptance layers

Use Node24, `NODE_ENV=test` and a disposable `SHOP_TEST_DATABASE_URL`. The runtime/platform tests use real Request/OAuth/password/nonce handlers and actual services with an explicitly SYNTHETIC decoder; they test failures/races/rollback, not native or human-browser evidence:

```sh
node --test --test-concurrency=1 test/mcp-catalog-runtime.test.js test/mcp-catalog-runtime-platform.test.js test/mcp-catalog-media-contracts.test.js
```

The default factory native/browser gate additionally requires cached Playwright, the trusted development Docker harness/image ID and the exclusive owned-container lease:

```sh
QA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs CATALOG_MEDIA_NATIVE_BROWSER_TEST=1 node --test --test-concurrency=1 test/mcp-catalog-runtime-browser.test.js
```

Set the same opt-in variable alongside the existing `MEDIA_CODEC_CONTAINER_TEST=1` and `MEDIA_TOOLS_NATIVE_BROWSER_TEST=1` when running the root's single full suite. The full runtime matrix includes default empty-registration compatibility, missing-worker failure, both flag-transition directions, revocation/RBAC/epoch/tenant/session/Origin/CSRF, hash/nonce/page/challenge/approval expiry, idempotency/concurrency, native-time Seller changes, timestamp-free thumbnail staleness, size limits, typed late rollback, controls and scrubbed receipt replay. Independent root full regression and production operational review remain separate gates. Turning the flag off needs no schema rollback; retained rows remain for bounded hygiene and receipt horizons.
