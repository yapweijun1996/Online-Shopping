# Isolated development media codec

This is a codec transport and resource-isolation experiment, separate from the
application. Nothing imports it from `src/`, registers media tools, creates staging
tables, changes existing seller uploads, or enables production MCP v2. The root
package/lock and production Compose files are unchanged. The codec has its own
private package and exact `sharp@0.35.5` lock under `media-codec/`.

## Trust boundary

The trusted development host starts one owned container. A private0700 base belongs
to host uid/gid1000. Inside it, a host-owned0730 socket directory initially allows
the distinct codec uid10001/shared gid1000 to create its0660 Unix socket. A separate
host-owned0640 file holds a random32-byte base64url token, bind-mounted read only.
The fixed executable rejects any runtime uid/gid other than10001:1000. Startup checks
exact directory/token owners, group and modes; no sticky/set-ID bits or symlinks.

Before returning the socket path/token to any client, the trusted host harness
changes the directory to0710, verifies its owner/mode, the same intended socket
inode/uid/gid/mode and that no other directory entries exist. The codec can traverse
the sealed directory and use the socket but cannot create entries, unlink/rename
the socket or chmod the host-owned directory back. Actual container tests assert
each denial and then decode images successfully. The token never appears on a
command line or in container environment. It expires with the session/container;
the harness removes both paths in `finally` hooks. The backend must never receive
a Docker socket or permission to start containers.

The container exposes no IP port and has network `none`, no runtime proxy values,
no DB/application/provider credentials, no source/host-service mounts, a read-only
root filesystem, all capabilities dropped and no-new-privileges. The bind directory
is writable by the codec only during trusted startup, before clients are disclosed;
after sealing it cannot create regular files or directory entries there. This is a
fixed development policy, not a filesystem quota. It assumes the pinned startup image is trusted:
sealing cannot revoke a writable file descriptor malicious startup code opened
before sealing. A failed startup/seal destroys that owned container and its paths;
the same socket directory is never reused for an automatic restart. Default
seccomp/AppArmor remain in force. Native-code compromise is still not a proof of
arbitrary host-compromise resistance. Production needs a separately reviewed
supervisor and bounded runtime filesystem, not this development harness.

The client is transport only: its socket path and token must come from trusted
configuration, never model arguments. It provides no tenant, grant, consent,
staging, image-review, transaction or business authorization. The current operation
build digest does not include this package: later integration must bind a trusted
codec image/source/lock/contract digest into immutable staging and operations.
The response's fixed codec label is compatibility metadata, not attestation.
Pixels exist in process memory and are garbage-collected; this does not promise
secure memory zeroization. Core dumps and additional swap are disabled by the
development profile, and image files are never written by the codec.

## Fixed pixel policy

Only PNG/JPEG/WebP buffer loaders are enabled. No paths/URLs, SVG, GIF, TIFF,
PDF, HEIF or AVIF inputs. Actual source bytes must match the declared SHA256 and
MIME; size1..524288. Strict warning handling, max8192 per side, max4194304 pixels,
8-bit depth and at most4 channels apply. Animation/APNG controls, WebP animation
and JPEG MPF containers are rejected, including formats a still loader might
silently flatten. Metadata is preflight only; a complete RGBA raster decode follows,
with exact returned width/height/channels/buffer-length validation (max16MiB raster).

EXIF orientation is applied to pixels. Then all metadata/profiles are stripped by
encoding from the raw raster. Dimensions are not resized to fit an output budget.
Fixed encoders are PNG compression9, JPEG quality100 with4:4:4 chroma, WebP lossless
effort3. JPEG re-encoding is lossy; neither JPEG nor color/orientation processing is
claimed to preserve original pixels. Human approval must show the exact canonical
bytes later committed. Canonical output above512KiB rejects; there is no adaptive
quality reduction or resizing fallback. Determinism is tested within the pinned
codec build, not promised across native library/architecture upgrades.

The thumbnail is intentionally resized inside128x128 without enlargement and
encoded as PNG compression9, preserving alpha. It must be<=80KiB. Caller thumbnails
and existing portal thumbnails are not accepted as evidence for their source image.

## Private binary HTTP protocol, version1

Only `POST /v1/decode` over the configured Unix socket is accepted. No redirects,
CORS, cookies, health endpoint, alternate path/query, multipart, JSON image body,
chunked transfer or extra headers. The allowed headers are Authorization,
Content-Type, Content-Length, X-Source-Sha256 and HTTP Host/Connection. Duplicate
headers reject. Authorization is `Bearer <43char ephemeral token>` compared using
`timingSafeEqual`. Content-Type is an exact allowed MIME; Content-Length is1..524288;
source SHA is lowercase64hex. The body is exactly the raw source bytes.

Successful responses are no-store, exact bounded Content-Length and
`application/octet-stream`. Binary layout:4-byte unsigned big-endian JSON-header
length, compact canonical UTF-8 JSON<=2048bytes, canonical image bytes, PNG thumbnail.
Header has exactly these fields:

```json
{
  "version": 1,
  "codec": "sharp/0.35.5/policy-1",
  "sourceSha256": "<lowercase SHA256 of actual request bytes>",
  "mime": "image/png",
  "width": 24,
  "height": 16,
  "imageBytes": 100,
  "imageSha256": "<lowercase SHA256 of actual canonical image bytes>",
  "thumbnailMime": "image/png",
  "thumbnailBytes": 100,
  "thumbnailSha256": "<lowercase SHA256 of actual thumbnail bytes>"
}
```

The JSON example is illustrative; actual wire JSON is compact. Maximum framed
response is608260bytes. The client bounds allocation before reading, rejects extra,
duplicate/noncanonical/unknown fields and invalid dimensions/lengths/version/codec,
checks exact MIME signatures, independently hashes both returned binary segments,
and binds source SHA/MIME to its request. Declared hashes alone are never authority.
The client cannot independently prove full decode without executing another decoder;
the isolated pinned codec remains trusted for pixel semantics.

