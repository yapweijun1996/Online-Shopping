# Seller Operations production activation

Status: implementation in progress. This document records a new owner-authorized activation after the default-OFF release. It does not claim that the live MCP endpoint is already enabled.

## Authorization and baseline

The owner's latest option B authorizes preparing, verifying and releasing the full existing Seller Operations MCP. It does not authorize an AI to manufacture seller consent or approve real business changes. Existing read-only grants remain read-only. Every new write retains the current scope, RBAC, tenant, immutable proposal and first-party human approval requirements.

Verified baseline: `yapweijun1996/Online-Shopping` at `b134f5c30b316b10c88fc8afedac6479a1cd6d8b`. Work is isolated on `codex/mcp-v2-production-activation`, with separate profile, transport and codec worktrees. Shop schema34/platform2 were already installed by the previous release. No schema migration is currently proposed.

Read-only GCP preflight on2026-11-06 at00:43UTC found the accepted baseline healthy, MCP/AI/QR disabled, updater active/enabled, approximately1295MiB available memory and17GB available disk. These observations must be refreshed before activation. The existing callback allowlist includes ChatGPT and Claude; server readiness does not prove either vendor account has completed OAuth.

## Verified activation blockers

- The Node HTTP adapter constructs HTTP request origins behind the HTTPS reverse proxy. The operation approval routes correctly require the canonical HTTPS seller origin, so this adapter boundary must be repaired and tested through an actual proxy.
- GCP Caddy omits the operation review page/script/style routes. Its global cache and image CSP policy also needs to preserve the protected review response's no-store and Blob-image policy.
- New v2 production profiles are deliberately blocked in the baseline. Replacing scattered checks with one strict, explicit production profile must retain default-OFF behavior and reject incomplete configurations.
- Native image processing currently has a development launcher. Production needs a trusted generation supervisor, immutable artifact pins, fixed isolation and admission before large backend image captures.
- The updater, image publisher, recovery and dormant maintenance procedures must understand the production runtime. Initial activation cannot roll an old production-blocking binary back under enabled flags.

## Implementation sequence and gates

| Step | Work | Acceptance | Current state |
| --- | --- | --- | --- |
| P1 | Shared deployment profile and backend artifact binding | Explicit complete production profile; original8 unchanged; old grants gain no scope; incomplete activation fails closed; SQLite/PostgreSQL tests | Passed local integrated acceptance |
| P2 | Node origin, Caddy review routing and readiness | Real Node/Caddy/TLS positive and hostile-host tests; private no-store/CSP; cheap authenticated codec readiness | Passed local production-mode business acceptance |
| P3 | Codec generation lifecycle and global capture admission | Fresh sealed socket/token; backend read-only mount; isolated worker limits;1active/0queued admission before capture; crash/replacement tests | Passed independent local native and integrated acceptance |
| P4 | Release/controller, cleanup and recovery | Matched backend/codec artifacts; safe updater recovery; external epoch fencing; disabled first-activation fallback; dormant retention; synthetic rollback tests | Local controller/cleanup/recovery checks passed; published AMD64 lifecycle pending |
| P5 | Integrated security and functional acceptance | Real production-mode OAuth/native/HTTPS approval, both databases; original compatibility, contention, replay/revocation, restore and negative tests; exact commands/results | Passed2071/2071 at0c15c8a; published-artifact canary pending |
| P6 | Reviewed release and live verification | Exact-main CI and immutable images, private recovery artifacts, fresh host admission, coordinated activation, non-mutating public/auth/privacy probes, healthy managed services | Planned |
| P7 | Documentation and durable knowledge | Record exact SHAs/artifacts/tests/live outcome and owner-only remaining actions; KB identity check and readback | Planned |

No step is complete merely because code was generated. P0/P1 security failures block activation. Unavailable browser/PostgreSQL/native checks are BLOCKED, never PASSED. Functional tests use synthetic data only; live probes do not create commerce, new seller grants or human approvals.

## Operational invariants

Production activation requires all new v2/media/full CREATE/UPDATE switches, the named reviewed profile, HTTPS/manual setup, quick login disabled, an external restore epoch and immutable backend/codec identities. A coherent all-v2-OFF configuration can preserve the original eight read tools. Development flags retain their existing independent behavior.

The trusted host owns codec generations. Native decoding has no network, database credentials or Docker socket. The backend mounts the generation read-only and cannot unseal it. Replacing a cached token/socket requires coordinated backend reconstruction. Before any image graph/BLOB capture, one process-wide permit bounds concurrent preparation across tenant instances.

Normal forward releases bind previews to the installed source and backend identity without unnecessarily invalidating grant consent. Database restore and rollback that could revive old authority require stopping all instances, rotating the external epoch and separately invalidating restored legacy credentials/sessions. Rollback preserves committed business rows; it never reverses commerce.

The first activation must retain a tested compatible disabled configuration/image fallback because baseline binaries reject enabled production v2. Subsequent recovery must restore a matched backend/codec/configuration tuple. Existing audit retention remains90days.

The codec is a separate image published with a `media-codec-<SHA>` tag in the existing public GHCR backend package. Backend and codec retain different digests, entry points, files and isolation policies. This avoids introducing a registry credential or changing package visibility: [GitHub documents that new packages default to private](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry). The codec's component label, revision, image ID and wire/client/lock hashes must all match its reviewed release manifest.

## Evidence and knowledge limitations

