# MCP image file upload — 2026-11-10

Status: implemented in an isolated checkout; production and real ChatGPT acceptance pending.
Baseline: `83eb4af1e59368db0a2214bf7722b725a2029084`.

## Incident and repair

The reported incident stopped during model-orchestrated Base64 append. It did not
prove a server parser bug. The old tool requires canonical base64, byte offsets,
source size and source SHA-256; the backend checks complete size/hash before decode.
The new `media.upload_file` is wired into the actual operation tool registry under
existing media enablement. It accepts top-level `productId`, `targetSlot`,
`expectedRevision`, `idempotencyKey`, and `file`. OpenAI file parameter metadata
marks `file` as a ChatGPT file object with required `download_url` and `file_id`,
and optional `mime_type` / `file_name`.
Official contract: https://developers.openai.com/plugins/reference#file-apis.

Current seller/media authority, owned product and graph revision are checked
before network access. Download happens outside the database/platform fence.
The server computes the source size and SHA-256, then reuses existing
begin/append/seal phases, each of which checks current authority. The stored
operation remains `media.prepare_upload` under the existing HIGH image policy.
The tool returns an operation ID and first-party review URL, never an approval.
The agent calls `media.commit_upload` only after the seller reviews/approves, then
uses `media.list` to verify the resulting asset/revision.

## Download boundary

Only HTTPS `files.oaiusercontent.com` on port443 is accepted, with no credentials,
fragment, redirects or content encoding. Every resolved IP must be public and the
actual HTTPS connection pins one validated DNS address while retaining TLS/SNI.
The total DNS/download deadline is10 seconds, source size is capped at512KiB and
at most4 downloads can be active in one process. No Shop credentials are sent.
MIME is detected from bytes, compared to optional declared MIME and subsequently
validated by the existing native codec. Arbitrary external URLs and local paths
are rejected. A signed URL is a source-access capability, not proof that a file
belongs to a particular ChatGPT user; it never grants seller/product authority.
URL/query/file ID/name are not stored in proposals or audit. The actual host used
by a real ChatGPT file has not yet been verified; any other host fails closed.

## Recovery and image identity

Retry with the same owned target, revision, idempotency key and original bytes.
Fixed36KiB chunks use at most12 independently encoded3072-byte parts and at most15
chunks. Partial uploads resume; bound proposals replay without duplicate operation.
A completed VALIDATING upload can retry through the existing lease rules. Changed
bytes under the same key conflict. Stage expiry remains15 minutes; no automatic
lease renewal, approval, commit or forced revision update is added. After failure,
retry the same intent or let existing expiry cleanup reclaim the stage.

Source bytes are preserved and hashed during transfer. The codec then produces
canonical image/thumbnail bytes. Seller review binds those exact final bytes and
the immutable manifest; final asset hash need not equal the source file hash.

## Verification

The original disconnected client spike was removed in favor of the server-wired
implementation. Downloader tests cover format identification, boundaries, DNS
pinning, private addresses, redirects, encoding, deadline, size and concurrency.
SQLite integration tests cover MAIN/GALLERY review, approval, commit/readback,
recovery, idempotency and authorization before/after download. They use synthetic
file transport and codec fixtures; they are not proof of real TLS/native/browser
or production behavior. Independent review found no P0/P1 authorization or
approval bypass and checked17 additional URL/IP attack inputs.

Full acceptance still requires PostgreSQL, native decoder, real browser approval
and a real ChatGPT-provided file. The current execution sandbox denies Unix socket
binding/Docker access and lacks the configured PostgreSQL/browser harness. No
production product, approval, upload or media data was changed during this work.

The complete per-file local run attempted296 files and reported2120 tests:
1255 passed,121 failed,744 skipped. Another file aborted in Node's native async
callback assertion without reporting test counts. Failures include denied socket
listens/subprocesses and mandatory disposable PostgreSQL. The cleanup CLI's empty
JSON failure also reproduces on the unchanged baseline. Direct contract-export
checks and syntax checks passed. This run does not establish a green regression
gate; environment-dependent failures and skips remain pending elsewhere.
