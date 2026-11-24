# Client requirements, November 2026

Source: owner meeting with a prospective client, recorded 2026-11-24. This document turns the request into checkable work. Status values were checked against the repository on 2026-11-24 (`main` at `cc2f617`); anything not confirmed in code or docs is marked **unverified**. Principle from [GOAL.md](GOAL.md): everything is built, deployed and operated by AI agents; a manual-release or human-approval deployment step is a bug to fix.

## Owner decisions (2026-11-24)

| Decision | Choice |
| --- | --- |
| First real client business | Physical-goods shop (services come later) |
| Payments first | Malaysia: DuitNow and Touch 'n Go |
| Tenant site design by AI | Allow AI-written custom HTML (see risk R8 below; safeguards are mandatory) |
| Priority | 1) MCP parity and CSV import first |
| CSV import | One platform standard format exposed through MCP; AI clients map any client file to it; no client-specific parsers |
| Couriers | Generic export first; no courier-native claims without a real template (owner has none) |
| Payments | No merchant account yet; research first, simplest set-up for Singapore and Malaysia; see [PAYMENT_GATEWAY_RESEARCH_MY_SG.md](PAYMENT_GATEWAY_RESEARCH_MY_SG.md) |

## Requirements and current status

| ID | Requirement | Current status (verified from repo) | Gap |
| --- | --- | --- | --- |
| R1 | AI-first: ChatGPT and Claude Code connect through MCP and do back-office work (bulk CSV import of e.g. 1000 SKUs with UOM and types, catalog set-up, data analysis, delivery arrangement) | MCP v2 live: `catalog.*`, `media.*`, `inventory.*`, `orders.*`, `analytics.*`, `company.*` tools with preview/commit and seller approval. CSV import exists in the Seller UI (`src/product-import.js`, SKU-matched update/create) | No MCP tool for CSV import; UOM and product-type handling in import is **unverified**; category creation missing (branch `pi/mcp-category-create-20261124`, unmerged) |
| R2 | Delivery with several couriers (Ninja Van, SPS, NSS, EasyParcel); export the courier CSV, e.g. EasyParcel | Generic shipping-list export (CSV and Excel) and tracking CSV import implemented (`src/order-shipping-export.js`, `src/tracking-import.js`); Ninja webhook exists. [BULK_TRACKING_DESIGN.md](BULK_TRACKING_DESIGN.md): EasyParcel-native template is not proven | Provider-native profiles for EasyParcel, SPS, NSS are **unverified/missing**; no MCP tool for shipping export or tracking import |
| R3 | Backend and MCP have the same capabilities (listing, images, details, ...) | Partial: parity matrix below | Close the gaps in the matrix |
| R4 | Taobao-style product detail page, AI-generated images allowed in details | Rich product detail document v1 exists ([PRODUCT_RICH_DETAIL.md](PRODUCT_RICH_DETAIL.md), `src/product-detail*.js`) | Storefront visual redesign to Taobao-style layout (long image-rich description, gallery, specs, SKU selector) is **unverified/missing**; MCP write path for detail with images is missing |
| R5 | Buyer accounts (email or phone login) and verified-purchase reviews | Guest checkout and optional on-device history only. Customer accounts/OTP listed as deferred ([ROADMAP.md](ROADMAP.md)) | Buyer login, OTP, reviews: not implemented |
| R6 | Service businesses (e.g. cleaning package at 200), order and payment without shipping, AI-drafted emails | Not implemented | Later phase: service package model, booking, no-shipping order flow, email drafting |
| R7 | Malaysia and Singapore payment gateways (DuitNow, Touch 'n Go, PayNow) | Payment is out of scope today ([ROADMAP.md](ROADMAP.md)) | Research aggregators and direct options; no fee or availability claims until verified |
| R8 | Tenant custom domains; brand site plus shop per tenant; templates by business type; AI redesigns pages; festival themes; core shop functions fixed | Multi-shop platform live. Custom domains explicitly out of scope in [MULTI_TENANT_GOAL.md](MULTI_TENANT_GOAL.md) (X21) and [TENANT_ONBOARDING.md](TENANT_ONBOARDING.md); listed as a SaaS candidate in [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md) | Custom-domain routing and TLS, templates, AI design surface, festival themes: not implemented |

## MCP parity matrix (R3)

| Capability | Seller backend | MCP | Gap |
| --- | --- | --- | --- |
| List, get, history, low stock | yes | `catalog.list/get/history/low_stock` | none |
| Create and update product | yes | `catalog.preview/commit_create/update` | none for basic fields; verify variants and options |
| Create category | yes (category codes) | no | branch `pi/mcp-category-create-20261124` |
| Product images | yes | `media.*`; upload needs single-use PUT URL or file bridge | branch `pi/mcp-image-upload-20261124` (fetch by public URL) |
| Rich product detail | yes | not found | MCP read/write for detail document |
| Bulk CSV import and export | yes (UI) | no | MCP import preview/commit |
| Inventory adjust and movements | yes | `inventory.*` | none |
| Orders list, get, decide | yes | `orders.*` | none |
| Shipping export, tracking import | yes (UI) | no | MCP tools |
| Analytics | yes | `analytics.*` | none |
| Company settings | yes | `company.*` | none |

## Feasibility notes (GCP and domains)

- Own domains are feasible on the current GCP VM with Caddy: tenant adds a DNS record to our host, we verify ownership, map hostname to tenant, and issue HTTPS certificates automatically (on-demand TLS with an ask endpoint that only approves verified hostnames). Needs a tenant-domain registry, verification, and rate limits.
- Two surfaces per tenant: a brand/landing site and the shop. Shop-core functions stay platform-owned: product listing, search, filter, cart, checkout, login, payment.
- Festival themes (Chinese New Year, Deepavali, Hari Raya, Black Friday, 11.11) are theme presets over CSS design tokens.

## Risk R8: AI-written custom HTML (owner decision)

The owner chose to allow AI-written custom HTML. Mandatory safeguards before any release (task T5.0 is a gate):

1. Custom HTML only in designated slots; never in listing, search, filter, cart, checkout, login or payment regions.
2. Sanitization or a sandboxed iframe on a separate origin; strict CSP; no third-party scripts by default.
3. Versioned drafts with preview, publish without manual approval, and instant rollback.
4. Audit log of every change and per-tenant isolation.
5. Independent security review (cross-site scripting, clickjacking, credential phishing on tenant domains) before the first tenant uses it.

Existing UI standards still apply: SVG icons only; mobile PWA must not allow zoom.

## Phased tasks (priority order)

See [TASK.md](TASK.md) section "Client requirements, November 2026" for checkboxes. Order: Phase 1 MCP parity and CSV import; Phase 2 Taobao-style detail page and buyer accounts/reviews; Phase 3 courier exports through MCP; Phase 4 Malaysia payments; Phase 5 custom domains and AI site design; Phase 6 services model and email drafting.

## Open questions

- Final wording of the standard import format (UOM and product-type enumerations).
- Real courier templates (EasyParcel, SPS, NSS) once an account exists.
- Payment gateway choice and a sandbox account (owner), then verification of fees and webhooks.
- Whether buyer login uses email, phone OTP, or both first, and the OTP delivery channel.
