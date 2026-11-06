# Seller Operations production activation

Status: AFBA runtime acceptance completed at07:49:20UTC. Local whole-suite evidence, separate EF7/AFBA main CI/publications, both full published-artifact canaries/cleanup, coordinated backup/restore verification, private cutover, strict28 public checks and all three managed timers passed. Current AFBA runs the complete profile; schemas and source PG are preserved. Historical failures remain below. Later QA/docs merge and its own CI/publication/normal forward release remain pending; real vendor-account OAuth is owner-only NOT RUN.

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
| P4 | Release/controller, cleanup and recovery | Matched backend/codec artifacts; safe updater recovery; external epoch fencing; disabled first-activation fallback; dormant retention; synthetic rollback tests | Local checks and actual AMD64 codec recovery, same-build rollback, synthetic restore, old-image OFF fallback and cleanup passed |
| P5 | Integrated security and functional acceptance | Real production-mode OAuth/native/HTTPS approval, both databases; original compatibility, contention, replay/revocation, restore and negative tests; exact commands/results | Passed2071/2071 at0c15c8a; actual published-AMD64 canary all seven phases and cleanup passed |
| P6 | Reviewed release and live verification | Exact-main CI and immutable images, private recovery artifacts, fresh host admission, coordinated activation, non-mutating public/auth/privacy probes, healthy managed services | AFBA main CI/publication, backup/private/public and three-timer acceptance complete07:49:20UTC; later QA/docs forward release separate |
| P7 | Documentation and durable knowledge | Record exact SHAs/artifacts/tests/live outcome and owner-only remaining actions; KB identity check and readback | Final runtime evidence recorded; later QA/docs release and final SHA/KB readback remain separate pending work |

No step is complete merely because code was generated. P0/P1 security failures block activation. Unavailable browser/PostgreSQL/native checks are BLOCKED, never PASSED. Functional tests use synthetic data only; live probes do not create commerce, new seller grants or human approvals.

## Operational invariants

Production activation requires all new v2/media/full CREATE/UPDATE switches, the named reviewed profile, HTTPS/manual setup, quick login disabled, an external restore epoch and immutable backend/codec identities. A coherent all-v2-OFF configuration can preserve the original eight read tools. Development flags retain their existing independent behavior.

The trusted host owns codec generations. Native decoding has no network, database credentials or Docker socket. The backend mounts the generation read-only and cannot unseal it. Replacing a cached token/socket requires coordinated backend reconstruction. Before any image graph/BLOB capture, one process-wide permit bounds concurrent preparation across tenant instances.

Normal forward releases bind previews to the installed source and backend identity without unnecessarily invalidating grant consent. Database restore and rollback that could revive old authority require stopping all instances, rotating the external epoch and separately invalidating restored legacy credentials/sessions. Rollback preserves committed business rows; it never reverses commerce.

The first activation must retain a tested compatible disabled configuration/image fallback because baseline binaries reject enabled production v2. Subsequent recovery must restore a matched backend/codec/configuration tuple. Existing audit retention remains90days.

The codec is a separate image published with a `media-codec-<SHA>` tag in the existing public GHCR backend package. Backend and codec retain different digests, entry points, files and isolation policies. This avoids introducing a registry credential or changing package visibility: [GitHub documents that new packages default to private](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry). The codec's component label, revision, image ID and wire/client/lock hashes must all match its reviewed release manifest.

## Evidence and knowledge limitations

The manager retrieved the available project memory, its own KB identity and the requested Auto Manager/delegation workflows, then checked remembered claims against current source and read-only deployment evidence. Broad engineering context was truncated; a narrower reuse request initially returned HTTP520, and later evidence submission exposed a stricter schema than its public tool description. Brain status was healthy at that implementation checkpoint. These retrieval limitations do not change seller authorization or justify bypassing source/test/release gates.

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

## EF7 first-activation CI and published-artifact canary

