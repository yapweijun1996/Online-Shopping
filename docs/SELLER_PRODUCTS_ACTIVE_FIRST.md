# Seller Products: active-first visibility

The seller Products page starts with **Show inactive products** off. Every list request explicitly sends `includeInactive=false`, which includes listings with at least one active variant. Turning it on sends `includeInactive=true` and includes all listings. This is a read-only visibility filter and does not activate or deactivate products.

The three statistics are shop-wide **listing** counts, independent of search/category/stock filters and pagination. Active means at least one active variant; Inactive means no active variants. These counts are disjoint, so Active + Inactive = Total. A mixed listing remains visible by default and its existing variant status label explains partial availability. Variant actions remain in the editor.

## Server filtering and compatibility

`GET /api/v1/seller/products` accepts:

- `includeInactive=false|true`: explicit active-first/all visibility.
- `search`: case-insensitive name or variant SKU (maximum 100 characters).
- `category`: category label, including inactive categories for historical management.
- `stock=in-stock|out-of-stock|unlimited`: aggregate listing stock. Any unlimited variant makes the listing unlimited; in-stock includes unlimited or a positive total.
- `sort=updated|name|price_asc|price_desc`: stable ordering with an ID tie-breaker; price sorting uses the lowest variant price, including inactive variants.
- Existing bounded `limit` (1–100; default 24) and `offset` (0–10,000).

Responses add `total` for the current filters and `stats: { active, inactive, total }` for the whole catalog. Filtering happens before pagination, and the UI retains the last accepted filters when loading another page or exporting. A failed filter request restores the accepted controls and results. Filter changes clear the bulk selection.

Existing API clients that omit `includeInactive` retain the historical all-listings default. Existing `status=active|inactive` remains supported, including its historical mixed-listing overlap. Do not combine `status` with `includeInactive`. Shopper APIs and authorization are unchanged.

## CSV and actions

The seller page supplies its accepted visibility/search/category/stock/sort to `GET /api/v1/seller/products/export.csv`. The CSV remains one row per variant. It exports variants belonging to matching listings; with `includeInactive=false`, only active variants are exported. Thus searching an inactive SKU in a mixed active listing locates that listing and exports its active variants. With `includeInactive=true`, all variants of matching listings are exported. Legacy direct CSV callers without `includeInactive` keep their variant-level search behavior. The existing export permission, formula escaping and 5,000-variant cap remain enforced.

Deactivating a singleton immediately removes it from the active-first list. A separate visible Undo notice keeps recovery reachable, and the server refresh updates the statistics. Individual and bulk activation/deactivation retain their existing mutation guards.

## Verification

`test/seller-catalog-filter.test.js` covers real seller API composition, legacy compatibility, read-only visibility, shopper isolation, CSV filtering and SQLite/PostgreSQL parity using disposable databases.

`test/seller-catalog-ui-browser.test.js` uses the real loopback app and synthetic data. It covers 390/768/1440 px, keyboard and pointer switch interaction, selection clearing, empty/error recovery, search/export consistency, category/stock/sort, deactivation/Undo and pagination. Set `QA_PLAYWRIGHT_MODULE` to an installed Playwright module and optionally `QA_ARTIFACT_DIR` for screenshots. It tests both OS light and dark preferences; the existing seller palette system provides light palettes and does not implement a separate dark theme.
