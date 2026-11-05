# First-party image review and approval

This source batch adds protected image review to the existing seller approval UI.
It requires safe v2 configuration and explicit `config.mcpMedia.enabled === true`.
It registers no media tools. Initial acceptance uses an actual coordinator-created
internal operation; public MCP prepare/commit factory acceptance is a separate gate.

## Authorization and integrity

The existing seller session, original OAuth grant, current role/account version,
production shop mode, tenant lifecycle revision, epoch and build are checked under
the platform-to-tenant writer fence. The fixed source-owned media policy derives
HIGH risk, `media.write` and current `catalog.write` capability. Independent consent
must be canonical, no earlier than grant creation and no later than operation creation.
Reserved catalog-media policy cannot enter this review flow.

Every critical GET, delivery, ACK and final approval rebuilds the bounded complete
current resource snapshot and validates its content revision against the immutable
proposal/manifest. Canonical frame, exact stage pin/context, original receipt horizon,
codec, actual canonical byte hashes and immutable thumbnail metadata are checked.
Literal SKU/name labels come from this complete revision-bound snapshot. Labels and
effect data use text rendering; invisible directional characters are escaped visibly.

Old images use the existing exact-source `loadOldMediaAsset` helper. New images use
the exact BOUND stage loader. No caller-provided URL, path, source identity, thumbnail
or image body is accepted. The complete resource revision covers all physical images
and labels; expected asset bytes are verified again immediately before delivery.

## Protected wire contract

The existing GET `/api/v1/seller/mcp/operations/:operationId` returns the full proposal
and session-bound challenge. Media reviews additionally contain:

```js
mediaReview: {
  descriptor, // exact seven-field immutable media descriptor
  items: [{kind, itemKey, hash, pageIndex, assetKey}],
  labels: [{productId, sku, name}]
}
```

The JSON response is capped at 262144 bytes without truncation. A challenge refresh
clears bounded unconsumed delivery children through `clearMediaChallenge` before
replacement. An approved challenge/proof cannot be refreshed or erased this way.

POST `/api/v1/seller/mcp/operations/:operationId/media/delivery` accepts exactly:

```js
{operationId, previewHash, challenge, kind: 'PAGE' | 'ASSET', itemKey}
```

It requires the seller cookie, exact Origin and session CSRF. The response is exact
canonical UTF8 page JSON (<=16KiB) or a full PNG/JPEG/WebP asset (<=512KiB), with
`X-Media-Nonce`, `X-Media-Sha256`, `X-Media-Manifest` and `X-Media-Item` headers.
All responses are no-store and nosniff. The raw 512 KiB first-party image allowance
does not change the MCP 262144 byte response limit.

POST sibling `/media/ack` accepts the same fields plus exactly `{expectedHash, nonce}`.
Its successful JSON is `{operationId, kind, itemKey, acknowledged: true}`. The nonce
is stored only as a context-bound hash. Wrong hash/nonce, stale nonce, cross-session,
expired challenge and ACK replay fail. Re-delivery before ACK rotates the nonce.
An already-ACKed image can be re-viewed after fresh checks with
`X-Media-Acknowledged: true` and no new nonce; its proof remains unchanged.
No nonce or challenge is placed in a URL. A persistent 240 request/account/15 minute
bucket bounds delivery and ACK together; ordinary review and password limits remain.

## Browser and explicit decision

The browser verifies every page SHA256, canonical structure, ordered page header and
complete manifest root, then displays every before/after product role, own main image,
holder and ordered gallery effect. Deduplicated images retain every role and position.
A variant's own main plus all 10 shared gallery positions remain represented.

Only one full-image viewer is active. It fetches protected exact bytes, verifies SHA256
and MIME/length, awaits `image.decode()`, then offers an explicit per-image reviewed
button. That action sends its nonce ACK. Previous object URLs are revoked and pending
viewer requests aborted; all image content is fetched through these first-party POSTs.
CSP allows `blob:` for image display only. No remote image, data URL or raw HTML is used.
Already-reviewed exact images can be selected again without renewing proof.

Approve requires complete PAGE/ASSET ACK coverage, the separate initially unchecked
`mediaReviewed` choice and fresh seller password. Reject requires fresh password but
does not require image ACKs or the checkbox. Password verification stays outside both
locks; all session/grant/account/consent/resource/frame/challenge state is re-read under
a fresh fence afterward. A concurrent portal edit invalidates the old image review.

Approval state, approval row, challenge consumption, retained media evidence and fixed
`MEDIA_REVIEW_ACKNOWLEDGED` APPROVE audit event are atomic. The same shared
`readMediaApprovalEvidence` validator used by the engine validates the new proof before
success. Audit failure rolls the decision and evidence back. No business mutation occurs
at approval. Existing bounded terminal cleanup and audit retention remain unchanged.

These records establish authenticated delivery/integrity/explicit browser actions;
they do not attest to human eyesight, understanding, browser integrity or remote identity.
Bearer credentials and model arguments cannot approve.

## Verification

New tests use actual OAuth registration, PKCE, login and explicit scope consent,
actual coordinator/business services, real seller password/CSRF and disposable SQLite
and PostgreSQL. Native decoder packets are explicitly synthetic in these UI tests;
native codec acceptance remains separate. Real HTTPS Chromium verifies byte corruption
denial, exact-image decoding, all unique-image ACKs, unchecked choice and approval/commit.

The 300-member/10 shared-slot benchmark used 10 pages and 12 unique assets. Three complete
GET reviews measured333ms SQLite/1008ms PostgreSQL; delivery, ACK, approval and commit
measured5430ms/15398ms respectively on this development host. These are observations,
not enforced latency guarantees. Full graph checks were retained without an authorization
or binary cache. Public five-tool MCP-to-browser-to-MCP acceptance is still required.