Runtime main `ef7f5f6a9fe950dac596b7f5618c6ad55690b465` passed [Verify42158147002](https://github.com/yapweijun1996/Online-Shopping/actions/runs/42158147002):1988passed,0failed,51opt-in skips. [Publication42159456476](https://github.com/yapweijun1996/Online-Shopping/actions/runs/42159456476) succeeded for backend, frontend, WhatsApp QR and media codec. CI skips remain explicit; this is a separate run from local2071/2071. Immutable RepoDigests and separately observed image config IDs are bound in the private artifact/canary manifests; one identity type is never inferred from another.

The QA helper revision is separately `702746b426cf507506ac1471dea518a8b13ab230`; it does not replace EF7 runtime or change its production policy. Root independently passed44/44 offline guards,0skips,1.283s. The current actual synthetic canary is nonce `b906ad4e1232`, with input manifest SHA256 `864547792eb9435654fecf12a950686edfa14bc1012bbeca573290760abd8bec` and final actual report SHA256 `01ffcbdaa7085f02fae5622909ef9e994a15c9478f9308a0ffbcc7802ff37b3b`:

| Phase | Actual result | Scope |
| --- | --- | --- |
| source | PASSED | Exact source/main CI/artifact/policy checks |
| A | PASSED | Actual B134 OFF bootstrap and independently captured original-eight definitions |
| B | PASSED | Complete EF7 profile,32 tools, fresh synthetic OAuth consent/password approval, company commit/replay and actual native decode |
| C | PASSED | Actual codec kill/recovery, fresh generation, unchanged epoch and surviving grants/replay |
| E-on | PASSED | Actual same-build rollback and epoch fence; job prefix `9f6c0175` |
| D | PASSED | Actual synthetic restore, packaged credential hygiene and trusted owner password reset/forced change; job prefix `ba4d8ff4` |
| E-off | PASSED | Actual old B134 OFF fallback, retired codec, rotated epoch and restarted-controller durable quarantine; job prefix `9aedae05` |
| cleanup | PASSED | Proven-owned removal for this nonce; final private report retained |

Phase D completed at04:49:47UTC using only synthetic data. Its221362-byte custom dump SHA256 is `133e71a53f360e37c761c0c7d84fb4748de0531b00fa0369c963ed841137817f`; restored fixtures included4grants,6tokens,1code,5sessions and1unbound credential. The actual packaged recovery CLI processed1account and1request; trusted synthetic owner reset/forced change, stale-credential denial and fresh consent passed. This is not a restore of production data or the final operational backup.

Three failed QA attempts remain recorded; no interrupted phase was silently replayed:

| Nonce | Failure and correction | Resource outcome |
| --- | --- | --- |
| `950bc2d32199` | A stopped at Compose2.40.3 normalized read-only release binds; QA parser correction90e5be9 passed actual parser-only before/after verification | No boot resources created |
| `3be66e87a1d8` | Source passed; A reached healthy B134/original-eight oracle but PostgreSQL BIGINT string `"34"` failed the numeric assertion, and `SCHEMA34` was masked as `CLIENT_CLIENT_FAILED`; QA-only integer cast/closed error code corrected atf1366fd | Cleanup passed; all six resource-category counts zero; failed checkpoint retained |
| `462d4cbffabd` | A met temporary PostgreSQL Unix-server health before final TCP readiness; backend initially refused connection. QA-only owned-PG startup/final-TCP wait corrected at702746b | Cleanup passed; owned container/network/volume counts zero; failed checkpoint retained |

These corrections change QA gates only. They do not change runtime images, production policy, schema or live PostgreSQL. Every functional fixture is synthetic. Production backups are permitted only for private operational restore-integrity verification, never real-account HTTP/login/business testing.

The completed synthetic canary is separate from live activation. Before the reviewed cutover, root independently rechecked healthy B134/MCP OFF, the original eight controls and live PostgreSQL identity unchanged; the updater remains paused. The v2 cutover passed final stopped-writer coordinated backup/isolated restore-integrity verification and private health; the non-mutating public gate failed on duplicate security headers and managed timer acceptance/readback remains pending. No new schema migration is proposed. The first-enable old-binary OFF fallback was separately rehearsed; the later header correction requires matched-ON rollback with epoch rotation, as recorded below. Neither procedure automatically restores the live database or reverses commerce. Real ChatGPT/Claude account OAuth remains owner-only NOT RUN.


## First cutover failure and separate reviewed v2 attempt

The f87 driver attempt failed at04:53:24UTC before installation: `step=snapshot`, `error=OLD_LOCAL_FINGERPRINT`, `rollback=NOT_NEEDED_PRE_CONTROLLER`, `preparation=ORIGINAL_OFF_UNCHANGED_MANUAL_POLICY_REVIEW`. Its historical B134 state correctly contained only the `compose.yaml`/`runtime.env` local fingerprint; the driver had incorrectly required `update.py` there too. No policy/configuration/application/database/epoch/codec changes or backup started. The original ledger and input remain unchanged; the original before-directory was absent. Root's read-only recovery check independently passed actual B134 health and its two-file fingerprint, unchanged eight controls and original healthy PostgreSQL identity.

The reviewed correction accepts only the exact historical two-file state and still checks old controller bytes independently. It binds the original failed ledger raw SHA256 `a2454e978256903d2bb75f8daaf9dcd781e2326d218d437790c11617f9a27855` and canonical original input SHA256 `6b2452750c86b067152911e1bedfb2dee64faa80bb0e983ec0c940c1dd1218bc`; it does not normalize state or overwrite/replay the original attempt. The same-lock proof requires the exact failed-noop ledger, unchanged original controls, absent old snapshot/epoch/codec/backup domains and actual old application/OFF/PostgreSQL identity before a distinct v2 ledger can be created.

New driver source SHA256 `17dff5c4c9413827318c69f2c95d9e419f307a5ef2ca563b18657c62bc1aba93` passed author36/36 offline guards and independent root36/36 (0skips,0.132s). These are local recorded-actuator/synthetic-file checks, not actual cutover acceptance. Root staged the separately named file and verified its bytes, then started v2 job `19546cc4-db71-4f5e-a9a3-7a04cdb75ea7` at05:39:54UTC. The actual job completed successfully at05:41:10UTC, exit0 with empty stderr. The v2 ledger/before-directory remain separate from the retained first failure; neither attempt may be replayed. Public/timer markers were NOT RUN at that private acceptance; the later public failure is recorded below.


## Actual final backup and private cutover acceptance

The final coordinated operational backup ran with application writers stopped under the held update lock. Its private restore-integrity verification passed for all3non-template databases and77tables, with `restoreVerified=true`, `finalStoppedWriters=true` and proven scratch cleanup. Private manifest SHA256 is `f1b83554799f524d53e6ffce72b7cb20f57052e6817e3847bca22de3e154a0e1`. Source PostgreSQL container ID, image ID, StartedAt and data volume were preserved. No production dump was used for functional HTTP/login/business tests; no live database restore or commerce reversal occurred.

The actual version2 ledger is `PRIVATE_ACCEPTED`/`private_acceptance_complete`, raw file SHA256 `b8ed1b8bb12aaf8adb375d03997c23a0a2055ca1df5661ff08f370fcdafda789`. Its recorded start/end are1793943597/1793943670; these are operational milestones, not an exact public outage measurement. State is current EF7, `status=manual_mcp_accepted`, `pending=null`, `profile_fallback=false`, full `seller-operations-v1` profile. The original failed ledger still hashes toa2454, and the new ledger contains the exact predecessor proof. The private ledger retained publicSmoke/timerResume NOT_RUN markers. A separate later public capture FAILED; timers remain NOT RUN and private acceptance does not close those gates.

An independent post-cutover root readback used the actual installed controller under the held lock: private health and current local fingerprint passed. All five MCP enable flags were1 with the full selector; AI and QR remained0. The state snapshot SHA256 was `5eb8a4193d2304a4b14cb484ffcbf7946fa135ee02db85e384a595f72050f3c7`. This readback preceded the public capture and does not close the public or timer gates.

Post-freeze independent review found an external one-shot guard boundary: a pre-existing root-private v2 ledger containing JSON `null` is read as `None` and could be mistaken for absence. This P2 remained unfixed in the executed17dff source. For this actual attempt the new ledger path was absent, its ledger was a dictionary and the operation ran once successfully. The finding concerns the external root-private ledger reader; it does not establish an application authorization flaw or permit either attempt to be rerun. The executed driver remains frozen. A separately authorized future archive, SHA256 `56849fb4e0b468c9a0e9496ac0bf4969384e1279ffb1a2b8c071895c7f753759`, changes only that reader to require an existing JSON object; author4/4 offline tests passed. Independent review also passed4/4 offline tests and confirmed the single-method delta. This archive was not used or uploaded for the actual cutover and does not authorize a repeat.


## Actual public failure and separate header correction

Public capture `198a1b6d`, nonce prefix `db750`, FAILED. The first6static/redirect checks passed; request7, shop-ready200, failed `DUPLICATE_SECURITY_HEADER`. Only7GET/0POST ran. Root's independent TLS-ready read confirmed exactly two identical `X-Content-Type-Options: nosniff` lines, from Node and Caddy. The strict public gate remains unchanged. At that failed capture EF7 full-profile private health remained good and timers had not been activated.

PR214 source7f2d19c separately changes one Caddy header directive to deferred Set and adds a real TLS old-fail/new-pass regression in two exact test files. The candidate is limited to `deploy/gcp/Caddyfile`, `test/helpers/mcp-production-proxy-fixture.js` and `test/mcp-production-proxy.test.js`; QA/docs do not join this corrective candidate. Root verified the real TLS regression. PR214 merged as `afba6fbf68d59cf4c3a7d498f435c5c2e97c441e`, with its tree verified byte-equal to reviewed7f2d19c. PR Verify42171721962 passed2039total/1988passed/0failed/51skipped in1103601.901546ms; branch push42171712397 also succeeded. The separate required [main Verify42174047908](https://github.com/yapweijun1996/Online-Shopping/actions/runs/42174047908) passed2039total/1988passed/0failed/51skipped in1157930.099366ms. [Publication42176183187](https://github.com/yapweijun1996/Online-Shopping/actions/runs/42176183187) succeeded for all four components. These are the actual merged-main checks; PR CI is separate evidence. No live mounted release file is edited in place.

Root actually pulled/verified immutable Linux/AMD64 header-candidate artifacts. Backend RepoDigest suffix is `bac8f8f0f17505064e925a0e29aa67073e00b512e30fdfc600bf1439a4d4de4c`, frontend `6df559800f040eb3bc0ad44e2e4be625de43ee03198db54bf232a28e29b53c6f` and codec `bc09ea27cd1e3d11e68dd083ba06da3952017139b8896b793308921b6666066f`; actual config IDs were independently observed with the same respective SHA256 values, not inferred from RepoDigest type. These staged identities were subsequently accepted by the private/public/timer gates below.

The fresh actual canary is nonce `b88b987a934c`, manifest SHA256 `0abf0776dc4e1d0c4558b0d4e6816770a79bef67097d7f80034bab0b8cb13cc9`. Its source/A job prefix `be12aafb` started06:48:31UTC; all seven phases and cleanup actually PASSED, with remaining job `0405d05f` successful at06:54:33UTC. Final report SHA256 is `86244ed77de8be2ee82e2c6d5fb9752e715cc32d532851f24b2baf33b480fe2d`. Independent project/owner-filtered container/network/volume counts were all0. This is separate actual AFBA evidence, not a copied EF7 result.

The authorized corrective path is a new controlled ON-to-ON operation: bind accepted EF7/full profile and rawb8ed predecessor, unchanged installed policies/runtime/PG/epoch, exact new-main CI/artifacts/new canary, and a protected-source map differing only in the reviewed Caddy blob. It requires durable pending, all-writer drain, fresh final operational backup/isolated restore, actual new private health, then a new strict public capture and timer acceptance. The separately frozen ON backup archive `03b22dc93c539b7d512f0d50abdbc79fc3ef1427996398810e608c175072cf11` changes only the3c current-contract gate to real EF7/full-profile validation; its37/37 offline guards are not actual candidate backup evidence. A separate post-header helper retains the strict original28 public probes and no relaxed header checks. Its final metadata is bound to the actual v3 source/input/accepted ledger; its28 offline guards are not public/timer acceptance. Root generated the actual new v3 input, raw SHA256 `02c50e1e1ee69e39fd305f0410de92266a531c752d81040ec9604a9379365a19` and canonical SHA256 `10f383a9a925a6b2c946be5ed7314360fa207db02904af49568d07cbd94c2904`; validation and actual Host paths/current/private health/CI under the held lock passed. The fresh backup directory did not yet exist at that preflight. The subsequent actual v3 cutover is recorded below. The earlier3c backup and first-enable driver remain historical; no B134 substitution, constant monkeypatch or first-enable replay is allowed. Failure must actually restore the matched old ON tuple with a fresh generation and rotated epoch, preserving commerce and source PG.

## Actual header ON-to-ON private acceptance

The executed header driver was frozen source `363f8728a2f1ae1d74b145d4acfb0000421f1130cbbb8d424636fc99bff31fd8`, independently verified27/27 offline before staging. An earlier6b515841 local draft retained an undefined legacy snapshot call; review caught and corrected it before upload. That draft was archived and never executed in production. Actual v3 job `41052052` succeeded at07:01:46UTC, exit0/empty stderr. The version3 ledger has `execution=ACTUAL`, `status=PRIVATE_ACCEPTED`, `step=private_acceptance_complete`, raw SHA256 `31abb24a81b26e1ac1c8387ebfe8b9f2445cf82439ff9e6d340ed567b58d3563`. Independent root readback under the held lock passed AFBA running source/tuple/private health, unchanged epoch and no pause/pending/fallback; state raw SHA256 is `7102523d2f8773964ff4e77751da8264737db29e7747a472e772bc9cc125ce89`.

The new ON-specific operational backup actually verified all3databases/77tables with statusVERIFIED, restoreVerified/finalStoppedWriters/scratchCleanupVerified true. Manifest SHA256 is `4a75b9334ec316ab4332be405632a6e2a179a3bc1835d9ea930efd04e9a3e7a7`; source PG ID/image/StartedAt/volume were unchanged. Start/end1793948442/1793948506 are operation milestones, not an exact public outage measurement. No production dump became a functional fixture, database restore or commerce undo.

The initial post-header helper was frozen at `ebef94fddb960229e971b1531a1dea5d27635cee7d578858e2c446125fa79040`, with actual input/accepted-ledger pins. Its strict public child is `f03d69fc9a03eae589919758baf64fd16309c7d2862f441456708dc20b8d415b`, differing fromdd346 only in SOURCE_SHA. New public capture and timer activation are still NOT RUN at this private-acceptance snapshot; the earlier EF7 public failure remains preserved.

## AFBA public child PASS and wrapper order failure

New capture `dd40c125`, nonce prefix `0d61`, remained FAILED with `PUBLIC_STATE_CHANGED`. Its actual f03 child passed all28public checks in1.403s, including the single empty anonymous POST; `public-result.json` was retained. Root compared all6before/after container identity outputs: backend/PG differed only in `Mounts` array order, while every field was equal after sorting; frontend was identical. Actual state710 and ledger31 were unchanged. No global activation record or unit installation occurred. This was an acceptance-wrapper comparison bug; the actual failed receipt was not edited or promoted to PASS. It is separate from the earlier EF7 duplicate-header failure that required PR214.

The executed ebef source/935 tests were archived unchanged. Separately reviewed helper `d8073a8edba03f1a54ddda85470ba5c45f3125ec20fdfafa22b2f4a78f39f179` adds only a pure identity normalization and one snapshot call: require a Mounts list of dictionaries, each with a unique canonical absolute Destination, then sort by Destination while preserving every mount field. Source/RW/Type/Mode/Propagation and unknown-field changes remain identity changes. Author32/32 offline guards and independent32/32 passed, including the actual Host.snapshot fixture path; f03, runtime/main, metadata, strict28 public checks, receipts and unit logic were unchanged. The correction used a new basename/nonce for the actual verified capture below; neither failed namespace was reused.

## Actual public verification and bounded timer completion

After the mount-order correction, actual capture job `95ee442d` succeeded at07:21:56UTC with `PUBLIC_VERIFIED`, all28 strict public checks and a stable normalized snapshot. Nonce was `84497597dac93396aff6866d`; receipt raw SHA256 is `a349117668217c3502631942611230b76f0e970057074bbf4e9377b0d23438af`. The fixed probe plan uses27GET/one empty anonymous MCP POST, no credentials/catalog/browser/business approval. Rate/audit metadata may change; it does not create seller consent or prove vendor-account OAuth.

Timer activation job `20175eea` then FAILED at07:22:47UTC with `ONESHOT_RESULT`. Four new units, daemon reload and verification had passed; actual recovery returned0 and emitted the correct fresh stdout, but systemd garbage collection reset show metadata to ExecMainCode0/Status0. The helper incorrectly required code1. Maintenance had not run and all three timers were stopped. The failed version3 global record remains unchanged, raw SHA256 `6e263d199a43b1871b8aee787b494311f317d11aab3fb24ee0663bb85ddf50fe`.

Reviewed GC helper `0716bc2deb714f00649d0619f3424c365115dd3d37799f134df12760d82134d0` requires actual start rc0, inactive/dead success/status0, unique expected child stdout and trusted PID1 start/finish records with the same invocation ID, correct time order and JOB_RESULTdone. It accepts code0 or1 only with this complete fresh journal proof; missing/skip/wrong invocation/failure is rejected. Units were not changed to RemainAfterExit. The bounded continuation `3db40ab2a92a1255008296d83b8f3339d34e3719f58958d36cd1756dfbd39ea8` pins that failure and the real844 receipt, checks current AFBA/six effective unit pins/all timers stopped, skips installation and uses a distinct O_EXCL version4 record. The original30-minute receipt deadline was not extended.

Actual continuation job `a86e3b84-f298-4caf-bfa2-22c08ee54396`, new nonce `b3b63a7c64569e7ce0b0b3f2`, succeeded at07:49:20UTC, exit0/empty stderr. Version4 is `ACTUAL`/`ACCEPTED`, raw ledger SHA256 `0717a5be959821ea4b88fe53ce3fe0ba691886b987a9e12febd0378f664901d3`. Actual recovery rc0 invocation was `1e3f6785f740400ba14a338261382c63`; maintenance rc0 invocation was `33a914f7def44033b827ee46e46fc84b`, with stdout matched. Independent readback confirmed `online-shopping-update.timer`, `online-shopping-mcp-recover.timer` and `online-shopping-mcp-maintenance.timer` active/waiting/enabled with finite next triggers. State710, epoch and codec state remained unchanged; AFBA/full profile stayed healthy. Earlier failed records remain FAILED and retained. This completes AFBA runtime acceptance, with owner-only vendor OAuth still NOT RUN.

## Subsequent QA/documentation main release

The evidence above separately identifies EF7 first enablement and AFBA header correction/runtime acceptance. QA helper702746b and PR213/final documentation are a separate source revision; EF7 run IDs do not approve the later merged main. The header correction has passed its controlled runtime gates. After that later QA/docs merge, require the new exact-main Verify and four-component publication, then a normal same-code forward deployment and actual main/live identity readback. Normal forward deployment retains the accepted epoch and does not undo commerce.

Record the final main SHA, its own CI/publication/artifact identities and accepted live readback in the final root release report/KB evidence, with a later dated appendix if needed. This historical activation record does not need to name its own future documentation commit or start a self-referential commit/CI loop.
