# Catalog creation media runtime

The full CREATE profile has an independent development/test flag,
`MCP_V2_CATALOG_MEDIA_CREATE_ENABLED=1`. It defaults off. Production, demo,
quick-login, missing v2/media configuration, or missing lifecycle fencing cannot
activate it. UPDATE enablement never enables CREATE. Default registration selects
one source-owned CREATE adapter; explicit empty registration remains empty.

Full CREATE retains the existing two public tool names and input schemas. It is
always HIGH and requires fresh `catalog.write` and `media.write` consent plus the
current catalog capability. The operation resource is literally `catalog/catalog`.
A new product UUID and optional listing UUID are allocated privately by the server
and bound in the proposal. Callers cannot supply identities, policy or approval.
Stock is new-SKU initial stock only, including zero/unlimited; existing stock
changes still require the separate inventory approval flow.

The existing engine alone captures under the platform/tenant fence, resolves used
old images outside database locks, rechecks the complete projection before
persistence, and applies through the existing planned creation service. It binds
exactly one new PRODUCT effect with null BEFORE to the private creation identity.
No stage/upload or new image bytes are accepted by this profile.

For an existing target, protected human review reruns the sole CREATE reader with
the stored raw catalog/media source revisions. The byte loader retains the real
existing target's raw B1 snapshot, distinct from the composite review revision.
For an empty target, there is no B1 snapshot and no image delivery; the complete
manifest still has at least one PAGE. All pages must be delivered and acknowledged
with their one-use nonce/hash. The unchecked image-review confirmation and fresh
seller password remain mandatory even when asset count is zero. Labels come from
the proposal's bound full review labels, including the new SKU.

Every prepare, review, control, commit and authorized replay rechecks the current
original grant, relevant consent cutoff, tenant revision, account/RBAC, epoch,
build and retained codec policy. Flag-off denies pending full-profile operations
without falling back to the older MEDIUM profile. Flag-on denies approval of
previously prepared MEDIUM CREATE operations. A COMMITTED replay returns only the
validated cached receipt before absent-ID or old-frame reads. The receipt revision
is the actual post-create catalog/media closure, not the approval's BEFORE hash
or `media.list` revision; later image changes need a new current read.

Ledger initialization, product history, frame consumption, typed audit and receipt
persistence share the domain transaction. Failure rolls everything back. Rolling
back the flag does not undo committed products. This isolated implementation does
not authorize production activation, backup recovery or new media staging paths.

Validation is recorded in the outside-repository worker summary. Synthetic decoder
fixtures test actual OAuth/RPC/password/ACK handlers but do not attest native image
validation or a human browser. Genuine default-factory native/HTTPS browser gates
are recorded separately when run.

The initial default-factory gate passed5/5 cases across SQLite/PostgreSQL with a
real development native worker, actual OAuth/PKCE/session/consent handlers and
HTTPS Chromium. It covers independent and new-group zero/unlimited initial stock,
PAGE-only review, existing-target native image proof, exact storefront image
hash/order, initial ledger identity, history and commit/replay. It injects no tool
registration, decoder, tenant guard, grant or human evidence. Configuration/root
boundaries plus synthetic-decoder actual handler tests passed25/25 with no skips.
These are bounded acceptance checks; the broader adversarial/concurrency matrix
and root's independent combined/full verification remain separate requirements.
