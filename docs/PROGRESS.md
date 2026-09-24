# Progress

**As of 2026-09-25 (Asia/Singapore).** The new Online Shopping application is a **planned MVP**. The separate `sample/` is a local PWA/API/SQLite prototype. Its functionality and test results do not count toward the new MVP.

## Evidence-based state

The denominator is the **18 independent AC-01–18 acceptance items** in [SPEC.md](SPEC.md). A planned design is not implementation; code without passing applicable checks is not verified; a local result is not released.

| New MVP state | Count | Basis |
| --- | ---: | --- |
| Planned | 18/18 | Requirements and acceptance gates recorded in SPEC, including PWA and seven-language UI. |
| Implemented | 0/18 | No new-app source, runtime entry point, private schema, or UI exists. |
| Verified | 0/18 | No new-app automated, API, or browser check can run. |
| Released | 0/18 | No new-app artifact, deployment, registry/tag/release, or deployed health/version proof exists. |

Documentation milestone **M0: 1/5 milestones verified** after the initial documentation audit and local commit. M1–M4 are planned; this milestone count is separate from the 0/18 product acceptance count. The later desktop/mobile previews and PWA/i18n specifications are design updates, not implementation evidence.

## Verification performed in this pass

| Check | Result and limit |
| --- | --- |
| Repository/rules/history | Inspected README, all first-party docs, source entry points/services, manifest, tests, ignore files, and Git state/history. No repository AGENTS.md, CLAUDE.md, CONTRIBUTING.md, CI/release workflow, or tag was present. Only `.gitattributes` was tracked at audit start; `.gitignore`, README, docs, and `sample/` were untracked user work. |
| KB-MCP | Live status was healthy. Recall returned one related project-focus memory; unrelated results were not treated as repository facts. Current code and explicit local decisions remain authoritative. |
| Prototype tests | `sample/`: `npx --yes node@24 --test` on Node 24.20.0 ran 32 tests: 31 pass, 1 fail. `fulfillment.test.js:25` expects 2 delivery rows across the order but confirmation copies two rows into revision 2, so the unfiltered query sees 4. The later assertion also expects source revision 1 despite current confirmation revision 2; recheck after repairing the test. This is `SAMPLE-01`, not a new-MVP failure. |
| Prototype runtime/API | Started the sample with an in-memory SQLite database: `/health` returned 200 and an unauthenticated `/api/seller/me` returned 401. This does not prove production readiness or new-app behavior. |
| Prototype browser | At 390px width, viewed shop catalog/detail/cart and seller login/products. Cart add feedback appeared; checkout stayed disabled without an address. Observed no horizontal overflow or console warning/error on those visited states. This is a limited sample smoke, not a full checkout/order-review E2E or new-app UI verification. |
| Documentation | Checked 13 first-party Markdown files for relative links, 18 ordered acceptance IDs, the 1,787-character goal prompt, both PNG preview headers/dimensions, and the final documentation diff. These checks verify document consistency, not product behavior. |

## Open decisions, risks, and next work

- **DEC-04:** hosting/database/session persistence and real-data retention/recovery remain unresolved. They affect the first backend implementation and production safety. No irreversible infrastructure choice has been made.
- **DEC-02/DEC-05:** currency, shipping, delivery geography/postcodes, and product image handling remain unresolved. GST calculation is out of MVP scope; buyer and recipient phone support for +60/+65 is recorded. The open choices block final priced-catalog/checkout contract decisions.
- **SAMPLE-01:** one prototype test is stale against revisioned append-only snapshots. No prototype source or test repair is included in this documentation pass.
- PWA install/offline behavior and all seven translations are specified but not implemented or browser-verified.
- No new-app build, CI, browser E2E, migration, secret scan, deployment, release, or rollback verification exists yet. A current sample browser smoke cannot fill those gaps.

**Resume point:** settle the minimal local backend runtime/store/session direction under DEC-04, then build API-01/API-02 and WEB-00 as the first seller setup slice. Resolve DEC-02 before finalizing priced products or checkout. Record implementation, verification, and release evidence per AC row as work proceeds.
