# Shared read-only options AFTER preparation

This business-service foundation adds no MCP definition, catalog-media flag, engine change, UI, schema migration or new writer. Portal update paths retain their existing validation and SQL sequence. Planned SKU creation remains a separate service change.

`productOptionsChange(existingBefore, normalizedPatch)` is the shared pure decision used by both the actual pre-row label check and post-row `saveOptions`. It returns the target group, replacement choice, exact requested options, base label and whether the temporary label must be checked. The before record must explicitly contain its original nullable group and label. An own `options` field means replace; otherwise an actual group change means replace with empty choices; otherwise keep. Invalid explicit options values are forwarded to the original validator rather than coerced to empty.

`prepareProductOptionsAfter(read, existingBefore, normalizedPatch)` is a SELECT-only update preparer for a real existing product. Its result is:

```js
{ action: 'KEEP' | 'REPLACE', groupAfter,
  optionsAfter: [{ typeId, valueId }], variantLabelAfter }
```

The input is the server's original before record, including its actual ID, group and label, plus its already normalized product patch. It is not a model-controlled identity or a prepared write token. Missing/inherited before identity facts and nonexistent products reject. There is no create/product-before-null fallback, actor/scope/tenant selector or validation-bypass flag.

The preparer uses the shared pure decision and existing validators. It checks the temporary base label with `requireUniqueVariantLabel` when the actual writer would; a temporarily conflicting old label can reject a move even when the later derived label would be unique. Replacement delegates selection, current inactive-choice grandfathering, type sets, combination limits and case-aware uniqueness to `prepareProductOptions`. KEEP reads current association pairs without revalidating or refreshing them. `requireGroupOptions` receives the logical after presence of choices. Association pairs describe a set, not storefront axis ordering; the original normalized intent's presence/order is not rewritten or replaced with a full after object.

The actual Portal still calls its original setter after its row/listing/gallery updates, then reads current mapping presence and checks required group options. It does not call the full read preparer or move option errors before earlier Portal validations. Both the read preparer and actual path use the same pure decision. The existing setter still validates, deletes/inserts, and refreshes labels in its original order.

The same before facts work before mutation and at the real post-row/pre-mapping stage: old mappings still provide current-choice grandfathering, while target sibling, combination, label and required-options queries all exclude this product ID. No fake SQL reader, speculative INSERT, savepoint or rollback preview is needed. A caller must still hold its lifecycle/store fence and recapture after an unlocked phase; the result grants no authority or independent concurrency guarantee.

Preserved inherited behavior includes:

- KEEP retains manual/legacy label drift and existing inactive or historically inconsistent choices. It gains no new combination-size validation.
- Replacing with empty choices removes mappings while retaining the base or explicitly patched label. Leaving a group normally gets a null label from the existing `prepareProductUpdate` rule.
- Changing groups while omitting options clears them, even if the old choices could have fitted. Structured target siblings can therefore require explicit choices.
- Explicitly replacing the same nonempty choices refreshes the derived label, unlike KEEP.
- Labels use the existing 80 UTF-16 code-unit clip and shared stored-Unicode projection. The read result also mirrors existing UTF-8 binding for an explicitly patched base label; actual Portal label writes are unchanged.

Tests use disposable SQLite/PostgreSQL databases and actual product/options/history services. They compare the read result before writing with another read at the actual business post-row/pre-mapping stage, then with final stored choices/label. Separate cases cover KEEP, clear, leave, omitted choices, inactive grandfathering, invalid values, temporary-label collisions, 300/301, Unicode, real SQL/history rollback, read-only row digests and genuine password-authenticated seller HTTP with CSRF rejection.

This helper does not validate the entire product or replace existing SKU/category/currency preparation. Catalog composition must apply its complete source/target metadata preflight before potentially large option reads, bind dictionaries and accurate after state to its composite revision, and keep independent media/native/human-review requirements. It does not prove any combined metadata-plus-media 8 MiB bound or enable new scope authority. Revert through a reviewed source change if needed; no migration or reversal of committed business state is required.
