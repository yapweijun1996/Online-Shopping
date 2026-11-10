# Seller Products layout and behavior

Implemented for the approved Products redesign, based on main 83eb4af. This document describes source behavior; production acceptance is recorded separately by the release owner.

## Layout

- Add product aligns with the page title. One status filter group replaces repeated statistics cards and the ambiguous inactive switch: Active, Inactive, All, each with a global listing count.
- Search, category, stock and sort share a wrapping filter bar. Import and Export stay adjacent. Clear filters restores Active and the default ordering. Small screens keep all controls directly reachable; no extra hidden mobile filter panel is needed.
- Product identity, SKU, Price, Inventory, Status and Actions are distinct columns on wide screens. Compact screens use cards. The existing palette system remains intact; the application has no separate dark theme. OS light/dark preference compatibility does not establish dark UI coverage.
- Edit stays visible. More contains Deactivate/Reactivate; deactivation uses the shared keyboard-accessible confirmation modal. Missing and failed images are distinguished, and their entry opens the actual Images editor tab. No image approval workflow is introduced.

## Scope and lifecycle

Tabs partition listings: any active variant makes a listing Active; only fully inactive listings are Inactive. A mixed listing shows its active variant count. Multi-variant changes remain per variant in the editor; grouped listings are not eligible for list bulk activation. See API.md for legacy status compatibility and per-SKU CSV behavior.

Search submits on Enter/Search; changing other filters does not silently submit a draft. Applied filters survive refresh through URL parameters `productSearch`, `productStatus`, `productCategory`, `productStock`, `productSort`. Filtering resets load-more pagination to the first 24 results; later pages retain the same filters. Selection clears on filtering or load-more, and select-all selects only loaded eligible rows. The existing bounded bulk operation remains transactional.

Successful status changes refresh matching results, global counts and ordering. A row leaves Active after deactivation, or Inactive after reactivation; Undo remains outside the disappearing row. Updates do not change price, inventory or historical orders. Failed writes preserve state. A successful write with a failed list refresh explicitly reports saved status plus refresh failure and keeps Retry reachable. Import retains validation/preview/results, with a reminder that current filters can hide imported products. Filtered Export spans all pages and explains one row per eligible SKU; existing limit/error handling remains.

## Verification and limits

`test/seller-catalog-filter.test.js` covers composed filters, legacy compatibility, partitioned tab scopes and export pagination independence; both SQLite and PostgreSQL are exercised when the PostgreSQL fixture URL is supplied. `test/seller-catalog-ui-browser.test.js` uses real disposable application/database fixtures at 390, 768, 1280 and 1920 pixels under both OS color preferences, checks no page overflow or overlapping Edit/More controls, keyboard filter switching, applied/draft search, URL reload, error recovery, export, activation/deactivation/Undo, bulk confirmation and pagination selection.

Screenshots and logs belong in external artifacts, not the source tree. Local fictional browser acceptance is not authenticated live acceptance. The release owner must independently verify the deployed revision and public assets; authenticated live seller operations require a valid owner-controlled session and must not mutate real catalog data merely to manufacture evidence.
