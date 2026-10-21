# WhatsApp QR dependency/resource spike

## Decision

**CONDITIONAL GO for building phases 5–10 offline; NO-GO for activation.** One isolated session appears affordable on the stated 2 GB VM with 1.3 GB free, but fake-workload Mac RSS is not a live capacity qualification. Keep all QR functionality absent/default-off until the gates below pass. Nothing in this spike is imported by the backend or copied into its image. No number, real credential, WhatsApp connection or message was used. No commit was made.

## Supply chain

Evidence is under `worker/whatsapp-qr/evidence/`: `metadata.txt` (actual npm view), `tree.txt` (complete npm ls --all), `inventory.json` (every locked package, license, resolved URL, integrity, available manifest scripts and native indicators), `audit.txt`, `signatures.txt`, and the raw `attestations.json`. These are review artifacts, not runtime inputs. `evidence.mjs` refreshes them with npm/registry calls; do not run it as an offline test.

- Exact official scoped pin: `@whiskeysockets/baileys@6.7.24`, MIT, Node >=20, published 2026-07-29T00:57:39.981Z; registry unpacked size **12,885,764 bytes**. Registry legacy tag is 6.7.24; latest is 7.0.0-rc14. No fork or automatic version update.
- Integrity matches the design: `sha512-Ljq7si+gsNIE9d5dP69E99TTQp+BxxPgitWvmZMXExGc1Ctr0SCDLFZmxRLUDC5HB0/Itw5uk+HJeBONrLP99Q==`. Two registry signatures use key ID `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U` (full signatures saved).
- `npm audit signatures` exited 0: **118 packages with verified registry signatures; 15 with verified attestations**. This does not cover Git source or prove absence of malware. Registry attestations endpoint returned HTTP 200. Decoded SLSA-v1 statement binds the tarball SHA-512 to `https://github.com/WhiskeySockets/Baileys`, `refs/tags/v6.7.24`, commit `e0629940ee2d335b0c0119367fd2a934e0fa3189`, workflow `.github/workflows/publish-release.yml`, GitHub-hosted runner, invocation `30412566285/attempts/1`. Metadata gitHead agrees. Release diff/source security review remains required before deployment; provenance is origin evidence, not code approval.
- The only Git dependency is `libsignal` 6.0.0. Upstream manifest floats; override pins `bcea72df9ec34d9d9140ab30619cf479c7c144c7`, independently resolved via `git ls-remote https://github.com/whiskeysockets/libsignal-node.git HEAD`. npm canonicalizes its lock URL to `git+ssh://git@github.com/...#<hash>` and warns that Git integrity is skipped. Full commit pin is not a registry signature or reviewed source hash. Future clean installs need GitHub access and appropriate Git transport configuration; do not substitute forks.
- All installs and clean `npm ci` used `--ignore-scripts`. Baileys preinstall (`engine-requirements.js`) and prepare/prepack builds are disabled; distributed JS is used. Protobufjs postinstall (`node scripts/postinstall`) is disabled. No other installed package declares preinstall/install/postinstall; the inventory preserves all other scripts for review. No dependency lifecycle hook was approved.
- Sharp is a **non-optional peer**, explicitly pinned, not suppressed using legacy-peer-deps. Initial 0.34.5 had one high-severity vulnerable package (three libvips/libheif/librsvg advisories); changed to **0.35.5**. Final npm audit exits 0 with **zero vulnerabilities**. Optional jimp, audio-decode and link-preview-js peers are not installed. No media operation is exercised.
- Native graph: sharp and all `@img/sharp-*` platform/WASM packages and `@img/sharp-libvips-*` bundles are enumerated individually in inventory.json, including other-platform optional entries in the lock. Mac installs the Darwin arm64 binaries. No native build/download hook is run. Linux smoke below does not load sharp and does not validate its Linux binaries. No Chromium.
- Local QR encoder **qrcode 1.5.4**, MIT, repository `github.com/soldair/node-qrcode`, unpacked **135,364 bytes**; locked integrity `sha512-1ca71Zgiu6ORjHqFBDpnSMTR2ReToX4l1Au1VFLyVeBTFavzQnv5JxMFr3ukHVKpSrSA2MCk0lNJSykjUfz7Zg==`. No external QR service or browser/CDN artifact. PNG encoding works locally; handset decoding is unverified.
- License inventory includes MIT, BSD-3-Clause, Apache-2.0, ISC, 0BSD, LGPL-3.0-or-later and composite native licenses. **libsignal is GPL-3.0**, not MIT merely because Baileys is MIT. Distribution/source-offer/legal review is a release gate. Per-package licenses (including composite Windows/WASM declarations) are in inventory.json; bundled third-party notices still require image-level review.
- Full lock is provided for version control, not staged/committed by this job. Reproduce with Node 24: `npm ci --ignore-scripts --no-fund --registry=https://registry.npmjs.org`. Initial install used host Node 23 and warned; clean reinstall, all final tests and measurements used Node 24.21.0. No root dependency changes.

