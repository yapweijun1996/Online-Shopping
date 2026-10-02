# Owner-request candidate — 2026-10-02

## Independent review repairs

PR #15 was owner-merged at 2026-10-02 13:10:27 UTC as main `f28c04b1d1655f5002469a98f62c3e65cb73d6bf`; main CI run `37011248501` passed. Its tree matches the original reviewed candidate. Repair branch `codex/owner-review-regressions` starts at that exact merge. Current candidate: **Shop v105 / Seller v81**, not deployed.

Independent review found four bounded regressions, reproduced before repair:

- Reset after assuming a custom fictional Seller removed its membership but retained its principal; subsequent resource/session/Exit requests returned 403. Reset now preserves valid seed identities or selects seeded Alpha for a removed custom identity, retains Seller privileges, rotates CSRF and returns identity fields. Absolute expiry is unchanged.
- An empty shop that first saved SGD could not initialize the MYR Demo catalog. MYR is now established after the empty-store guard, before seeding, in the existing transaction. Injected failure rolls back settings and all seed rows; nonempty-store rejection preserves existing currency/data.
- Seller Edit resubmitted unchanged price/currency, blocking metadata/deactivation of legacy mismatches. It now omits those unchanged money fields. Actual price/currency changes and activation remain rejected by the strict API; order/item/event snapshots are unchanged. List inline deactivation already worked.
- Activation fingerprint missed primary-image removal and opening an order decision without changed input values. Seller fingerprints now include semantic page state and route; a clean-to-dirty transition also defers reload. Explicitly accepted drafts that remain unchanged still allow reload. The original probe proved a reload request, not silent data loss; the existing native unload prompt was a possible fallback.

Code/test commit `b40cc72d274ef00fc0e6bfdc86798d61425eb43d` passed both independent security/API and PWA/source re-reviews with no actionable findings in their assigned paths. Full Node 24 suite: **142/142**, one worker. JavaScript syntax, whitespace checks and non-publishing Worker dry run pass (742 public assets). The first full run was blocked by sandbox loopback listening; the approved local run passed. Independent synthetic probes additionally verify unchanged expiry, seed identity preservation, foreign-company denial, stale-CSRF denial and nonempty-store preservation.

One isolated Chromium session verified custom Seller creation/assumption/reset/resource loading/Exit, with session 200, foreign-company 404, Admin list 403 and privileged Seller API 401 after reset. The real Edit form saved legacy metadata/deactivation with PATCH 200 and omitted unchanged money fields; SGD 900 stayed unchanged. A held waiting-worker fixture verified primary-image removal and opening an empty rejection dialog during activation each defer reload with **zero native unload prompts**. Cancellation retained removal, explicit retry worked, the Customer cart survived activation, caches ended as `os-seller-v83` / `os-shop-v106` with no API URLs, and no page exceptions occurred. These worker-only identities are synthetic: loaded repair shells remain Seller v81 / Shop v105. Shared binaries were reused; no install/GC or unchanged heavy suite was run.

- [Pending primary-image removal retained during activation](assets/repair-pwa-image-deferred.png)
- [New order decision retained during activation](assets/repair-pwa-decision-deferred.png)
- [Legacy metadata/deactivation saved without money changes](assets/repair-legacy-metadata.png)

Read-only deployment verification: public Demo still shows **Shop v103 / Seller v79**; the new version modules, shared update guard and `/demo/` are absent from that release. Cloudflare's latest deployment was `e62c6942-1d8c-4d53-b8e5-85011e0b7a16` at 2026-10-01 20:47:17.737 UTC, running version `c0c8a9d1-69e9-426f-bbc9-535ef78afccb` at 100%. No merge, deployment, production migration, live grant or credential action was performed by this task.

## Original PR #15 scope and evidence

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

The current authorized deliverables are version-labelled draft/cart-safe updates, complete existing Seller galleries, company-currency constraints, accessible palette preview/persistence, a reviewable Admin design and isolated fictional implementation, and reconciliation of the 18 original criteria. AC-16 operations and AC-17 installed-device PWA acceptance are original MVP gates still open. The proposed production PostgreSQL tenant adapter/migration, durable grants, IdP/MFA, RLS and cutover are future architecture work, requiring separate exact review and authorization. Listing those gates is not authorization to execute them. Payment/courier automation remains outside the MVP.
