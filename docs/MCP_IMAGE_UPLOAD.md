# Upload a product image through MCP

Omit `targetSlot` or pass `GALLERY` to add a gallery photo while retaining the
current main photo. Pass `MAIN` explicitly to set or replace the main photo.
The seller approval page identifies the intended placement before approval.

## Preferred upload: bytes outside MCP arguments

For images over about 8 KiB, call `media.request_upload_url` with the product,
target slot, current media revision, MIME, byte count and idempotency key. The
SHA-256 is optional. Send the original file with HTTP PUT to the returned URL,
or open that same URL and choose the file. Successful PUT automatically seals
the existing image-review proposal and returns its operation ID and review URL.
The model does not have to generate or repeat the image's Base64.

The single-use URL expires after five minutes. It is a secret upload capability,
not approval. Product images remain unchanged until existing seller review and
separate `media.commit_upload`. See [the upload URL contract and verification](MCP_UPLOAD_URL.md)
for commands, failure handling, limits and deployment state.

## Authenticated attachment-resolution limitation

`media.upload_file` currently accepts a bounded download capability; it does not
authenticate external attachment ownership against the Shop user, tenant or
grant. `file_id`, MIME/name, a signed-looking query and an allowlisted hostname
are not ownership proof. There is no authenticated attachment resolver in this
repository. Unsupported sources, including the reported Azure Blob source,
remain denied. Do not add Azure wildcard/prefix exceptions or caller-supplied
`authorized` flags. Use `media.request_upload_url` for a direct byte transfer or
file picker, or exact-byte `media.prepare_upload` for tiny inputs.

The stricter provider-bound compatibility request is **HOLD**; see the
[secure-source review](MCP_IMAGE_UPLOAD_SECURITY_REVIEW.md) for source references,
test evidence, native transformation limits and release gates. Previous live
PNG/JPEG preparation checks demonstrate transport behavior, not attachment
ownership or compatibility with every ChatGPT file provider.

## Supported paths

| Client capability | Tool and flow | Limits |
| --- | --- | --- |
| Client can send HTTP, or seller can select the original file | `media.list` → `media.request_upload_url` → raw PUT or returned file picker → Seller Approval link → separate commit | Preferred above about 8 KiB; JPEG/PNG/WebP, maximum 512 KiB, five-minute single-use URL. |
| ChatGPT supplies a file descriptor | `media.list` → `media.upload_file` with the attached file → returned Seller Approval link → `media.commit_upload` after approval | Existing product, PNG/JPEG/WebP, source at most 512 KiB; HTTPS on direct subdomains of `oaiusercontent.com`, including regional file hosts. |
| MCP client can emit a tiny file's exact bytes | `media.list` → `media.prepare_upload` begin/append/seal → Seller Approval link → `media.commit_upload` | Prefer for images at most about 8 KiB; existing 512 KiB source limit remains compatible. Each append: up to 12 independently encoded base64 strings, each at most 4,096 characters; at most 36 KiB decoded per call. |
| Client can see an image but cannot provide a file descriptor or exact bytes | Use the authenticated Seller Studio product editor to upload the image | A visible chat image, sandbox path or Claude file ID alone is not an upload capability. Do not invent a URL, base64 data or SHA-256. |

