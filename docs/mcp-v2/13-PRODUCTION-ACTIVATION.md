# Seller Operations production activation

Status: local whole-suite acceptance and exact-main CI/publication passed. The published-AMD64 synthetic canary has passed source/A/B/C/E-on/D; E-off is running and cleanup remains pending. Final coordinated backup/restore verification, live cutover, public smoke and timer acceptance remain pending. Production remains B134 with MCP OFF and the updater paused. This is a separate owner-authorized activation after the default-OFF release; live MCP is not yet enabled.

## Authorization and baseline

The owner's latest option B authorizes preparing, verifying and releasing the full existing Seller Operations MCP. It does not authorize an AI to manufacture seller consent or approve real business changes. Existing read-only grants remain read-only. Every new write retains the current scope, RBAC, tenant, immutable proposal and first-party human approval requirements.

Verified baseline: `yapweijun1996/Online-Shopping` at `b134f5c30b316b10c88fc8afedac6479a1cd6d8b`. Implementation began on `codex/mcp-v2-production-activation`, with separate profile, transport and codec worktrees; the later exact-main release candidate is recorded below. Shop schema34/platform2 were already installed by the previous release. No schema migration is currently proposed.

Read-only GCP preflight on2026-11-06 at00:43UTC found the accepted baseline healthy, MCP/AI/QR disabled, updater active/enabled, approximately1295MiB available memory and17GB available disk. These observations must be refreshed before activation. The existing callback allowlist includes ChatGPT and Claude; server readiness does not prove either vendor account has completed OAuth.

## Historical B134 activation blockers

These baseline findings were addressed by the current implementation. The evidence below distinguishes verified local corrections from the remaining artifact and live gates.

- The baseline Node HTTP adapter constructed HTTP request origins behind the HTTPS reverse proxy. Its operation approval routes required the canonical HTTPS seller origin, so the adapter boundary needed repair and actual-proxy verification.
- Baseline GCP Caddy omitted the operation review page/script/style routes. Its global cache and image CSP policy needed to preserve the protected review response's no-store and Blob-image policy.
- New v2 production profiles were deliberately blocked in B134. The replacement strict, explicit production profile retains default-OFF behavior and rejects incomplete configurations.
- Native image processing had a development launcher. Production required a trusted generation supervisor, immutable artifact pins, fixed isolation and admission before large backend image captures.
- The baseline updater, image publisher, recovery and dormant maintenance procedures needed production-runtime support. Initial activation still requires a disabled fallback for the old production-blocking binary.

## Implementation sequence and gates

| Step | Work | Acceptance | Current state |
| --- | --- | --- | --- |
| P1 | Shared deployment profile and backend artifact binding | Explicit complete production profile; original8 unchanged; old grants gain no scope; incomplete activation fails closed; SQLite/PostgreSQL tests | Passed local integrated acceptance |
| P2 | Node origin, Caddy review routing and readiness | Real Node/Caddy/TLS positive and hostile-host tests; private no-store/CSP; cheap authenticated codec readiness | Passed local production-mode business acceptance |
| P3 | Codec generation lifecycle and global capture admission | Fresh sealed socket/token; backend read-only mount; isolated worker limits;1active/0queued admission before capture; crash/replacement tests | Passed independent local native and integrated acceptance |
| P4 | Release/controller, cleanup and recovery | Matched backend/codec artifacts; safe updater recovery; external epoch fencing; disabled first-activation fallback; dormant retention; synthetic rollback tests | Local checks and actual AMD64 codec recovery, same-build rollback and synthetic restore passed; old-image fallback/cleanup pending |
| P5 | Integrated security and functional acceptance | Real production-mode OAuth/native/HTTPS approval, both databases; original compatibility, contention, replay/revocation, restore and negative tests; exact commands/results | Passed2071/2071 at0c15c8a; actual canary source/A/B/C/E-on/D passed, E-off/cleanup pending |
| P6 | Reviewed release and live verification | Exact-main CI and immutable images, private recovery artifacts, fresh host admission, coordinated activation, non-mutating public/auth/privacy probes, healthy managed services | Exact EF7 main CI and all four image publications passed; final backup/cutover/public/timer gates pending |
| P7 | Documentation and durable knowledge | Record exact SHAs/artifacts/tests/live outcome and owner-only remaining actions; KB identity check and readback | Current progress recorded; final live evidence and durable-knowledge readback pending |

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

All entries below are isolated synthetic checks, not production deployment claims. They overlap and must not be added into an invented coverage total. The frozen-source whole-suite acceptance below supersedes these component snapshots for local integration.

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

Root independently repeated the privileged supervisor checks:2/2,0skips,5.203s, including11 inner Python assertions. The real native container checks passed4/4,0skips,10.726s, including genuine cgroup OOM137, watchdog70 and maximum raster processing. An earlier worker OOM wait timed out during concurrent verification; that failure remains recorded and its cause is unproven. Exact published AMD64 artifact verification was still pending at that checkpoint; its later progress is recorded below. Full production-profile business testing initially found a QA Caddy capability mismatch; an owned one-shot check proved the missing bind capability, and the corrected fixture retains the real proxy, production mode and native isolation.

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

## Published-artifact rehearsal gate

The separately reviewed `scripts/qa-gcp-mcp-canary.py` and `.mjs` run only inside a new root0700 nonce domain with synthetic PostgreSQL, private secrets, internal networks and no published ports. They import the manually reviewed installed controller/supervisor, retain real immutable artifact and approval checks, and use a closed Docker namespace adapter. Existing-container execution/removal is bound to the inspected exact ID. The helper reloads its checkpoint and dependent I/O state under the same actual kernel lock before phase dispatch; interrupted phases require inspection/cleanup rather than silent replay.

