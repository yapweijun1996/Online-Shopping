# Out-of-band MCP product image upload

Omitting `targetSlot` appends to the gallery. Pass `MAIN` explicitly to set or
replace the main photo.

The initial local acceptance on 2026-11-17 preceded production deployment.

## Problem and resulting behavior

Inline `media.prepare_upload` requires the client to carry every Base64 byte in
tool arguments. Large model-generated arguments can be truncated. The separate
`media.upload_file` downloader requires a supported source host and cannot
authenticate arbitrary Azure attachments. Neither is a PostgreSQL limitation.

`media.request_upload_url` returns a Shop-issued capability. A client uploads
the actual file outside MCP arguments, or the seller opens a file picker at the
same URL. PUT automatically prepares the same durable review as Base64 `seal`.
The product's current image remains unchanged. The PUT route does not fetch an
external URL or attest provider ownership. If the client cannot reach the
seller host for PUT and the image already has a public HTTPS URL, use
[`media.prepare_upload` with action `fetch`](mcp-v2/MEDIA-TOOLS.md#fetch-a-public-image-when-put-is-blocked).

## Tool and HTTP contract

Call `media.list` for the current product revision, then:

```json
{
  "name": "media.request_upload_url",
  "arguments": {
    "productId": "<existing-product-uuid>",
    "expectedRevision": "<current-64-character-revision>",
    "sourceMime": "image/jpeg",
    "declaredBytes": 123904,
    "idempotencyKey": "image-upload-unique-intent-0001"
  }
}
```

`sourceSha256` is optional; when supplied, it must be the lowercase SHA-256 of
the original file. The server always calculates the actual digest. `GALLERY`
retains its existing main-image and shared-gallery-holder requirements.

| Response field | Meaning |
| --- | --- |
| `stageId` | Reserved stage identity; the durable database stage is created after content passes transport checks. |
| `uploadUrl` | Secret HTTPS URL at the configured seller origin and tenant prefix. |
| `method` | `PUT`. |
| `expiresAt` | Five minutes from issuance, or earlier grant expiry. Current authorization must also remain valid. |

With a local original file and the returned URL:

```sh
curl --fail-with-body --silent --show-error \
  --upload-file /absolute/path/product.jpg "$UPLOAD_URL"
```

Send raw bytes, not multipart form data, a data URL or Base64. Content-Type can
be omitted, `application/octet-stream`, or the declared image MIME. The server
checks actual signature and native decoding regardless of headers. Do not add
verbose request logging or place capabilities in committed scripts/logs.

Successful PUT returns HTTP 201 with `stageId`, `sourceSha256`, `byteLength` and
`operation`. The operation includes the real `operationId`, `status`,
`previewHash`, expiry and first-party `reviewUrl`. Use `operations.get` with the
same original grant and `operations.read` consent to check its state. Seller
approval and a separate `media.commit_upload` remain necessary.

GET on the URL serves a minimal picker. It checks the chosen file size before
sending it directly, and displays the review link after successful transfer.
GET does not consume the capability. The page does not approve or commit.

## Trust boundary and failure behavior

| Control | Implementation |
| --- | --- |
| Authenticated issuance | Existing media preflight checks role, explicit scope consent, tenant lifecycle, product, slot and full media revision. |
| Scoped capability | HMAC-SHA256 over stage ID, expiry, random nonce and issuer; exact intent and original authorization context remain in bounded server memory. |
| Single use | The first admitted PUT atomically claims the record before reading. Invalid size/hash/MIME consumes it too. Reuse/forgery/expiry returns 410. |
| Body validation | Exact declared count, 524,288-byte maximum, streamed bound, ten-second read deadline, source signature, optional digest and existing full native decode. |
| Live authority | Original bearer, context and revision are rechecked before and after body transfer; stage/prepare retain all existing checks. |
| SSRF | No outbound fetch and no model-supplied source URL. |
| Browser boundary | Seller origin only, same-origin browser PUT, no cookie authority, no CORS upload delegation, no-store/no-referrer/CSP/frame denial. |
| Logging | Application responses/errors exclude capability contents. GCP runtime log filters redact upload path tokens and referring upload paths using [Caddy's filter encoder](https://caddyserver.com/docs/caddyfile/directives/log#filter). Additional gateways must preserve this policy. |
| Storage | Existing source chunks and canonical review bytes use PostgreSQL BYTEA / SQLite BLOB. No schema migration. |
| Approval | Authenticated seller session, exact Origin/CSRF, a bound challenge, automatic image/page ACKs, exact manifest and separate commit. |

Use a new idempotency key for a new upload intent after a consumed or failed
URL. Repeating issuance while an unused link is live returns the same link;
changing its intent with the same key conflicts. After an uncertain PUT result,
check the operation before preparing another proposal. Never infer approval.

Tickets are process-local. Restart or routing to another backend instance
invalidates outstanding URLs without restoring their authority. This version
targets the existing single-backend deployment; a future replicated deployment
needs shared durable capability state or request affinity. Successful proposals
are durable across restart. A failed partial stage retains existing bounded
expiry/cleanup and audit behavior.

## Files

| Area | Files |
| --- | --- |
| Capability and transfer | `src/mcp/media-upload-url.js`, shared `media-file-upload.js` and signature detector in `media-file-download.js` |
| Stage identity and authorization | `src/mcp/media-coordinator.js`, `media-storage.js` (server-only requested stage ID) |
| Tool and route | `src/mcp/media-contracts.js`, `operation-tools.js`, `operation-policy.js`, `routes.js` |
| Picker | `src/mcp/upload-picker.html`, `.js`, `.css` |
| Routing and capability redaction | `deploy/gcp/Caddyfile`, `src/platform/tenant-code.js` |
| Contracts and regression discovery | `scripts/export-media-contracts.js`, generated media contract JSON, tool inventory tests/canary list |
| Verification | `test/mcp-media-upload-url.test.js`, `test/mcp-media-upload-url-e2e.test.js`, its real TLS fixture and production proxy coverage |

## Local verification

No GitHub Actions run is used as evidence. The explicit E2E suite uses
real OAuth, TLS, curl, SQLite/PostgreSQL and the sealed native codec container;
its five-minute expiry check uses the real clock. Fixtures contain fictional
products only. A synthetic JPEG has a valid comment segment to reach exactly
121 KiB; original uploaded bytes are read back from database chunks.

| Check | Result | Evidence |
| --- | --- | --- |
| Root suite with disposable PostgreSQL 16 and SQLite | **PASS** | 2,288 tests: 2,146 passed, 0 failed, 142 opt-in skips; 576,731.5 ms. |
| New upload URL unit/integration cases | **PASS** | All 12 both-store cases passed in the final root run: real database staging, no commit, incorrect count/hash/MIME, streamed overrun, forged/reused capability, concurrent claims, closed arguments, stale revision, revocation, lifecycle change during transfer and different-connector rejection. The fixture codec is synthetic. |
| Explicit real upload acceptance | **PASS** | 3 tests, 0 skipped; 303,901.2 ms. Real OAuth, TLS-verified curl `-T`, native codec, JPEG/PNG/WebP, both stores, `operations.get`, unchanged image and unapproved commit rejection. |
| Real five-minute expiry | **PASS** | A real unused PostgreSQL-side ticket was held until its actual expiry; PUT returned 410. No clock override or shortened TTL. |
| Real mobile file picker | **PASS** | 1 test; 15,011.2 ms. Wrong-size file refused locally; actual file uploaded; pending operation/review link verified; no seller cookies; 375px layout fits. |
| Linux discovery, existing native upload/approval/commit, GCP TLS proxy | **PASS** | 18 tests, 0 skipped; 37,006.6 ms. Includes unchanged original Base64 workflows, real browser approval, both databases, default/tenant upload routes, shopper-host denial and actual proxy-error capability redaction. Existing file-download cases explicitly use synthetic external download transport. |
| `npm run check`, changed-module syntax, `git diff --check` | **PASS** | No syntax or whitespace failures. The project has no separate TypeScript build/lint command. |
| Python GCP deployment checks | **PASS** | `python3 test/gcp-deploy.test.py`: 26 passed. |
| Python MCP canary checks | **PASS on Linux; FAIL on macOS** | `python3 test/gcp-mcp-canary.test.py`: macOS encountered two missing `/proc/meminfo` errors; the unchanged suite passed all 44 checks in the isolated Linux workstation. |
| Production release / original SPL2 attachment / real vendor sandbox HTTP | **NOT RUN** | No live deployment, production mutation or claim that every ChatGPT/Claude sandbox can send HTTP. The same-origin file picker is the fallback when it cannot. |

Actual 121 KiB JPEG acceptance records (disposable databases, removed after verification):

| Store | Stage ID | Operation ID | Status |
| --- | --- | --- | --- |
| SQLite | `9a42c5bf-fc2e-588a-8a09-092daa95187b` | `83bcade0-f94e-4da9-a91b-eb689c7d17b0` | `PENDING_APPROVAL` |
| PostgreSQL | `04e2655f-e37e-543b-802c-44037c0b7bb0` | `beab65b5-704e-4014-a1ff-7c161aab34c4` | `PENDING_APPROVAL` |

Source SHA-256:
`62e6fc1f8ff56bb5e2b915bbac00c744ee9d50e37055605837ec1b35d5c0b6a9`.
All 123,904 source bytes matched the database chunks. The existing codec produced
12,558 canonical JPEG bytes; source SHA and reviewed canonical SHA have distinct
purposes. Native codec image:
`sha256:47c04c7c9389cd441cae78f25fc1d2d4b814ca26ce256b328808f758b4bf447f`.
These are test records, not links to a live seller proposal.

```sh
npm run check
NODE_ENV=test SHOP_TEST_DATABASE_URL=<disposable-test-database> npm test
NODE_ENV=test SHOP_TEST_DATABASE_URL=<disposable-test-database> \
  node --test --test-concurrency=1 test/mcp-media-upload-url.test.js
NODE_ENV=test SHOP_TEST_DATABASE_URL=<disposable-test-database> \
  MCP_UPLOAD_URL_E2E=1 node --test --test-concurrency=1 \
  test/mcp-media-upload-url-e2e.test.js
```

E2E requires the repository's Linux uid/gid and isolated codec conventions,
an actual `.local/media-codec-image-id`, curl and OpenSSL. It is opt-in because
it uses the native worker and waits five minutes. Ordinary unit/integration
fixtures remain explicitly synthetic; they do not replace this acceptance run.

Exact final root command on macOS (Node 24.22.2):

```sh
NODE_ENV=test TMPDIR=/private/tmp \
SHOP_TEST_DATABASE_URL=postgresql://admin@127.0.0.1:55439/shop_url_upload_test \
SHOP_TEST_PG_BIN=/opt/homebrew/opt/postgresql@16/bin npm test
```

The isolated Linux workstation used Node 24.22.0, the owned codec container,
and `SHOP_TEST_DATABASE_URL=postgresql://ai-agent@127.0.0.1:55489/shop_url_upload_test`.
Its additional browser/proxy regression command was:

```sh
NODE_ENV=test \
SHOP_TEST_DATABASE_URL=postgresql://ai-agent@127.0.0.1:55489/shop_url_upload_test \
QA_PLAYWRIGHT_MODULE=/home/ai-agent/online-shopping-mcp-production/.local/qa-browser/node_modules/playwright/index.mjs \
MEDIA_TOOLS_NATIVE_BROWSER_TEST=1 MCP_PRODUCTION_PROXY_TEST=1 \
node --test --test-concurrency=1 test/mcp-media-tools-browser.test.js \
  test/mcp-all-default-registration.test.js test/mcp-production-proxy.test.js
```

The picker used the same Playwright module with
`MCP_UPLOAD_PICKER_BROWSER_TEST=1` and
`node --test test/mcp-media-upload-picker-browser.test.js`. It passed in a combined
run whose initial proxy fixture failed; the corrected proxy passed in the
separate 18-test run above. Initial harness issues were a local TLS adapter
using HTTP scheme, a PostgreSQL process tied to a finished command's lifecycle,
and Docker's incompatible compressed single-file log setting. Those fixture
configurations were corrected before the successful results; no application
security check was disabled. Linux-only tool inventory assertions were updated
to include the new tool (34 with full consent, 29 in the media browser profile).

Logs are retained at `/private/tmp/shop-url-upload-dtq_cymf/` on the coding host,
and `/srv/agent-workstation/workspaces/shopping-upload-url-20261117/` on the
isolated Linux workstation. Temporary PostgreSQL instances and owned native/
proxy containers are stopped and removed after verification. Existing unrelated
`FEATURES_MAP.md` work remains untouched.

## Release and rollback

This work is local and not deployed. No GitHub Actions, commit, push or production
data change is part of these checks. The active MCP address remains
`https://seller.pomelostem.com/mcp`; it does not gain the new tool until release.

Release must include backend code and `deploy/gcp/Caddyfile` routing/redaction
together, validate the Caddy configuration, refresh MCP discovery and verify a
disposable image reaches a real proposal. Check any outer TLS gateway's logging
policy too. Reserve `media` as a connector path for MCP-enabled shops; an old
shop using that code must be resolved before enabling the default upload route.

Rollback restores the prior backend/proxy configuration and invalidates pending
process-local URLs. Database schema and committed product images require no
rollback migration. Existing durable review proposals retain their normal
authorization/build/revision checks and may require re-preparation after a
build change. Do not approve or commit images as a deployment test.