ChatGPT's supported file descriptor is declared by
`_meta["openai/fileParams"]: ["file"]`. The official contract requires
`download_url` and `file_id`; `mime_type` and `file_name` are optional but declared
in the schema. See the [OpenAI file-input reference](https://developers.openai.com/plugins/reference#define-file-inputs).

The client-facing tool wrapper and the MCP server have different file inputs.
When the client exposes `file: string` with an instruction to supply an absolute
local file path, pass the actual image path accessible to that client. Its file
bridge must upload/resolve the file and send the descriptor object above to the
server. A bare `file_...` ID does not satisfy that path contract. Neither a bare
ID nor a raw local path satisfies the server's object schema. Follow the actual
client tool definition; do not invent a path or a download URL. A valid local
image alone does not prove that the host bridge completed the transfer.

On 2026-11-17, a real connector transfer supplied
`sdmntprseasia.oaiusercontent.com`. The previous exact
`files.oaiusercontent.com` allowlist rejected it after successful argument and
target validation, producing the generic `Invalid params` error. The downloader
now accepts direct subdomains of OpenAI's documented `*.oaiusercontent.com`
namespace; see the [OpenAI network guidance](https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps).
Nested subdomains, the bare apex, suffix lookalikes, non-HTTPS sources and
redirects remain denied. Public DNS validation/pinning, native image decoding,
size/deadline/concurrency bounds and seller approval still apply.

The current upload accepts omitted/empty MIME hints and
`application/octet-stream` as unspecified. It detects the actual image MIME from
bytes and then decodes the image through the native codec. An empty optional
filename is allowed. A concrete image MIME hint must still match the bytes;
generic metadata does not permit non-image files, arbitrary download hosts,
redirects or larger inputs.

Claude or another MCP host can use the chunked base64 API when it has access to
the exact source bytes and can compute their digest. The OpenAI file-parameter
extension does not establish automatic attachment transfer in Claude. Real
vendor-account handoff must be tested in that client.

## ChatGPT test flow

1. Connect the intended shop's seller MCP URL. The current Pomelo Stem default
   shop uses `https://seller.pomelostem.com/mcp`; a tenant uses
   `https://seller.pomelostem.com/<shop-code>/mcp`. Seller Studio is
   `https://seller.pomelostem.com/seller/`. Other installations use their own
   configured seller origin; legacy deployment addresses in older runbooks are
   not substitutes for the connected shop.
2. Sign in and grant the needed media scopes. The server also checks the current
   account's catalog capability; an old read-only grant cannot upload.
3. Choose an existing disposable test product. Attach a PNG, JPEG or WebP under
   512 KiB. Ask: “Use this attached image as the main image of product SKU
   TEST-SKU. Read its current media revision and prepare the upload. Give me the
   Seller Approval link.” For an additional photo, ask for the gallery slot.
4. The client resolves the SKU with `catalog.list`/`catalog.get`, reads
   `media.list`, then calls `media.upload_file` with `productId`, optional
   `targetSlot`, `expectedRevision`, a new `idempotencyKey`, and the file input
   required by the client wrapper. For a wrapper that requests an
   absolute path, use the real image path in that client's environment; the host
   bridge supplies the `file` descriptor object on the MCP wire. Direct MCP
   callers must provide that descriptor, not a filesystem path or bare file ID.
5. Open the returned `reviewUrl`, sign in to the same shop, review the exact
   before/after images, and approve with the required seller credentials. Until
   this step, the proposed image has not replaced a product photo.
6. Ask the client to call `media.commit_upload` for the returned `operationId`.
   Check the product in Seller Studio and, if published, the storefront. Use a
   fresh media revision for the next independent upload.

A `GALLERY` upload must target the listing's gallery holder and requires a main
image first. A concurrent product/gallery change can invalidate a proposal;
refresh and prepare a new intent rather than overriding the revision.

## Base64 and database storage

The chunked path starts with the exact decoded byte length, source MIME,
SHA-256, target slot and current revision. Append offsets are decoded-byte
offsets; `dataParts` contain canonical base64 only, without a
`data:image/...;base64,` prefix. After all chunks are acknowledged, seal prepares
the same protected review as the file-descriptor path.

Base64 is transport encoding. PostgreSQL stores source chunks in
`mcp_v2_media_chunk.data BYTEA`; the staged canonical image/thumbnail also use
`BYTEA`. Commit copies the approved canonical bytes to `product.image_data` for
`MAIN`, or `product_gallery_image.data` for `GALLERY`. SQLite uses `BLOB` through
the same services. No database schema migration is needed for the optional-file-
metadata compatibility fix.

## Diagnostics and verification boundaries

| Symptom | Check |
| --- | --- |
| Upload tool absent | Media runtime/profile enabled, current role, fresh `media.write` consent, intended shop connection and refreshed client tool discovery. |
| `Invalid media.upload_file argument: …` | Check the named field against the current tool definition. A path-based wrapper needs a real absolute image path, not `file_...`; the server needs the transformed descriptor. No submitted values are echoed. |
| Unsupported image download host | The file bridge supplied a source outside the verified allowlist. The error names only the hostname, never its path or signature. Use exact-byte chunk upload, or investigate the source before adding a narrowly verified origin. Changing the local filename or file ID cannot fix a rejected download host. |
| Downloaded file format or MIME mismatch | The returned bytes are not a supported image, or disagree with an explicit MIME hint. Verify the actual downloaded bytes; a valid source file alone does not establish a valid transfer. |
| `INVALID_ARGUMENT` / `Invalid params` | Older servers and other input failures may return a generic error. A valid local path does not prove bridge/download compatibility; do not identify the failing field from this error alone. |
| Invalid file reference | Real host-provided descriptor, supported source hostname, no local path/redirect, supported metadata and actual image bytes. |
| Source unavailable | Temporary URL expiry, DNS/network failure, source above 512 KiB, or deadline; a file ID alone cannot refresh a URL server-side. |
| Revision conflict | Product/gallery/variant relationship changed; fetch current media state before preparing a new upload. |
| Approval/commit denied | Same original grant/account/shop, valid seller session, required scope/capability, exact review evidence and current credentials. |
| Service unreachable | Hosting/ingress/readiness must be restored before vendor testing; local tests do not establish live deployment. |

Focused tests: `test/mcp-media-file-download.test.js`,
`test/mcp-media-upload-file.test.js`, `test/mcp-media-tools.test.js` and
`test/mcp-media-coordinator.test.js`. They cover transport policy, schema and
generic metadata, binary storage on both databases, approval/commit, source
limits, authorization, stale revisions and concurrency. Download transport and
approval/decoder fixtures are synthetic; native-codec and real browser/vendor
acceptance are separate checks. Never use a passing fixture as evidence of a
successful upload from a real ChatGPT or Claude account.