Errors use fixed codes only: UNAUTHORIZED, NOT_FOUND, INVALID_IMAGE, BUSY, DEADLINE,
CODEC_FAILED. The client returns only fixed CodecError codes, never native messages,
raw bodies, token or image metadata. The development container log driver is none;
startup failure prints one constant. No automatic decode retry or container restart.

## Enforced resources and deadlines

Default dev container:192MiB memory and identical memory-swap limit (cgroupv2 swap0),
0.5CPU, pids32, core dumps0, nofile64, shm1MiB, private cgroup namespace. Node heap32MiB
is separate from the hard cgroup limit. Sharp cache is disabled and native vips
concurrency is1; codecs may use additional internal threads, bounded by pids/cgroup.
One active decode and four queued/uploading jobs are permitted, with fixed-size
input buffers instead of an unbounded array of tiny chunks. Waiting calls consume
the same5s total deadline. Busy rejects before body buffering.

Five seconds includes connection headers/body/queue/decode/response transport, with
an independent client timer. Native processing stages additionally use3s timeouts.
An unfinished running job at the wall deadline exits the entire codec process70,
not merely its HTTP response. A separate-container watchdog test proves retirement;
genuine controlled cgroup OOM and SIGKILL prove the synthetic parent API survives
and responds503 rather than returning a fabricated image. No business API integration
is claimed. The supervisor/test harness owns recovery and creates a new token.

Measured first-build4MP PNG/JPEG/WebP plus inspection peak was167301120bytes; this
includes instrumentation overhead and is not a universal worst-case prediction.
The192MiB bound is enforced by the kernel.96/128MiB trials were deliberately skipped
because the observed peak already exceeds128MiB. Later final-build measurements and
exact image/lock identifiers are in the outside worker SUMMARY. Oversize/complex
valid images may fail at the memory/time boundary; that is a controlled rejection,
not a promise all512KiB inputs succeed. Shared-host CPU/memory exhaustion still
requires admission controls before production use.

## Development commands

Use Node24.15..<25 and a trusted local unix Docker daemon. Read the cloud runtime
Docker instructions and inspect the persistent host first. No daemon restart,
Docker prune, production Compose edit or deployment is part of these commands.

```sh
npm ci --prefix media-codec --ignore-scripts --no-audit --no-fund
npm test --prefix media-codec
npm audit --prefix media-codec --omit=dev --audit-level=high
node media-codec/scripts/build-dev.mjs
MEDIA_CODEC_CONTAINER_TEST=1 npm run test:container --prefix media-codec
```

The build uses the existing pinned Node24.20.0 Alpine base, optional native packages,
`npm ci --ignore-scripts` and strict TLS. If CODEX_PROXY_CERT is configured, the build
passes it as a BuildKit secret and sets NODE_EXTRA_CA_CERTS only for dependency
fetch; no CA/token is copied into image layers. The build records the exact image
ID in ignored `.local/media-codec-image-id`. Tests require this explicit image and
host uid/gid1000, clear endpoint/context/TLS selectors, use only
`unix:///var/run/docker.sock`, and serialize at most one unique owned container.
They never attach to, inspect secrets from, stop or restart unrelated containers.
The optional `media-codec/compose.dev.yaml` profile is a separate dev-only example;
it is not included by any application Compose file. Compose alone does not perform
the host-side seal: a trusted harness must provision the private base, host-owned
0730 directory/0640 token, verify readiness and seal0710 before permitting any
client request. Starting that profile without this sealing step is unsupported.
It does not provision a production supervisor.

## Primary dependency references

Sharp0.35.5 is the upstream latest release checked2026-11-05; the upstream security
policy updates only the latest npm release. Older versions are affected by the
September librsvg advisory, so pinning an older convenient native build is unsafe.
[Release](https://github.com/lovell/sharp/releases/tag/v0.35.5),
[security policy](https://sharp.pixelplumbing.com/security/),
[advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w).

The upstream install docs list Node-APIv9 runtimes including Node>=20.9 and Linux
ARM64 prebuilds for glibc>=2.28/musl>=1.2.5. Our own pinned Alpine ARM64 image was
actually built/tested with the committed lock and ignore-scripts. Optional native
packages must remain installed. [Install](https://sharp.pixelplumbing.com/install/).

Header metadata does not decompress pixels; raw output forces the complete raster.
Output strips metadata by default, and native timeout excludes libuv queue wait,
which is why the external total deadline is separate.
[Metadata](https://sharp.pixelplumbing.com/api-input/),
[output and encoders](https://sharp.pixelplumbing.com/api-output/),
[input limits](https://sharp.pixelplumbing.com/api-constructor/).
Loader restrictions/cache/concurrency follow the
[utility API](https://sharp.pixelplumbing.com/api-utility/).
Node Worker limits exclude native/ArrayBuffer memory, so they are not used as an
RSS boundary. [Node24 Worker limits](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html).

## Deferred application gates

Before any media tools are enabled: trusted codec image/build binding, persisted
DB stages and byte quotas, immutable stage/operation manifests, complete affected-set
revision, source-owned multi-scope policy, actual old/new human image delivery and
approval proof, service-only atomic commit, bounded maintenance and restore fencing
all need implementation and both-DB real OAuth/MCP acceptance. This codec batch
alone grants no new scope, tool, business capability or production activation.
The first application upload contract will target existing current-tenant products
only: create an inactive product, upload/review/approve its images, then publish.
Uploading before a product exists is unsupported; no reserved-ID/catalog-draft
mechanism is required for the initial five media tools.
