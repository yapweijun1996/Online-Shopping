# Single-store buyer and seller completion gates - 2026-09-30

This milestone closes the existing Demo review-to-document loop. It does not introduce payment processing, carrier integration, shipment tracking, a tax invoice or a multi-vendor platform. Manual packing is a printable checklist, not a persisted fulfillment state. Production retention/recovery and physical-device installation remain separate release gates.

| Capability | Existing inventory / gap | Local milestone gate | Live gate |
| --- | --- | --- | --- |
| Seller authentication and isolation | Existing sessions, CSRF and protected detail API | API suite; anonymous 401; CSRF 403; two-tab stale decision | Read-only anonymous denial; owner-authenticated private paths not exercised live |
| Buyer discovery/cart/profile/address/checkout | Existing browser-local profile/address and server-owned pricing/idempotency | Catalog/history/cart stable-DOM, profile interruption/address cancel, synthetic submit | Read-only catalog and synthetic browser-local cart/profile/address; no order submit |
| Seller queue/detail/review | Existing snapshots/revisions/events; cached queue was erased on refresh failure and detail lacked retry | Cache retained on 503, retry; confirm/reject and buyer status; double-click and two-tab stale recovery | Public assets and login shell; no customer reads or decisions |
| Accurate order document | Missing | Fresh authenticated snapshot; exact minor-unit line/total/currency validation; status/revision/time; no catalog repricing | Asset revision and public module checks |
| Packing document | Missing | Confirmed orders only; one recipient per section, repeated destination header, item quantities and manual checklist | Same asset checks; no shipment claims |
| Browser print / Save as PDF | Missing | Chromium measured A4 print PDF plus Poppler renders: 2 destinations, 76 long-name rows, SGD 1,902.88, 75 units each; no clipping or destination spill | Physical Safari/OS print dialog untested |
| Responsive and seven locales | Existing layout | 320/375/393/430/820/1280 seller; 7 locales; modal focus/Escape; mobile shop search-only and 52px purchase bar preserved | Focused public mobile/desktop browser checks |
| Pending storefront typography | Approved local change preserved | 102 prior tests + six widths/seven languages; measured text/action contrast | Include only in reviewed tested release |
| Production payments/courier/tax/backup | Not implemented / operational gaps | Not claimed as passed | Not claimed as complete |

## Reproducible isolated QA

Run Node 24 with a new database and synthetic account on loopback port 3793, `SHOP_MODE=demo`. Browser scripts under `test/browser/` have a fixed loopback origin and synthetic credentials, and must never be repointed to production. `seller-e2e.js` submits only anonymous Demo fixtures locally; `seller-stale.js` tests revision/CSRF and translations; `seller-pdf.js` prints synthetic in-memory documents. These are invoked using the local Playwright CLI `run-code --filename`; npm's unit/API suite remains the CI gate. PDF artifacts live under ignored/untracked `output/pdf/`.

Document previews are DOM text nodes, not interpolated HTML. They fetch the selected seller order again through its authenticated no-store API before opening, verify snapshot arithmetic, and remove private preview/print nodes on close/disposal/logout. Public PWA caching includes code/styles only. Browser-saved PDF files are deliberately outside server storage and may contain recipient data in Production; the seller controls local handling.

## Marketplace research boundary

Lazada's official document API describes shipping-label retrieval, a carrier-backed capability distinct from our local packing checklist: https://open.lazada.com/apps/doc/api?path=/order/package/document/get . No claim is made that this app implements that integration. Search did not return inspectable Shopee seller workflow documentation, so no proprietary flow is inferred.

## Release / recovery

Before publishing: run complete npm tests/check/build, inspect only scoped files, verify exact pushed-head CI, record the current Cloudflare deployment ID, deploy to the unchanged `online-shopping` Worker with the existing Demo Durable Object binding, and verify assets/readiness and public browser regressions. If live regression appears, use the existing Wrangler rollback to the recorded prior deployment. No database migration or deletion is part of this milestone.
