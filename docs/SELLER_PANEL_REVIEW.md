# Seller panel review (2026-10-05)

Review of the seller modules against what a single-store seller needs to run the shop. This is a planning document: nothing listed under "Missing" is implemented. Task IDs refer to [TASK.md](TASK.md).

## What exists today

| Module | Current behavior |
| --- | --- |
| Sign-in and session | Username and password, 12-hour session, CSRF protection, login rate limit. One shared super-admin account. |
| Dashboard | Pending-order entry point and recent products. |
| Products | Create, edit, activate or deactivate; MYR or SGD price; category; main image plus gallery; variants (group and option); SKU. |
| Orders | All-status list and search; detail; confirm or reject with an audit event; stale-revision protection across tabs; copy buyer and address fields; manual WhatsApp chat when the buyer opted in. |
| Documents | Order summary and confirmed-only packing sheet, printable to A4 PDF in the browser. |
| Settings | Categories, company default currency, seller WhatsApp number, appearance palettes, app updates. In the public Demo: Reset demo data. |

Orders have three statuses only: submitted, confirmed, rejected.

## Update 2026-10-05

Stock (SEL-01), fulfilment statuses (SEL-02) and in-portal new-order alerts (SEL-03) are now implemented locally and documented in [FEATURES.md](FEATURES.md); items 1 to 3 below are done apart from deployment. Orders now have six statuses: submitted, confirmed, rejected, shipped, delivered and cancelled.

## Update 2026-10-09

Done since this review: stock, fulfilment and alerts (SEL-01 to SEL-03), WhatsApp order messages and the Messages page, manual erasure of an order's contact data (SEL-05, item 5 below), dashboard figures, order filters by date, currency and total, and CSV export (items 7 and 8 below, SEL-06), and the audit log page (item 11, orders only). Multiple accounts with roles, password change and a server-side recovery script are done too (item 4, SEL-04; no second factor and no email recovery). Internal order notes, product-edit history and bulk activate/deactivate are also done (SEL-07). Still open: product CSV import/export, shipping fees and promo codes.

## Missing, by priority

**P1 - needed before selling for real**
1. Stock quantity and decrement on order (SEL-01). Today the shop can oversell.
2. Fulfilment statuses and tracking number after confirmation (SEL-02).
3. New-order alerts to the seller (SEL-03).
4. Multiple seller accounts, roles, password change and recovery (SEL-04).
5. Data retention: the owner decided on permanent retention with a manual deletion function (DEC-07, SEL-05); the deletion function is not built yet.

**P2 - daily operations**
6. Bulk product actions and CSV import or export.
7. Order filters by date, amount and currency; CSV export for accounting.
8. Dashboard figures: today's orders, pending count, sales, top products.
9. Shipping fees, discounts and promo codes.
10. Internal order notes and tags.
11. Audit log view; product edits are not recorded today.

**P3 - later**
Payment gateway, courier label APIs beyond the first integration, tax invoices, refunds and returns, review moderation, multi-store marketplace.

## Smaller issues found

- The passwordless Demo login lets any visitor edit the shared Demo store; use Reset demo data or a new `SHOP_DEMO_REVISION` to clear it.
- Product edits (price, availability) have no actor or history.
- A confirmed or rejected order cannot be corrected.
- Product images are stored in the database (512 KB each), which will grow with the catalog.

## Suggested order

Owner decisions on 2026-10-05: build stock, fulfilment status and order alerts first (SEL-01 to SEL-03), then the manual deletion function (SEL-05). Then multiple accounts, bulk actions and dashboard figures. Integrations in [INTEGRATIONS.md](INTEGRATIONS.md) depend on fulfilment status.
