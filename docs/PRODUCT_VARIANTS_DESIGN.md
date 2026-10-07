# Product + variants (one listing, many variants)

Status: proposal. Not implemented. Needs the updater to apply schema upgrades first (schema.sql is a protected file).

## Goal

A shop shows one product with several variants, like Shopee: one title, description and gallery, and a selector whose
choices each have their own SKU, price, stock and (optionally) photo. Buyers never see SKUs. Sellers manage one row per
product and edit variants inside it.

## Today

Every combination is a full `product` row linked to its siblings by the text column `variant_group`. Shared fields
(name, description, category, translations, gallery) are copied into every row, the seller list shows every row, and
orders, stock holds and carts point at `product.id`.

## Decision: add `listing`, keep the sellable row

Two ways to get there:

1. A new `product_variant` table that takes price, stock and SKU away from `product`, and `order_item.product_id`
   becomes `variant_id`. Cleanest model, but every order, stock-hold, cart and snapshot path changes at once.
2. A new `listing` table that owns the shared fields, while `product` stays the sellable unit (SKU, price, stock,
   active, image, options) and gains `listing_id`. The existing id of each `product` row stays valid as the variant id.

This design takes option 2. Orders, stock holds, buyer carts, idempotency keys and shared links keep working because
`product.id` does not change. A later step can rename `product` to `variant` once nothing else depends on the name.

## Schema 18

```
listing(id, name, description, category, translations_json, gallery_layout_json, active, created_at, updated_at)
product.listing_id TEXT NOT NULL REFERENCES listing(id)     -- every product belongs to exactly one listing
product_gallery_image.product_id -> stays; galleries belong to the listing's primary product (see below)
```

Rules:

- A product with no variants is a listing with one product.
- `listing.name/description/category/translations` are the source of truth. The same columns on `product` stay
  (queries and order snapshots read them) and are rewritten from the listing inside the same transaction whenever the
  listing changes. Nothing else writes them.
- The gallery belongs to the listing. It is stored against the listing's primary product (the oldest product row), and
  every variant of the listing reads it from there. A variant may still have its own main image (colour photo).
- `variant_group` and `variant_label` become derived and are removed in a later schema once nothing reads them.

## Migration (live shape: 35 listings, 86 product rows, 255 duplicated gallery photos)

1. Create `listing`; one listing per distinct `variant_group`, one per product with no group. Copy shared fields from
   the group's primary product (the row whose SKU equals the group name, else the oldest).
2. Set `product.listing_id`.
3. Delete the gallery rows of non-primary variants that are copies of the primary's gallery (same bytes), keep any that differ.
4. Bump the schema version; both the SQLite migration (`src/db.js`) and `schema.sql` + `upgrade.js` are updated and the
   same fixture is migrated in the schema-compatibility tests, including historical orders, snapshots and stock holds.

## API

- `GET /api/v1/products/:id` keeps accepting a product (variant) id and returns the listing with that variant selected.
- Seller list returns listings; each carries `variants[]`. Existing seller product endpoints keep working for a variant id.
- Checkout keeps `productId` (the variant id). A new `variantId` alias is accepted for one release.
- Shopper list: one card per listing (replaces the window-function collapse), with `priceFrom`, `priceTo`.

## Pull requests (in order)

1. Updater applies schema upgrades (and the installed copy is reinstalled once).
2. Schema 18, migration, store logic, backward-compatible API.
3. Buyer UI: no SKU, price range, colour thumbnails.
4. Seller UI: one row per listing, variants edited inside it.

PR 2 must not merge before PR 1 is deployed and verified, otherwise the updater stops at `manual_migration_required`.
Integration tables (planned schema 18 in `INTEGRATION_DESIGN.md`) move to schema 19.

## Not covered

Per-variant photo sets beyond a single main image, bulk price editing, and variant-level translations.
