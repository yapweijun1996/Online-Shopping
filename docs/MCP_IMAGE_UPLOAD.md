# Upload a product image through MCP

## Supported paths

| Client capability | Tool and flow | Limits |
| --- | --- | --- |
| ChatGPT supplies a file descriptor | `media.list` → `media.upload_file` with the attached file → returned Seller Approval link → `media.commit_upload` after approval | Existing product, PNG/JPEG/WebP, source at most 512 KiB; HTTPS on exact `files.oaiusercontent.com` host only. |
| MCP client can read the actual image bytes | `media.list` → `media.prepare_upload` begin/append/seal → Seller Approval link → `media.commit_upload` | Same source limit. Each append: up to 12 independently encoded base64 strings, each at most 4,096 characters; at most 36 KiB decoded per call. |
| Client can see an image but cannot provide a file descriptor or exact bytes | Use the authenticated Seller Studio product editor to upload the image | A visible chat image, sandbox path or Claude file ID alone is not an upload capability. Do not invent a URL, base64 data or SHA-256. |

ChatGPT's supported file descriptor is declared by
`_meta["openai/fileParams"]: ["file"]`. The official contract requires
`download_url` and `file_id`; `mime_type` and `file_name` are optional but declared
in the schema. See the [OpenAI file-input reference](https://developers.openai.com/plugins/reference#define-file-inputs).

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

1. Connect the intended shop's seller MCP URL. For the documented GCP default
   shop this is `https://seller.demoonlineshopping.xyz/mcp`; a tenant uses
   `https://seller.demoonlineshopping.xyz/<shop-code>/mcp`. These are deployment
   addresses, not a claim that the service is currently reachable.
2. Sign in and grant the needed media scopes. The server also checks the current
   account's catalog capability; an old read-only grant cannot upload.
3. Choose an existing disposable test product. Attach a PNG, JPEG or WebP under
   512 KiB. Ask: “Use this attached image as the main image of product SKU
   TEST-SKU. Read its current media revision and prepare the upload. Give me the
   Seller Approval link.” For an additional photo, ask for the gallery slot.
4. The client resolves the SKU with `catalog.list`/`catalog.get`, reads
   `media.list`, then calls `media.upload_file` with `productId`, `targetSlot`
   (`MAIN` or `GALLERY`), `expectedRevision`, a new `idempotencyKey`, and the
   actual host-provided `file` object. It must not submit a local filesystem path.
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
