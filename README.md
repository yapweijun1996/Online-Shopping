# Online Shopping MVP

**Status: public Demo available; self-hosted PostgreSQL deployment available at shop.gmb01.xyz and seller.gmb01.xyz. Broader production acceptance remains open.** Seller sign-in/session, MYR/SGD product management, public catalog/cart, guest checkout with one delivery address per order, seller order review, and responsive PWA shells run locally. A two-container Docker Compose stack passed local smoke checks. AC-01–15 and AC-18 are locally verified; PWA installation and production operations remain unfinished, and the Production release remains pending. The local `sample/` prototype is a separate business-rule reference; its code, UI, database, and demo credentials are not the new application.

Self-hosted setup and verification: [OrbStack deployment](docs/ORBSTACK_DEPLOY.md). The legacy local Compose stack below continues to use SQLite.

## Quick start

Requires Node 24.15 or later in the 24.x line.

```sh
cp .env.example .env   # set a unique ADMIN_USERNAME and an ADMIN_PASSWORD of 16+ characters with letters and numbers
npm ci
npm run check && npm test
npm start
```

Open `/shop/` for the customer shop and `/seller/` for the seller portal. `/health` is liveness and `/ready` checks the database schema. Full setup, Docker Compose and the Cloudflare Demo are in the [runbook](docs/RUNBOOK.md). The application is for local development only until the release gates in [PROGRESS.md](docs/PROGRESS.md) are resolved. Do not use commands or credentials from `sample/` for the new application.

## Goal

Make it easy for a seller to set up products, for a customer to shop without registering, and for the seller to review each submitted order on a phone or desktop. Keep the customer and seller web interfaces separate from the server API and private database so UI changes do not silently change order behavior.

## MVP journey

1. A super admin signs in to the seller panel and creates or edits products. Only active products appear at the public shop link.
2. A customer browses products, adds items to a cart, and enters a buyer name and WhatsApp number. Email is optional and unverified. Buyer and recipient phone inputs support Malaysia (+60) and Singapore (+65).
3. The customer selects one saved recipient/address, reviews selected products and the total, and submits without an account or OTP. Separate destinations require separate orders.
4. The server saves the order and returns a unique order number. The page shows a receipt. IndexedDB keeps the cart and a 90-day, browser-local My orders list with product snapshots and a random status credential for each new order; it does not store buyer contact or delivery details in that list. localStorage keeps only the latest minimal receipt for compatibility. My orders refreshes seller decisions through a status-only API when opened or manually refreshed. Earlier orders without a status credential retain their local receipt but cannot securely retrieve later decisions. The server remains authoritative.
5. An authenticated seller reviews the order on a responsive dashboard, then confirms or rejects it. The seller can copy recipient details into a separate shipping system or open the opted-in buyer's WhatsApp chat and send an order-related message manually. Earlier orders without opt-in retain no WhatsApp action.

## MVP boundaries

- No online payment or payment verification workflow.
- No GST calculation in the MVP.
- No customer account, password, OTP, or cross-device order recovery.
- No automatic WhatsApp messages or unofficial WhatsApp Web automation.
- No courier, AWB, tracking, CSV/Excel batch export, or logistics-platform integration. Seller order details support manual copy and paste for now.
- No real customer data, credentials, or database files in the public repository.


## Documentation

**Start here**

- [Runbook](docs/RUNBOOK.md): run locally, with Docker Compose, and as the Cloudflare Demo
- [Current features and behavior](docs/FEATURES.md): what the shop and seller portal do today
- [Deployment and release gates](docs/DEPLOY.md) and [public Demo controls](docs/PUBLIC_DEMO.md)
- [GitHub main automatic deployment](docs/AUTO_DEPLOY.md): CI-gated OrbStack updates, backups and rollback

**Product definition**

- [Goal](docs/GOAL.md), [MVP specification](docs/SPEC.md), and [epics](docs/EPIC.md)
- [Proposed design](docs/DESIGN.md) and [goal prompt](docs/GOAL_PROMPT.md)
- [Draft API contract](docs/API.md)
- [Web UI specification and seller previews](docs/UI_SPEC.md) and [PWA/i18n requirements](docs/PWA_I18N.md)

**Planning and status**

- [Roadmap](docs/ROADMAP.md), [task ledger](docs/TASK.md), and [evidence-based progress](docs/PROGRESS.md)
- [Production acceptance](docs/PRODUCTION_ACCEPTANCE.md), [seller acceptance](docs/SELLER_ACCEPTANCE.md), and [owner request checkpoint](docs/OWNER_REQUEST_CHECKPOINT.md)
- [Multi-company admin design](docs/ADMIN_MULTI_COMPANY_DESIGN.md) and the phased [multi-tenant production plan](docs/MULTI_TENANT_PRODUCTION_PLAN.md)
- [Seller panel review and gaps](docs/SELLER_PANEL_REVIEW.md) and [WhatsApp and courier integration plan](docs/INTEGRATIONS.md)

**UI and QA notes**

- [Shop palettes](docs/SHOP_PALETTES.md), [gallery gestures](docs/GALLERY_GESTURES.md), [portal UI/UX redesign](docs/PORTAL_UI_UX_REDESIGN.md)
- [Shop UX verification](docs/SHOP_UX_VERIFICATION.md) and [seller portal E2E review](docs/SELLER_PORTAL_E2E_REVIEW.md)