## Offline behavior and limitations

`offline.mjs` calls actual Baileys `initAuthCreds`, `BufferJSON` replacer/reviver and protobuf `AppStateSyncKeyData.fromObject`. Synthetic random auth is never printed or saved. Custom in-memory adapter serializes binary records, splits JSON into 4096-character chunks (below secret-box's 8192-character bound), encrypts each using AES-256-GCM and context/index AAD, and checks the reconstructed digest. Tests prove binary credential/key restoration, deletion, tamper/swap/truncation/wrong-key rejection. JSON intentionally omits undefined optional credential fields, matching upstream serialization. This is a spike adapter, **not** the phase-5 transactional production adapter: no durable manifest authentication, database CAS, concurrent writers, rotation or crash recovery is claimed.

QR composition mirrors `lib/Socket/socket.js` pair-device's `[ref, noise public key, identity public key, advSecretKey].join(',')`, using a synthetic reference and real generated auth keys, then actual qrcode PNG encoding. **The library socket's QR event/handshake path is not exercised.** It is not exported as a pure function; constructing a real socket is intentionally avoided. This verifies auth pure functions, serialization and the local encoder instead, not pairing compatibility. No makeWASocket call or transport is instantiated.

## Measurements (Mac proxy, not GCP)

Node 24.21.0, darwin arm64; `node --max-old-space-size=192 measure.mjs`, one cold process. Import timing includes Baileys/encoder import and module initialization, not a WhatsApp connection. Idle sampled after one second; workload retains 500 synthetic 16 KiB binary records plus credentials/app key (502 records), encrypting and reading each and rendering one QR. Random PNG compressed size varies.

| Metric | Observed |
| --- | ---: |
| Cold import | 398.779 ms |
| Idle RSS | 110,526,464 bytes (105.4 MiB) |
| Workload RSS | 197,574,656 bytes (188.4 MiB) |
| Process high-water RSS | 193,520 KiB (189.0 MiB) |
| Workload heap used | 36,755,152 bytes |
| Workload external / array buffers | 56,904,561 / 44,628,128 bytes |
| node_modules allocated disk (`du -sk`) | 53,840 KiB (52.6 MiB) |
| QR PNG in measured run | 3,647 bytes |

**Estimate, not measured requirement:** start with the design's separate 384 MiB container, old-space 192 MiB, 0.5 vCPU and one session. Fake peak leaves ~195 MiB within that ceiling, but RSS includes external buffers and real history/reconnect traffic may exceed it. No p95, sustained CPU, socket idle, reconnect or real burst measurement exists. The stated 1.3 GB free leaves roughly 0.9 GB after a full 384 MiB worker, above a 512 MiB reserve on paper. Actual admission must measure host physical RAM/free memory, other-container peaks and swap. Current compose caps are **48+384+192 = 624 MiB**, not the old design's 496; adding worker makes **1008 MiB** before kernel/shared gateway/other containers. Limits are not reservations. The deployment documentation's historical 1 GiB discrepancy is not resolved by this Mac run.

## Executed verification

From worker directory after clean script-disabled npm ci, actual `node --test` output:

```text
✔ synthetic auth survives binary storage and produces a local QR PNG (68.896417ms)
✔ chunk tampering, swapping, truncation and wrong keys fail closed (2.951583ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 642.128625
```

Also executed the same tests in cached `node:24.20.0-alpine` Linux arm64, read-only worker bind mount, `--network=none --memory=384m --cpus=0.5 --read-only --cap-drop=ALL --security-opt=no-new-privileges`, old-space 192 MiB, no image pull. Actual result: 2 tests, 2 passes, 0 failures, duration 1454.497209 ms. This proves pure-function Linux compatibility only; it reuses Mac-installed JS, not a clean Linux native dependency install or target GCP architecture proof. Root `node scripts/check.js`: `JavaScript syntax checks passed.` It was not changed; worker files were executed directly. Full root suite was not run for this isolated spike.

## Conditions and residual risks

Proceed with offline phases only under the fixed pin/lock and no-live-network test boundary. Before pilot: review Git source/release diff and GPL/native notices; clean install/test on target Linux architecture; produce reviewed worker image digest/SBOM; implement durable authenticated chunk manifests, fencing and failed-persistence shutdown; complete phases 5–10 security/privacy/provider-exclusivity controls; verify actual host capacity with >=512 MiB reserve and no swap thrash under real reconnect/burst; obtain explicit seller risk acknowledgement and dedicated owner-supplied test number. No deployment or activation is approved here.

**The seller's number can be restricted or permanently banned. Unofficial linked-device access is a Terms-of-Service risk even for inbound-only human replies.** Dedicated number/low volume/consent do not eliminate it. Live 6.7.24 protocol/LID compatibility, pairing, remote unlink, restart persistence, delivery, coexistence with Cloud, account enforcement and VM performance remain unverified. A successful fake test or clean npm audit cannot settle those questions.

## Production worker

The isolated `worker/whatsapp-qr/` package now implements the v1 internal protocol with generation/lease fencing, memory-only Baileys auth, serialized versioned persistence, direct-text ingress, bounded reconnects and human-reply claims. The backend does not import Baileys. The historical spike adapter, encoder and measurement script were removed; the measurements and evidence above remain historical review artifacts. `evidence.mjs` is retained because this document references its registry evidence refresh procedure. It is not an offline test.

Exact dependencies are Baileys 6.7.24 and its non-optional sharp peer 0.35.5; qrcode was removed because QR rendering belongs in the browser. The libsignal override remains pinned to `bcea72df9ec34d9d9140ab30619cf479c7c144c7`. Script-disabled clean install added 92 packages and audited 93 with zero vulnerabilities. The first host install used Node 23 and emitted an engine warning; runtime verification uses Node 24. GPL-3.0 libsignal distribution obligations and unofficial-client ToS/number-ban risk are explicitly accepted by the owner; acceptance is not a compliance or ban-safety guarantee.

Run `cd worker/whatsapp-qr && npm ci --ignore-scripts && npm test` with Node 24. Tests use only a loopback HTTP contract fixture and fake sockets; no WhatsApp connection is made. CI verifies this separately and publishes `ghcr.io/yapweijun1996/online-shopping-whatsapp-qr:<sha>` from `Dockerfile.whatsapp-qr` in a separate guarded job. GCP is linux/amd64; CI builds that architecture.

Local OrbStack linux/arm64 build succeeded and the image printed `ok` when importing Baileys with `--network none --read-only`. The host lacked the Docker buildx plugin, so Docker used its legacy builder successfully. This proves image import, not live pairing, delivery, native media operations or production capacity. No deployment or activation was performed.

Production verification (Node 24.21.0): 12 tests, 12 passed, 0 failed/skipped; `npm audit --omit=dev` reported zero vulnerabilities. Lock contains 115 dependency entries including optional platforms; clean Node 24 Darwin install added 90 packages, Linux image install added 92 (93 audited including the root). Loopback runtime smoke emitted CONNECTING → PAIRING → CONNECTED → IDLE and recorded reply SENT. Actual entrypoint without required configuration emitted only `{"state":"ERROR","code":"WORKER_FAILED"}` and exited 1. Final local image ID: `sha256:f5573bfcf5ace82965d9c8f7d38099b9ee04a05a9e2982c33ea3991279a3b7f0` (linux/arm64).

The image also ran `node --test test/worker.test.mjs` with only the test directory mounted read-only and networking disabled: 10 worker tests passed, 0 failed. Configuration tests (which intentionally create a temporary token file) were run on the host, not against the read-only container root.

Repository compatibility: `npm run check` passed. After installing missing root dependencies with script-disabled `npm ci`, `NODE_ENV=test npm test` finished with 619 tests: 532 passed, 0 failed, 87 skipped (including PostgreSQL cases without a configured test database). CI publishing and linux/amd64 execution remain unverified locally.