The required sequence is exact-main CI/source verification, accepted B134 OFF bootstrap, complete candidate activation, real synthetic OAuth consent and company approval, actual published native decode, same-build codec replacement, same-build rollback epoch fence, synthetic database restore plus packaged credential hygiene/password reset, and exact old-image OFF fallback/quarantine. The eight original public tool definitions are hashed independently from the actual published B134 OFF container, rather than derived from the candidate. Five total password attempts preserve the real address approval limit; the wrong-password negative runs only once. This rehearsal covers exact32 advertised names and a real company workflow; the local whole suite separately supplies all24 new response-schema/business-flow evidence. It does not authorize or impersonate a real seller.

Root independently ran `python3 test/gcp-mcp-canary.test.py` at integrated94da0da:28/28,0failures/0skips,0.157s, exit0. Explicit Node syntax and Python compilation also passed. These recording-executor/pure-client checks prove namespace, owned-ID, checkpoint/lock, approval-budget and independent-definition-oracle behavior; they do not claim actual AMD64 Docker, restore or live acceptance. Their earlier four peer-review P2 findings and fixes remain separate from the real-artifact gate. The existing verification workflow invokes this stdlib guard alongside its existing GCP checks; no new workflow, permissions or repository setting is added.

## Exact-main publication and actual canary progress

Runtime main `ef7f5f6a9fe950dac596b7f5618c6ad55690b465` passed [Verify42158147002](https://github.com/yapweijun1996/Online-Shopping/actions/runs/42158147002):1988passed,0failed,51opt-in skips. [Publication42159456476](https://github.com/yapweijun1996/Online-Shopping/actions/runs/42159456476) succeeded for backend, frontend, WhatsApp QR and media codec. CI skips remain explicit; this is a separate run from local2071/2071. Immutable RepoDigests and separately observed image config IDs are bound in the private artifact/canary manifests; one identity type is never inferred from another.

The QA helper revision is separately `702746b426cf507506ac1471dea518a8b13ab230`; it does not replace EF7 runtime or change its production policy. Root independently passed44/44 offline guards,0skips,1.283s. The current actual synthetic canary is nonce `b906ad4e1232`, with input manifest SHA256 `864547792eb9435654fecf12a950686edfa14bc1012bbeca573290760abd8bec`:

| Phase | Actual result | Scope |
| --- | --- | --- |
| source | PASSED | Exact source/main CI/artifact/policy checks |
| A | PASSED | Actual B134 OFF bootstrap and independently captured original-eight definitions |
| B | PASSED | Complete EF7 profile,32 tools, fresh synthetic OAuth consent/password approval, company commit/replay and actual native decode |
| C | PASSED | Actual codec kill/recovery, fresh generation, unchanged epoch and surviving grants/replay |
| E-on | PASSED | Actual same-build rollback and epoch fence; job prefix `9f6c0175` |
| D | PASSED | Actual synthetic restore, packaged credential hygiene and trusted owner password reset/forced change; job prefix `ba4d8ff4` |
| E-off | RUNNING | Actual old B134 OFF fallback and durable quarantine; job prefix `9aedae05`, no passing result yet |
| cleanup | PENDING | Proven-owned removal and zero-resource readback for this nonce |

Phase D completed at04:49:47UTC using only synthetic data. Its221362-byte custom dump SHA256 is `133e71a53f360e37c761c0c7d84fb4748de0531b00fa0369c963ed841137817f`; restored fixtures included4grants,6tokens,1code,5sessions and1unbound credential. The actual packaged recovery CLI processed1account and1request; trusted synthetic owner reset/forced change, stale-credential denial and fresh consent passed. This is not a restore of production data or the final operational backup.

Three failed QA attempts remain recorded; no interrupted phase was silently replayed:

| Nonce | Failure and correction | Resource outcome |
| --- | --- | --- |
| `950bc2d32199` | A stopped at Compose2.40.3 normalized read-only release binds; QA parser correction90e5be9 passed actual parser-only before/after verification | No boot resources created |
| `3be66e87a1d8` | Source passed; A reached healthy B134/original-eight oracle but PostgreSQL BIGINT string `"34"` failed the numeric assertion, and `SCHEMA34` was masked as `CLIENT_CLIENT_FAILED`; QA-only integer cast/closed error code corrected atf1366fd | Cleanup passed; all six resource-category counts zero; failed checkpoint retained |
| `462d4cbffabd` | A met temporary PostgreSQL Unix-server health before final TCP readiness; backend initially refused connection. QA-only owned-PG startup/final-TCP wait corrected at702746b | Cleanup passed; owned container/network/volume counts zero; failed checkpoint retained |

These corrections change QA gates only. They do not change runtime images, production policy, schema or live PostgreSQL. Every functional fixture is synthetic. Production backups are permitted only for private operational restore-integrity verification, never real-account HTTP/login/business testing.

Production still runs accepted B134 with MCP OFF and the updater paused. The successful partial canary is not live activation or complete lifecycle acceptance. Remaining gates are E-off/cleanup, final stopped-writer coordinated backup and isolated restore-integrity verification, reviewed cutover/private health, non-mutating public smoke and managed timer acceptance/readback. No new schema migration is proposed; failed cutover restores only the reviewed old images/configuration with MCP OFF quarantine, without automatic live database restore or commerce reversal. Real ChatGPT/Claude account OAuth remains owner-only NOT RUN.
