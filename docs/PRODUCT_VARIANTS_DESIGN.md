# Product + variants (one listing, many variants)

Status: implemented and live. Schema 18 (`listing` table, `product.listing_id`, shared-field sync), schema 19 (shared gallery, data only), the buyer view (no SKU, option price range, in-place option switching, per-colour photo first), the seller view (one row per listing, Variants panel with add and activate/deactivate, shared gallery edited on the main variant, colour photo per variant) and the schema upgrades applied by the updater (`docs/AUTO_DEPLOY.md`).

Known limits: the gallery holder is the oldest variant, so moving the holder out of its group takes the shared gallery with it; a variant's own gallery uploads from before schema 19 that were not byte copies of shared photos stay in the database but are not shown; the Product options page is still where option types and values are defined; the sample colour photos are programmatic recolourings of the sample product photos, not photographs.

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
- The gallery is shared by the listing (schema 19). It is stored against the listing's first variant (the "holder",
  oldest by creation time) and holds uploaded images only, never a variant's main photo, so replacing a colour's photo
  cannot change the shared photos or another colour. A variant shows its own main photo first unless that photo is
  already in the gallery. Only the holder edits the shared gallery; a gallery sent with a variant edit is ignored and
  adding or deleting photos on a variant answers `GALLERY_SHARED`. Shared photos are public while any variant of the
  listing is on sale. The schema 19 upgrade moves the holder's main photo into the gallery as an uploaded copy and
  deletes the per-variant copies of shared photos.
- `listing.code` holds the variant group name, so `variant_group` and `listing` agree; a product with no group has a
  listing with a NULL code. A variant joining a group takes the listing's title, description and category, and a listing
  left without variants is deleted.
- `variant_group` and `variant_label` become derived and are removed in a later schema once nothing reads them.

## Migration (live shape: 35 listings, 86 product rows, 255 duplicated gallery photos)

1. Create `listing`; one listing per distinct `variant_group`, one per product with no group. Copy shared fields from
   the group's primary product (the row whose SKU equals the group name, else the oldest).
2. Set `product.listing_id`.
3. Schema 19 (data only): shared gallery as above.
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
Integration tables (planned schema 18 in `INTEGRATION_DESIGN.md`) move to schema 21.

## Not covered

Per-variant photo sets beyond a single main image, bulk price editing, and variant-level translations.
