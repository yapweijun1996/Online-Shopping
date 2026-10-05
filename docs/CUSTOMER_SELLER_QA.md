# Customer and Seller QA acceptance

The fixed inventory is [scripts/qa-checklist.js](../scripts/qa-checklist.js): exactly 100 criteria covering Customer discovery/media/cart/profile/address/checkout/history/cancellation, Seller access/company/products/order review/manual packing, actual A4 PDF/HTML artifacts, fictional Admin isolation, PWA, mobile/keyboard/accessibility, and external verification.

Each criterion has separate local and deployed results: PASS, FAIL, UNVERIFIED, or BLOCKED, with exact source/build, steps, expected/actual outcome and evidence. A source assertion, mocked browser response, synthetic provider or headless PDF is labelled accordingly. It cannot certify a physical device, public write path, live provider, production tenant authorization or restore. A criterion passes only within the recorded environment and evidence scope. No invitation is issued while required criteria remain open; 100/100 is a gate, not a promised score.

## Version and ownership baseline — 2026-10-03

Fresh GitHub read: remote main `5966ca8626c6c75e8e0ec4e34488a7c47fa29376` (PR #16). Local isolated QA branch `codex/customer-seller-qa-local` starts at that main. Its UI is Shop v105 / Seller v81. The owner-regression worktree remains `640e54511360c468f34242f7fdd95252c578d272`; Concept B remains `1b53f8d23dc77de86ec173d7155036101c264baf`; offline integration trust remains `5b4aa9b5c2b2d9f3e9e96830e91bfe3d73df9fd0`. These branches are preserved and are not silently merged or published.

Fresh public GET responses show Shop v103 / Seller v79 and readiness 200. Public Seller app has no new version module. The first shop worker GET transiently returned 404; subsequent shop/Seller worker reads returned 200. Browser observation will determine whether this is repeatable. The GitHub checkout at `/Users/yapweijun/Documents/GitHub/Online-Shopping` remains old main `285006df49101f2053a40908435ee586b6386cc4`, 33 commits behind its recorded origin; it is preserved and is not the QA source.

Public QA is read-only. Browser network guards reject non-GET/HEAD/OPTIONS requests before transmission. Mutating journeys use only fresh local SQLite Stores on loopback, with fictional accounts/contact/order data and test namespace identity verified before writes. No real orders, payments, messages, logistics, pairing, credentials, grants or production data changes are authorized by this QA. No merge, deploy, remote branch or new PR is part of this slice.

## Initial findings

- Customer viewport metadata includes `maximum-scale=1, user-scalable=no` in both the main candidate and current public HTML. It restricts browser zoom on clients that honor those settings. Remove the restriction locally and regress the authoring contract; physical pinch behavior remains a separate device gate.
- The current source has no cancellation endpoint/state for an already submitted customer order. Checkout/search/dialog cancellation is distinct. The inventory retains submitted-order cancellation as an open product/contract gap; a local checkout Back action cannot count as that feature.
- Print/Save PDF invokes the browser print dialog. Headless actual-PDF save/reopen can verify rendering and bytes, but cannot certify a physical OS Save-as-PDF dialog or native download interaction.
- Real integration providers remain unconfigured. Completed offline integration tests do not satisfy live acceptance. Production tenant principals/repository, installed iOS and production restore remain unverified.

## Evidence and limits

Ignored `output/qa/` holds environment-tagged browser JSON, screenshots, raw public assets, PDFs/HTML and suite logs. A local evidence manifest records hashes and exact heads. The 100 QA criteria are distinct from the original 18 MVP acceptance items; that production denominator is not replaced by test count or score. Historical local MVP 16/18 and production released 0/18 remain qualified as historical records.

Current KB retrieval returned relevant device/source and provider-boundary memories, including a stale GitHub-checkout baseline; fresh Git/remote/runtime evidence takes precedence. Broad engineering-context assembly exceeded its response budget, so no automated reuse-preflight success is claimed. Local source and current contracts are used for the bounded QA.

## First bounded checkpoint

Actual deployed read-only Chromium run completed 10 named cases: eight passed, two failed. Passed: catalog/image data, empty-search recovery, product primary plus six-image data/visible gallery, unauthorized Seller API denial/password toggle, Seller login layouts at 320/820/1440 px, and page-exception/write-guard checks. Failed: restrictive Customer viewport zoom metadata and missing explicit loaded-version UI in the old deployed build. Page exceptions: zero; browser-intercepted non-read requests: zero. Initial worker 404 did not recur in subsequent worker reads. These ten cases are not ten fully closed QA criteria and do not certify authenticated public write paths.

The selected Library screenshot was materialized locally, identity/version attributes verified, and pixels inspected: 364109 bytes, SHA-256 `32da9746223deb24ed7d6d2aa6e0ee71140391c3fa5d9be57ada727410231feb`. It shows DEMO-020, a main image, empty gallery manager and editable currency, consistent with the observed published Seller v79. Current main already returns six images for Seller and makes currency read-only; those changes have not been published. Concept B is likewise still local.

Two priority defects were additionally reproduced against fresh in-memory SQLite using the real API/model:

1. **Gallery ownership/persistence:** main returns six Customer and six Seller images initially. Adding one stored gallery image changes Customer images from six to two; all five static gallery references disappear from the DTO while their source assets remain intact. `withDemoGallery` applies only while canonical image count is one. Existing static thumbnails are read-only; reorder/set-primary actions have no current endpoint. A repair must preserve the initial collection when materializing a managed gallery, perform bounded atomic edits, retain assets and validate ownership/limits/failure/cancellation.
2. **Configured Chat suppressed:** fictional `+60 12-345 6789` saves successfully as `60123456789`; public `/api/v1/shop` deliberately returns `sellerWhatsAppPhone: null` in public-demo mode with `Cache-Control: no-store`, and `sellerChatURL` returns null. This is explicit DTO policy after correct persistence/normalization, not a missing setting, stale cache, or Meta/Baileys setup problem. The new authorized repair must use only the explicit public company Chat setting; a `wa.me` link remains distinct from automatic messaging integrations and is not clicked during QA.

Four focused baseline files passed **14/14**, one Node v24.19.0 worker; they do not cover the two new defects. The before-fix diagnostic independently reproduced both defects with no external calls. Evidence: `output/qa/live/browser-results.json`, `output/qa/live/deployed-versions.json`, `output/qa/local/priority-before.json`, and `output/qa/logs/priority-baseline-tests.log`.

Neutral visible-copy cleanup is inventoried but not implemented at this checkpoint. The public screenshot still shows the Demo notice, About demo orders and controlled sample description; all seven locale resources contain related copy. Replace controlled visible copy with neutral Preview/factual availability, retain non-offer/payment/delivery limitations and technical SKU/route/namespace references, then inspect rendered Customer/Seller and actual PDF/HTML outputs. Existing customer records are not a blanket replacement target.

No application source or catalog data was changed yet. Comprehensive local browser journeys, actual PDF/HTML save/reopen, new gallery/Chat repairs, copy cleanup and regression remain next work. Physical iOS, live providers, production tenant access/restore and exact candidate publication remain open. Terminal commands returned normally at this checkpoint; no GUI capture was attempted and no unrelated processes/binaries were removed.
