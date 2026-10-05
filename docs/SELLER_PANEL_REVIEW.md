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

## Missing, by priority

**P1 - needed before selling for real**
1. Stock quantity and decrement on order (SEL-01). Today the shop can oversell.
2. Fulfilment statuses and tracking number after confirmation (SEL-02).
3. New-order alerts to the seller (SEL-03).
4. Multiple seller accounts, roles, password change and recovery (SEL-04).
5. Data retention and deletion policy for buyer contact and address data (DEC-07, AC-16 blocker).

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

Settle DEC-07 first because it blocks release. Then stock, fulfilment status and order alerts, which let a seller operate. Then multiple accounts, bulk actions and dashboard figures. Integrations in [INTEGRATIONS.md](INTEGRATIONS.md) depend on fulfilment status.
