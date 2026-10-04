# Share application branch verification

Criterion12 was exercised through the actual product Share button at390/1280 on unchanged application head `fd0a9fcda3a782c2d155601bf39235500a7d1033` (Shop110/Seller89). The42browser checks and six existing `test/product-share.test.js` checks pass. No application defect or product change was found. The new harness/documentation commit does not require a PWA version change: all application/dependency bytes are inherited unchanged. Do not describe the raw run as a newly executed test at a later documentation-only head; verify source and harness hashes against that review head.

Run `scripts/qa-share-ui-branches.mjs` with the existing cached `QA_PLAYWRIGHT_MODULE`, exact `QA_EXPECTED_HEAD` and a new `QA_OUTPUT_DIR`. One serial cached Chromium browser, fresh context per width and fresh page per case, service workers blocked, disposable in-memory SQLite and real local Worker/API product reads. Bootstrap credentials are ephemeral and kept out of artifacts. Its local Production setup value is fictional, with server production=false and no live grant/account. Browser API functions are installed before application startup so no case can call the native share panel or real clipboard. No permissions are requested/granted; no external Share/Chat navigation occurs. External network requests are blocked and recorded; business writes after bootstrap must be zero and all domain table hashes remain unchanged.

Ten application branches per width:

| Branch | Expected application result | Controlled calls |
| --- | --- | --- |
| Share resolves, canShare API absent | Share completion feedback; no copied/delivery claim | Share1, copy0 |
| Share pending, injected duplicate click | Busy button/aria-busy; exactly one share until completion | Share1, copy0 |
| AbortError cancellation | Cancellation feedback; hidden manual link | Share1, copy0 |
| Share unavailable | Copied feedback | Share0, copy1 |
| canShare=false | Share is never called; copied feedback | Share0, copy1 |
| Share rejected | Copied feedback after fallback | Share1, copy1 |
| Share throws synchronously | Copied feedback after fallback | Share1, copy1 |
| Share unavailable, copy rejected | Manual-link help, selected read-only canonical URL | Share0, copy1 |
| Share/copy both rejected, then explicit retry | Manual help first; successful retry hides old field/feedback | Share1, copy1 first; one additional explicit copy |
| Clipboard API absent | Manual-link help, selected read-only canonical URL | Share0, copy0 |

Initial button clicks are real trusted browser clicks. The pending duplicate is explicitly injected and labelled; it is not claimed to be a second real user click. Share calls occur with browser user activation. Titles and canonical URLs must match the initiating product; the fictional query string is removed, including after selecting B. These assertions prove application wiring, not native panel availability or clipboard authorization.

Five deferred outcomes (share resolve, AbortError, noncancel rejection, copy resolve, copy rejection) each run across A→B and A→B→A at both widths:20late-result checks. Current product/title/quantity/status/manual field/focus/localStorage are captured before delivery and must remain identical afterward. Old share rejection cannot start a clipboard fallback. A copy already initiated for A may settle after leaving; no new copy is generated and no feedback leaks. Each case then explicitly clicks current Share again and must request the current product URL successfully. Two overlap checks hold both old A and fresh B sharing, reject A, and prove B remains busy until B's own result.

Negative branches are retained as explicit passing rejection/cancellation expectations; no failed diagnostic is hidden or relabelled. No actual product failures were observed.44actual PNGs include42case captures and two manual-copy failure captures before retry. All browser contexts/pages/browser/server/in-memory database close. Six representative screenshots may be inspected; other captures remain automated evidence.

Excluded: native OS share panel, destination apps, delivery, system clipboard contents/permission prompts, installed/physical browsers, locale/device Cartesian products and production. Criterion12's prior Chat-only evidence stays at its original head. The local Share subset can be marked PASS while overall12/deployed acceptance remains UNVERIFIED. Criterion94 receives only a Share callback supplement; its remaining finite review scope is [CRITERION94_FINITE_CLOSURE.md](CRITERION94_FINITE_CLOSURE.md), not implemented or certified by this batch.
