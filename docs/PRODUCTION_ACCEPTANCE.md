# Production acceptance denominator — 18 items

Reconciled 2026-10-02 against `SPEC.md`, current code/tests and recorded project KB. The denominator remains **18**, not number of features, tests, screenshots or demo deployments. Payment/courier automation stays outside the existing MVP. PR #15 was owner-merged as main `f28c04b1d1655f5002469a98f62c3e65cb73d6bf`; the public Demo still runs Shop v103 / Seller v79 from the earlier `c1d1f688458eaa371b80f56f847ffbfe43612de2` release. This repair candidate is Shop v105 / Seller v81 and is not deployed.

The historical single-company local baseline records AC-01–15 and AC-18 as verified (16/18). AC-16/17 remain open. **Historical production/tenant acceptance ledger: 0/18; it is not a count of the newly verified deployment checks.** A running Cloudflare Demo does not satisfy the future Docker/PostgreSQL Production denominator. The present full regression and focused browser results preserve evidence for the candidate changes; they do not re-certify every historical browser journey or the unimplemented production tenant adapter.

| Item | Current single-company evidence | Remaining production/tenant gate |
| --- | --- | --- |
| AC-01 credentials/session | Existing config/auth tests; ordinary Seller login; Demo cookie cannot authorize it. | Production secrets/IdP, MFA/grant policy, HTTPS/revocation and exact artifact review. |
| AC-02 seller authorization | Existing authorization/CSRF checks plus negative fictional tenant tests. | Durable company-bound repository, RLS/pool/grant revocation and all private routes independently reviewed. |
| AC-03 product edit/images | Company-inherited readonly currency; all 35 Seller demo details show primary+five gallery photos; no price/snapshot conversion. | Migrate tenant category/SKU/gallery keys; quarantine existing mismatches; owner price review. |
| AC-04 public discovery | Active-only catalog/detail/search/image tests; shared fictional gallery presentation. | Slug-resolved tenant filters for all public images/variants/categories and checkout. |
| AC-05 cart | Storage/failure regression and focused cart reload. | Tenant-specific browser storage/migration; target-device update recovery. |
| AC-06 buyer contact | Current validator accepts WhatsApp or email; consent required when phone supplied; Demo substitutes fiction. | SPEC's older WhatsApp-only wording needs owner reconciliation with email-only implementation; retention policy and deployed validation. |
| AC-07 delivery/history | API permits 1–10 destinations; current guest UI chooses one saved address per order; history tests. | Older multi-destination UI wording needs owner reconciliation; tenant context and deployed contact/privacy checks. |
| AC-08 server price/total | Integer authoritative totals, price-change/mixed-currency/no-GST/no-shipping checks. | Tenant product resolution and concurrent company-currency policy in PostgreSQL. |
| AC-09 atomic snapshots | Transaction/failure tests; new company-currency tests preserve full stored snapshots/events. | Durable production adapter and migration hashes/counts/audit atomicity. |
| AC-10 retry | Same-key replay/conflict/lost-response baseline. | Company-scoped idempotency; cutover/retry proof. |
| AC-11 receipt/history | Server receipt/storage-failure/private lookup negatives. | Tenant-scoped receipt/status tokens and device storage boundary. |
| AC-12 seller review | Queue/detail/search/pagination baseline; fictional Admin/Seller resource views. | Tenant filters for queue/customer/detail/documents/export. |
| AC-13 decisions | Revision concurrency, stale/audit rollback; fictional confirm/reset flow. | Durable authorization/audit/revocation races and deployed checks. |
| AC-14 copy/contact | Existing copy/manual contact path baseline; public Demo exposes no real contact. | Authorized tenant detail and consent/privacy review; no automatic sends. |
| AC-15 usability | Focused gallery/palette/version/demo layouts on Chromium; historic journey evidence. | Complete candidate E2E on intended phone/desktop devices, errors/focus/screen-reader checks. |
| AC-16 operations | Local startup/privacy/rate-limit/data/Worker dry-run tests. Incomplete. | PostgreSQL implementation, independent security review, encrypted off-host restore/RTO/RPO, logs, retention, exact migration/cutover/rollback approval. |
| AC-17 PWA | Separate public caches/scopes; explicit version labels/update controls; dirty/busy/signature guards. Incomplete. | Installed Safari/iPhone/iPad and desktop target install/update/offline/reconnect; exact deployed artifact and private-cache inspection. |
| AC-18 languages | Seven ordered locales/resource parity; focused 320px appearance layouts. | Complete deployed core journeys; fictional Admin prototype currently English and excluded from this proof. |

Owner-recorded business/contractual necessity is context, not a legal conclusion or evidence that backups/retention obligations are satisfied. Historical local counts remain clearly labelled; opening additional tenant acceptance gates cannot raise production completion. Record each deployed criterion against its exact artifact/version before marking Released.


### Deployed single-shop instance, 2026-10-05

The OrbStack/PostgreSQL instance at `shop.gmb01.xyz` and `seller.gmb01.xyz` now has verified HTTPS readiness, isolated Node/database networking, separate customer/seller origins, a restricted application database account, a hash-verified SQLite import, and a restored-backup application smoke test. A fresh-volume initialization test and public browser login/logout check passed. See [current evidence](PROGRESS.md#2026-10-05-single-shop-orbstackpostgresql-deployment) and [operations](ORBSTACK_DEPLOY.md). These establish the listed deployment sub-items; they do not implement tenant isolation, multi-account roles, off-machine disaster recovery or physical-device PWA installation/update, and do not automatically close the full AC-16/17 gates.
