# Product options

Sellers describe products with **options they define themselves**: any option type (Colour, Storage, Material, Pack size, in any language) with any values. Nothing is predefined or hard-coded; the only fixed things are the technical limits in `src/option-limits.js`.

## Model
- **Option type** (`option_type`): `code` (stable, generated from the name, unique ignoring case), `name`, optional `translations` (`{ "zh-Hans": "颜色" }`), `display` (`button`, `swatch`, `image`, `dropdown`), `position`, `active`.
- **Option value** (`option_value`): belongs to one type; `code`, `label`, `translations`, optional `swatchColor` (`#rrggbb`), `position`, `active`. Labels are unique within a type ignoring case.
- **Product option** (`product_option`): one value per type for a product. A **product (SKU) remains the unit of price, stock, images, cart line and order line**, so carts, checkout and orders did not change.
- Types and values are never deleted, only deactivated (an inactive value stays on products that already use it but cannot be assigned again).
- **Variant group** (`product.variant_group`) still groups the SKUs of one item. Within a group every product must use the **same set of option types**, each **combination is unique**, and `variant_label` is derived from the chosen values (`Burgundy / 256GB`) so the existing variant list keeps working.
- Existing single-label variants were converted by migration 16→17 into one type called **Option** with a value per distinct label.
- Tenant scope: today there is one tenant per database. When tenants share a database, these tables get the same `company_id` scoping as the rest of the catalogue (see `MULTI_TENANT_PRODUCTION_PLAN.md`); limits then move from constants to tenant settings.

## API (seller, same-origin + CSRF for writes)
- `GET /api/v1/seller/option-types` → `{ items: [type with values] }`
- `POST /api/v1/seller/option-types` `{ name, display?, translations?, position?, code? }`
- `PATCH /api/v1/seller/option-types/{id}` `{ name?, display?, translations?, position?, active? }`
- `POST /api/v1/seller/option-types/{id}/values` `{ label, swatchColor?, translations?, position?, code? }`
- `PATCH /api/v1/seller/option-types/{id}/values/{valueId}` `{ label?, swatchColor?, translations?, position?, active? }`
- Product create/update accept `options: [{ typeId, valueId }]` (with `variantGroup`); `options: []` clears them. Product detail (public and seller) returns `options`, `variants[].options` and `optionTypes` (the types and values in use by the group, in display order).

## Phases
1. Data model, API, migration (this change). 2. Storefront selector (one row per type, price/image/stock follow the chosen combination). 3. Seller editor (types and values, generate all combinations in a table). 4. Polish: availability states, accessibility, copy, tests.
