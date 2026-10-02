# Owner-request candidate — 2026-10-02

Base: main `c1d1f688458eaa371b80f56f847ffbfe43612de2` (published Shop v103 / Seller v79). Isolated branch: `codex/owner-pwa-gallery-currency-admin-palettes`. Candidate: **Shop v104 / Seller v80**. No deployment, production migration, live grant/credential, real order/payment/contact/logistics action occurred. Original checkout remains unchanged.

| Owner request | Candidate outcome | Evidence / practical limit |
| --- | --- | --- |
| Version-labelled update | Current loaded version plus target worker version; dirty confirmation; busy and activation-time signature guards. | Real local waiting-worker update fixture on both surfaces; cancellation preserves drafts, delayed Seller write disables update, accepted activation preserves cart. Installed target devices still open. |
| Seller existing gallery | Authenticated product detail/editor shows primary plus five fixed demo images for all 35 seeds; custom stored images retain removal controls. | 35 API details, unchanged database records/primary bytes, desktop/mobile editor browser checks. Fixed fixture images are presentation-only. |
| Company currency | Product currency read-only/inherited; forged currency rejected; conflicting company currency change blocked, including inactive products. | Legacy mismatches permit metadata/deactivation but block price/activation; full historic order/item/event snapshots preserved in tests. No exchange conversion or price relabelling. |
| Admin/multi-company | Separate session-private fictional prototype for companies, access, products, orders and customer viewing; exact two passwordless entry buttons. | No live store injected; cross-company/role/resource negatives, CSRF/origin, expiry/reset/revision/audit rollback/limits and production gates. Customer records read-only; prototype UI English. Durable Production tenancy remains design work. |
| Accessible palettes | Five choices on each surface, scoped previews and Apply, independent persistent preferences. | Token contrast checks, preview does not save, reload/cross-tab preference checks and 14 stable 320px locale layouts. Bounded audit, not accessibility certification. |

## Validation

- Node 24.19.0, one test worker, project suite **138/138**. Existing dependencies and shared Playwright binaries reused; no browser installation or cache garbage collection. No unchanged heavy browser suite run alongside Printform.
- JavaScript syntax and `git diff --check` pass. Worker non-publishing dry run passes with 742 public assets. Runtime dependency audit: zero vulnerabilities. Caddy config validated with an existing local image, no network/host port/persistent writes; existing stacks untouched.
- One Chromium browser session: ordinary fictional Seller login; primary plus all gallery images; readonly currency; scoped palette preview/Apply/reload; Seller/Customer preference independence; seven locales on each surface at 320px; same-browser cart reload; no page exceptions in the completed flows.
- Actual worker fixture: Seller **v80→v81** and Customer **v104→v105**. These worker-only versions are synthetic test identities, not release versions. Cancellation keeps Seller name and Customer profile drafts; delayed product write blocks update; acceptance activates and reloads; cart survives. Remaining caches were `os-seller-v81` and `os-shop-v105`, with zero cached `/api/` URLs. VM tests additionally cover mutation/draft changes during activation and route-independent pending writes.
- Demo browser: Admin adds fictional Gamma company and Seller, enters Beta Seller view, sees only Beta, foreign-company order API returns 404 and existing privileged Seller API returns 401; fictional order confirmation/reset/exit work. Expected HTTP 401/404 console entries came from negative checks; no page exception occurred. The native reset dialog required the CLI to deliver its completion before the next snapshot; subsequent exit confirmed the flow completed.
- Final palette capture waits out finite animation; all 14 narrow locale layouts remain within viewport. An early resize check sampled the drawer transition, then measured stable 320/320; no persistent layout defect found. Wider choice cards and nonshrinking preview buttons keep English preview labels readable. An inherited full contact-number placeholder was removed from source/documentation before publishing evidence.

## Review evidence

All screenshots use disposable fictional data. Owner-supplied Library references were materialized through supported Library transfer and inspected locally; they are excluded from this PR/evidence.

- [Seller primary and gallery](assets/owner-seller-gallery.png)
- [Scoped palette preview](assets/owner-palette-preview.png)
- [Customer mobile choices and version](assets/owner-customer-palettes.png)
- [Fictional Admin company/access view](assets/owner-fictional-admin.png)
- [PWA draft confirmation — synthetic waiting-worker fixture](assets/owner-pwa-draft-fixture.png)

Runnable API/VM tests are tracked in `test/`. Detailed local browser scripts/logs/screenshots remain ignored under `.local/` and `output/playwright/`; they do not ship as public assets. Check CI and review the exact PR head before any publication.

## Release and security gates

[ADMIN_MULTI_COMPANY_DESIGN.md](ADMIN_MULTI_COMPANY_DESIGN.md) is the proposed PostgreSQL tenant design and rollout sequence. [PRODUCTION_ACCEPTANCE.md](PRODUCTION_ACCEPTANCE.md) reconciles all 18 existing criteria: historical local baseline 16/18, Production released **0/18**. Payment/courier automation remains outside that denominator.

Before publishing Demo: independent authorization/security review at exact head, CI, mode/HTTPS/asset/private-cache checks and owner review of the exact release artifact. Older installed clients must finish writes/save drafts before adopting these new guards; this candidate cannot retrofit guards into already cached v103/v79 scripts.

Before Production: implement PostgreSQL and tenant-scoped repositories/composite FKs/RLS/pooled context/browser storage/status/idempotency/documents, prove revocation and all cross-company routes, restore encrypted off-host backups, approve exact migration/grant manifest and rollback, reconcile current contact/delivery acceptance wording, validate retention policy and real HTTPS/installed Safari/iPhone/iPad/desktop target devices. No local test establishes these missing gates.
