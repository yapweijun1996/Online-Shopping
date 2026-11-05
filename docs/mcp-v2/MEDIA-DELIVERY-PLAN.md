# Media delivery plan

Date: 2026-11-05. Source audited: `08136e6`, documentation successor `5fe8a06`. **PROPOSED unless explicitly marked verified. No media tool is implemented or enabled by this plan.** This is isolated development authorization, not a production release or infrastructure instruction.

## Verified constraints

- Existing database-backed main images allow PNG/JPEG/WebP up to512KiB; thumbnails up to80KiB. Current validation checks signatures, without full pixel decoding. Gallery selection allows10 entries; a distinct variant main may produce11 visible images. Preserve that behavior.
- MCP bodies are64KiB, schema strings4096 characters and responses256KiB. Do not enlarge global limits for uploads. Existing120 calls/account-client/15minutes cannot accommodate ten maximum images with small chunks; upload accounting needs a distinct, explicit bounded policy.
- Listing membership and holder ordering can change gallery associations. Thumbnail setters do not advance the product timestamp. Complete revisions must bind bytes, relationships and ordering, rather than timestamps alone.
- The source GCP backend budget is384MiB with a192MiB JavaScript heap. JavaScript heap or Worker limits do not enforce a native decoder memory allowance. Production capacity remains unverified.

## Bounded implementation batches

1. **Codec isolation, in progress.** Keep a separate pinned dependency manifest under `media-codec/`; leave backend dependencies and production manifests untouched. Use current patched Sharp, a fixed JPEG/PNG/WebP loader allowlist, full raster decode, metadata stripping, documented orientation and same-format encoding. Reject output exceeding existing byte limits; no silent resize or fallback quality reduction. Generate the review thumbnail from verified full pixels.
2. **Storage and authority, not started.** Propose schema31 with SQLite/PostgreSQL parity, import/readiness/upgrade/rollback coverage, stage/chunk/immutable-manifest/review-evidence rows, quotas and bounded cleanup. Add trusted staged-action and resource-pin hooks, source-owned multi-scope policies, and current authority checks before and after decoding outside database locks.
3. **Authenticated image review, not started.** Show actual hash-bound old/new pixels and complete ordering/main/member effects through first-party session/challenge-bound no-store assets. Require a separate unchecked human acknowledgement and fresh password. Model flags cannot provide evidence. Reject stale/missing assets and incomplete review pages.
4. **Five real tools, not started.** `media.list`, `media.prepare_upload`, `media.commit_upload`, `media.preview_layout`, `media.commit_layout`. Upload uses closed begin/append/seal actions through the existing MCP server. Commit accepts operation ID only and applies existing product/gallery/history services atomically with stage/approval consumption and audit.
5. **Catalog expansion, not started.** Only after image policy acceptance may catalog group joins/moves or holder changes be enabled with catalog AND media authority. Initial uploads target existing tenant-owned products: create an inactive product, upload and approve its image, then explicitly publish. Upload before product creation is unsupported. If added later it requires a server-owned draft/intent, never a caller-selected product identity. Static gallery references require source/build-bound reviewed assets or explicit rejection.

## Codec process contract

The codec is an internal resource-isolated worker, not another MCP server. For isolated tests use a local Unix socket in a private directory with an ephemeral authentication token. The API process receives no Docker socket. The worker has no database credentials, application secrets or network, and runs non-root with read-only root, dropped capabilities, no-new-privileges and bounded process count. Only dependency-fetch/build steps may use verified TLS networking.

One active decode and a bounded queue of four have an external total deadline. Proposed limits:4Mi pixels,16MiB RGBA raster, one frame, at most8192 pixels per side,8-bit channels, stripped canonical image at most512KiB and thumbnail at most80KiB. Reject unsupported formats, animation, malformed/truncated input, mismatched checksums/MIME, excess dimensions, oversize output, queue exhaustion and deadline expiry. Sanitize native errors and never log image payloads.

Use an enforceable separate cgroup/container ceiling; initial development ceiling192MiB is a test candidate, not a capacity guarantee. Benchmark smaller limits and record exact architecture/image/resource settings, wall time and peak usage. A controlled worker crash or cgroup OOM must leave the synthetic parent API alive. Same-process Worker limits or sampled RSS monitoring alone do not satisfy this gate. Persistent host workloads must remain untouched; at most one owned codec test container runs at a time.

## Staging contract proposed for review

`begin` reserves target/revision/declared bytes/MIME/source hash and quota under current authority. `append` accepts at most12 canonical base64 parts of4096 characters (at most36KiB decoded per call), with exact offset/hash/length and deterministic identical retry. Different bytes at a repeated offset conflict. `seal` leases the stage, releases locks for decoding, then rechecks identity, scope, grant, epoch/build, lease, TTL and target revision before atomically creating and binding the immutable operation. A free attachable ready stage is not an authorization shortcut.

Candidate budgets are12 active stages/client,24/tenant,16MiB/client and32MiB/tenant reserved storage, and12MiB/client/15minutes uploaded bytes. A proposed240 append calls/15minutes budget must coexist with normal v1/account/shop protections. These values require actual concurrency and quota tests; they are not enabled settings. Stage TTL15minutes, absolute lifetime30minutes, pending proposal10minutes without extending the absolute deadline. Cleanup bounds both rows and bytes and works with feature off or suspended-shop hygiene. No unbounded cascade deletes.

## Acceptance and rollback

Every batch needs exact local commits, commands and pass/fail/blocked counts. Test SQLite and PostgreSQL where storage applies; use synthetic images and real RPC/first-party browser paths. Cover byte boundaries, actual decode, malicious input as data, authority revocation/downgrade, tenant binding, quota races, leases, exact image hashes, replay, rollback of service/audit failures, portal thumbnail/holder changes, bounded cleanup and restore epoch. Preserve v1 schemas and default-off/production-blocked behavior.

Codec-only rollback removes only the owned development worker and configuration; it cannot have changed commerce state. Later media rollback disables new tools and drains bounded staging while retaining committed business state and existing audit/receipt horizons. Schema31 requires its own compatible binary or coordinated synthetic restore rehearsal; flags cannot downgrade a database. Production changes require a separate release decision.

Primary dependency evidence: [Sharp security](https://sharp.pixelplumbing.com/security/), [installation](https://sharp.pixelplumbing.com/install/), [patched release advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w), and [Node Worker limits](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html). Support documentation establishes compatibility expectations, not successful ARM64 Alpine execution.
