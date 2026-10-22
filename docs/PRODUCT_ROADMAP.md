# Product roadmap: from working demo to a commercial WhatsApp-first shop platform

Status date 2026-10-22. Written by the project manager (Claude) for the owner. Decisions marked **[owner]** need an answer; everything else is planned by default.

## 1. Where the product stands

Live on GCP (shop + seller back office + SuperAdmin console, PostgreSQL, CI-gated deploys): guest checkout, server-side prices and stock, order state machine, seller roles, multi-shop platform (up to 20 shops per host, TOTP SuperAdmin), seller MCP connector (read-only: catalog, orders, analytics), Excel/CSV shipping list, WhatsApp Cloud API guide and readiness, WhatsApp linked-device inbox (WhatsApp Web style, unofficial), SuperAdmin seller reset with email template.

Not done or not verified: payments (none), live courier booking (none), real-phone WhatsApp send/receive, Meta Cloud credentials, SaaS billing, self-serve onboarding, monitoring/alerts, automated off-host backups, the legacy OrbStack production (about 20 commits behind).

## 2. Market check (web research 2026-10-22; vendor pages are marketing, treat as indicative)

- Shopify's baseline: online store builder, POS, SEO, abandoned-cart recovery, fraud analysis, discounts, inventory, analytics, multi-currency, 8,000+ apps; Sidekick (AI assistant that creates discounts, segments, automations) and Magic (AI copy) are free to merchants.
- WhatsApp AI commerce agents exist (Wati, Wassenger, Agentify, Kai, eesel): they answer product and order-status questions, recover carts, generate payment links and some create orders; guides advise a human check before anything involving money.
- Meta policy: since 2026-01-15 the WhatsApp Business Solution terms bar general-purpose AI assistants as the product, but AI inside customer service (support, bookings, order tracking, sales) is explicitly allowed. Recheck Meta's current terms before launch.

## 3. WhatsApp AI follow-up and automatic order capture: feasible, with guardrails

Channel rule: AI that talks on its own runs on the official Cloud API only. The unofficial linked-device inbox stays human-operated (an AI sending automatically from an unofficial client raises the ban risk a lot).

Autonomy ladder (the owner picks the level per shop, default level 1):

1. **Suggest**: AI drafts replies and an order draft from the chat; a human presses send/confirm.
2. **Auto-answer**: AI answers product, price, stock, delivery and order-status questions from our own data inside the 24-hour window; hands over to a human on anything else (complaint, refund, unknown, angry tone, high value).
3. **Order capture**: AI collects items, quantities, recipient and address, repeats the summary, and the customer replies YES. The server then creates the order through the existing checkout rules (server-side prices, stock, idempotency); AI numbers are never trusted. The seller confirms it, or it is auto-confirmed under an owner-set amount limit.
4. **Follow-up**: after a quiet period AI sends one approved template (Utility category) and then stops; opt-out is honoured.

Guardrails: tool-calling only against our own APIs, per-shop kill switch, amount and quantity limits, full audit of every AI action, human hand-off always one tap, daily cost cap, PDPA consent and opt-out, no more customer data to the model than the task needs, tests with fictional chats and adversarial prompts.

## 4. Gaps to close before charging money

| Area | Gap | Plan |
|---|---|---|
| Payments | None today | Gateway integration (FPX/DuitNow/cards) with a payment state machine separate from the order status, webhook verification, payment links sent in chat **[owner: gateway account]** |
| Shipping | Manual tracking, Excel export | EasyParcel (or similar) rate and booking API behind the integration boundary; the template from the owner |
| Selling features (Shopify parity, in value order) | Discount codes and promotions, abandoned-cart recovery over WhatsApp, customer order notifications (Cloud templates), low-stock alerts, sales analytics, product reviews, customer accounts, SEO/sitemap, import from Shopee/Lazada/Shopify CSV | Phased, smallest first |
| Compliance | Malaysian SST and e-invoice (MyInvois) readiness, PDPA privacy notice and terms, data export/erasure already exists | Verify requirements with an accountant before launch |
| SaaS | Plans, billing, trial, self-serve shop creation, custom domains, tenant support tools | Subscription billing plus metered AI usage |
| Operations | One small VM, manual releases for protected paths, no alerts, no off-host backups | Uptime monitoring, off-host encrypted backups, capacity plan, release automation for source-only changes |

## 5. Phases (default order, each ends with live verification and an owner hand-over)

1. **AI assist (levels 1-2)** on the Cloud API: conversation store, tool layer, draft-order creation, hand-off, audit, cost cap. Needs an LLM API key **[owner]**.
2. **Payments + courier** (needs gateway and courier accounts **[owner]**).
3. **Growth features**: promotions, abandoned-cart and order notifications, analytics.
4. **Order capture auto-confirm and follow-up (levels 3-4)** after real conversations have been reviewed.
5. **SaaS layer**: plans, billing, onboarding, monitoring, backups, legal pages.

## 6. Questions for the owner

1. Who is the first paying customer (industry, size, country) and the price idea? Default: WhatsApp-heavy SMEs in Malaysia and Singapore, monthly price per shop plus metered AI usage.
2. AI provider and budget: default Claude API with a monthly cap you set. Only you can create the API key.
3. Autonomy default: level 1 for every shop, level 3 only after the owner enables it per shop. Agree?
4. Payment gateway and courier accounts: which do you prefer or already have?
5. Meta Cloud API: do you have a verified Meta business account and a dedicated number for the official channel?
6. Should I also bring the legacy OrbStack production up to date (needs the MacBook Air updater to be available)?
