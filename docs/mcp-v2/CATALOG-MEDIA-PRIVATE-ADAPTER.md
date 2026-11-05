# Private existing-product UPDATE adapter

`catalogMediaUpdateTool(runtime)` copies the existing catalog UPDATE descriptor
and replaces only its adapter. `catalogMediaUpdateAdapter(runtime)` supplies the
existing six domain methods and six media hooks. `runtime` is constructor-owned
`{codecDigest,nativeSession}`. This module registers nothing; the current engine's
DIRECT-only guard still rejects its RESERVED marker. Activation, configuration,
actual OAuth, human approval and browser/native acceptance are separate work.

The stable shared read is
`readCatalogMediaUpdateReview(read,{productId,normalizedInput,plannedIdentity},codecDigest)`.
It invokes the shared UPDATE state and the sole pure UPDATE assembler, returning
private state plus `manifest`, final `revision`, `reviewBinding`, `reviewLabels`
and a public `proposal`. Callers must extract public fields explicitly; raw
catalog/media captures are not a response DTO or authority source.

`parseCatalogMediaUpdateProposal` accepts exactly:

```js
{ kind: 'update', productId, normalizedInput, plannedIdentity,
  catalogReview, reviewLabels, reviewBinding, media }
```

The complete immutable proposal, including all eight fields together, is bounded
to48KiB. Canonical limit failures become controlled503, without widening global
limits. The normalized input is the literal metadata PATCH, preserving omissions;
derived AFTER values are never copied back into it. Shared validation errors and
missing products map to controlled400. The parser supplies structural integrity,
not independent resource ownership, authorization or approval.

`catalogReview.warnings` contains only fixed server-derived codes:

- `TARGET_LISTING_SHARED_FIELDS_ADOPTED`
- `GROUP_CHANGE_CLEARS_OPTIONS`
- `HOLDER_OR_VISIBLE_GALLERY_CHANGES`

They derive from the actual shared membership/option plan and complete
BeforeGraph/B2 views. No applicable facts produce an empty array. They are
recomputed with the proposal, included in its size/hash and exact live comparison,
and cannot be supplied as MCP input or interpreted as authority.

The engine remains the only orchestrator. Capture runs under its current fence,
generates a private UUID only when the metadata plan requires one, and obtains
exact old bytes through the B1 loader. Both capture and resolved-source matching
use the same seven-field references from the manifest's actually used old assets.
Hidden unused resources remain fully hashed and budgeted in the raw B1 capture
and final revision, without unnecessary native decoding or image proof. Resolve
receives private bytes, signal and deadline, invokes the existing native session
without database/tenant work, and returns only source metadata/dimensions.
Preview recaptures the complete state, compares it with resolved identity and
revision, and strips `media` from the draft because the engine adds the verified
descriptor itself. Persist/consume introduce no stage or second lifecycle.

Apply rechecks the whole public proposal and retained frame, resolves the trusted
current account for legacy history, and calls only `trackUpdate` plus the ordinary
or exact planned-identity product writer. Its trusted inventory context carries
fixed `MCP_CATALOG`, current account UUID and engine client/grant/operation/
correlation identity. Stock PATCH remains forbidden. One transaction covers the
business write, history and complete actual-after assertions; outer receipt/audit
failure can roll it all back.

`readCatalogMediaUpdateAfter` checks every affected member's full metadata,
captured dictionaries, surviving source/target closure, deleted listing absence,
physical source identities/full/thumbnail hashes, copy owner/position, saved
associations/layouts and exact visible views. It starts from the actual moved
product and remaining old source, never an already deleted selector. Its minimal
receipt is `{productId,listingId,revision}`: revision is the actual post-write
current target C1b catalog/media composite using stored input and null planned
identity. It is neither the preapproval projection SHA nor `media.list`'s raw
revision; a subsequent media action must obtain a fresh media read.

Narrow shared exports `catalogNormalizationPreflight` and
`assertCatalogMediaPhysicalAfter(read,{before,projection,plannedIdentity},snapshot)`
permit reuse without another business planner. An absent CREATE before can be
actual empty resource collections, not a fabricated B1 database snapshot.
CREATE metadata, identity, initial-stock and authority checks remain separate.

Focused tests use real product/history/frame/audit stores and explicitly synthetic
decoder/retained-frame fixtures. They prove lock-free resolver behavior, exact
service/post-state parity, closed input, staleness, hidden-byte integrity and
atomic rollback. They do not invent an approval or demonstrate activated RPC,
native worker attestation, human consent, engine replay or production safety.
COMMITTED replay belongs to the engine and must not invoke apply or reread old
source/frame resources. Rollback removes the unused factory through review;
there is no migration or independent external side effect.
