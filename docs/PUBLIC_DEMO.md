# Public fictional Demo

The public demo is a single-store commerce simulation, not a marketplace or a real offer. There are 35 invented products in seven categories. Every product has one original AI-generated image; no generated variants or extra gallery images are seeded. The source manifest maps each SKU to original and published-image hashes. All images were pixel-inspected after a seven-category pilot; they are photorealistic fictional illustrations with no intended trademarks or seller watermarks. This is provenance evidence, not an exclusive-copyright guarantee. Published JPEGs are 640 × 640; zoom does not create extra detail. Original 1254 × 1254 generation outputs remain outside the repository.

## Isolation, seed and reset

- Worker: `SHOP_MODE=public-demo`, `SHOP_DEMO_REVISION=v1` routes to `public-general-demo-v1`. `manual` still routes to `shop`; legacy `demo` still routes to `pet-shop-demo-v1`. Those databases are not deleted, copied or migrated by switching mode.
- Node: use an explicit new empty `DB_PATH` for each isolated local demo. Never point Demo setup/reset at an existing database.
- Setup seeds once inside a transaction, refuses existing unconfigured catalog/categories/orders, and preserves later edits and simulation orders. No customers or orders are seeded initially.
- Reset means choose a new lowercase revision label (`v2`, for example) and a new local database when testing Node. Worker routing opens a new object. No delete/reset endpoint exists. Keep prior revision labels for rollback; changing back restores their existing data.
- The server returns the public Demo namespace. Browser cart/orders/profile/addresses/contact/search/selection/receipt data use revision-scoped keys. Existing legacy keys stay untouched. Initial API failure keeps the retryable boot overlay; no unscoped data is read before namespace resolution. A changed namespace during catalog refresh reloads before reusing stores.

## Privacy and external actions

Public-demo APIs always return no seller contact, including if an authenticated seller edits contact settings. Product Chat therefore cannot open a real contact. Client checkout uses fictional buyer/recipient/address data in Demo mode; server validation independently replaces supplied personal fields and never grants contact permission. Order state still requires the correct opaque access key, and seller actions retain session/CSRF/stale-revision checks. Production/manual behavior is unchanged.

Use synthetic profiles and addresses for testing. Browser-local information is not a public account system: profiles/orders are local to that browser and the revision scope is data separation, not an origin-level security boundary. No payment provider, delivery integration or automatic notification exists. Packing and PDF remain browser-print/manual workflows.

## Audit and remaining historical limits

Before substitution the public storefront reported Demo mode and 35 seed products. Every public detail was fetched read-only: 35 images total, zero extra gallery images, zero variant products. The old seed contained 35 third-party marketplace images/descriptions and a real contact default. Those seed assets/contact default were removed from current source. 195 historical UI evidence/design artifacts were retired because their catalog/privacy provenance was not reliable enough for a public client demonstration; fresh evidence uses this fictional catalog. No real customer/order records were queried during the audit.

Database files, secrets, local evidence and original-generation outputs are not part of the release. Git history retains older source/artifacts; this update does not rewrite history, revoke existing old copies or claim a forensic cleanup of historical commits. Deployment rollback is the previous Worker version and namespace configuration; no migration is required. Prior browser-local/old database records remain private to their original scope.