The manager retrieved the available project memory, its own KB identity and the requested Auto Manager/delegation workflows, then checked remembered claims against current source and read-only deployment evidence. Broad engineering context was truncated; a narrower reuse request initially returned HTTP520, and later evidence submission exposed a stricter schema than its public tool description. Live Brain status is healthy. These retrieval limitations do not change seller authorization or justify bypassing source/test/release gates.

Implementation and release evidence will be added as each gate actually passes. Prior acceptance counts in the initial release record are historical, not proof of this activation candidate.

## Verification checkpoints before release

All entries below are isolated synthetic checks, not production deployment claims. They overlap and must not be added into an invented coverage total. Final frozen-source acceptance will supersede these component snapshots.

| Evidence | Actual result | Boundary |
| --- | --- | --- |
| Root shared readiness IPC checks |4/4,0failures/0skips | Authenticated actual Unix socket; no native decode |
| Root profile and compatibility checks |41/41,0failures/0skips | SQLite/PostgreSQL, separate new consent, original8, artifact-bound proposals |
| Root epoch/profile/admission combination |17/17,0failures/0skips,9.626s | Includes production eligibility and cross-tenant capture admission |
| Root real proxy/origin and epoch combination |17/17,0failures/0skips,7.773s | Actual Node/Caddy/verified localTLS transport; not full business acceptance |
| Root real GCP Caddy routing |164 assertions,8groups,0failures | Root/tenant review routes, cache/CSP and host isolation |
| Root maintenance/retention/readiness/admission/configuration checks |49/49,0failures/0skips,24.778s | Both stores; no credential reset or business approval |
| Root original cleanup CLI compatibility |8/8,0failures/0skips,4.561s | Both stores, existing single-shop contract |
| Root release artifact/configuration foundation |17 legacy updater +5 new contracts passed | Offline; lifecycle implementation was still pending |

Root independently repeated the privileged supervisor checks:2/2,0skips,5.203s, including11 inner Python assertions. The real native container checks passed4/4,0skips,10.726s, including genuine cgroup OOM137, watchdog70 and maximum raster processing. An earlier worker OOM wait timed out during concurrent verification; that failure remains recorded and its cause is unproven. Exact published AMD64 artifact verification remains required. Full production-profile business testing initially found a QA Caddy capability mismatch; an owned one-shot check proved the missing bind capability, and the corrected fixture retains the real proxy, production mode and native isolation.

## Frozen-source whole-suite acceptance

Independent root full acceptance at `0c15c8a9b6b6a903f7f7c7afbf4a82c7d4fb4514` completed on2026-11-06 with exit0:2071tests,2071passed,0failed,0cancelled,0skipped,875436.513499ms. Environment: persistent Ubuntu24 ARM64 development host, Node24.22.0, isolated synthetic PostgreSQL16.15 on port59025 plus SQLite, Playwright1.65.0/Chromium158, and the independently tested local ARM64 codec image. No production data was used.

Exact invocation from the integration worktree (the database URL file remains private):

```sh
PATH=/home/ai-agent/.nvm/versions/node/v24.22.0/bin:$PATH \
NODE_ENV=test SHOP_TEST_DATABASE_URL="$(cat .local/manager-test-db-url)" \
QA_PLAYWRIGHT_MODULE=/home/ai-agent/online-shopping-mcp-production/.local/qa-browser/node_modules/playwright/index.mjs \
MEDIA_COORDINATOR_CONTAINER_TEST=1 MEDIA_TOOLS_NATIVE_BROWSER_TEST=1 \
CATALOG_MEDIA_NATIVE_BROWSER_TEST=1 CATALOG_MEDIA_CREATE_NATIVE_BROWSER_TEST=1 \
MCP_CROSS_DOMAIN_NATIVE_BROWSER_TEST=1 MCP_CROSS_DOMAIN_PRODUCTION_PROXY_TEST=1 \
MCP_PRODUCTION_PROXY_TEST=1 MEDIA_CODEC_SUPERVISOR_TEST=1 npm test
```

The first whole run at0a72704 failed48/2071 because a component-test helper omitted the newly required trusted synthetic codec identity. This was reproduced independently, corrected by passing the helper's existing codec digest without weakening runtime checks, and verified across all seven consumers58/58 before the final full run. The failed-first evidence is retained; it is not reported as a passing run.

The production-profile cross-domain browser acceptance separately passed15/15 on both stores, alongside its preserved development variant15/15. It uses actual default application construction, Node/Caddy/verifiedTLS, native decoding, fresh OAuth consent and first-party protected review/approval. It covers the32 advertised names and actual success schemas plus per-name authentication/closed-input/read-only negatives for all24 additions. Its host Node backend identity pin is explicitly synthetic; its test-only Unix upstream accommodates the development host firewall. This does not attest published AMD64 image identity or GCP TCP routing. Real vendor-account OAuth and production commerce approval remain outside agent execution.

Read-only live recheck at02:46UTC confirmed B134, MCP/AI/QR0, no pending release, updater active/enabled and unchanged PostgreSQL container/volume. The baseline immutable images are backend `sha256:a2547b98d2b9000ddc9b43d1d1e8aefdc66b75c3ad8c5dffe66bc2a60e2bc983` and frontend `sha256:8028e5242f6f29fc500e8b35263497eb548483b98d43c40245c3f59441680f0b` in the repository's existing public packages. Capacity and exact image IDs must be refreshed at the later canary/cutover gates.
