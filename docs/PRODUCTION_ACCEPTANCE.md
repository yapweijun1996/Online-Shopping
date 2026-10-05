# Production acceptance denominator — 18 items

Reconciled 2026-10-02 against `SPEC.md`, current code/tests and recorded project KB. The denominator remains **18**, not number of features, tests, screenshots or demo deployments. Payment/courier automation stays outside the existing MVP. Owner-merged PR #16 is main `5966ca8626c6c75e8e0ec4e34488a7c47fa29376` (Shop v105 / Seller v81); the public Demo last verified after merge still runs Shop v103 / Seller v79 from the earlier `c1d1f688458eaa371b80f56f847ffbfe43612de2` release. This independent local integration candidate is Shop v105 / Seller v82 and is not deployed. Its synthetic integration ledger/status does not close a production criterion; see [INTEGRATION_FOUNDATION.md](INTEGRATION_FOUNDATION.md).

The historical single-company local baseline records AC-01–15 and AC-18 as verified (16/18). AC-16/17 remain open. **Production released: 0/18**. A running Cloudflare Demo does not satisfy the future Docker/PostgreSQL Production denominator. The present full regression and focused browser results preserve evidence for the candidate changes; they do not re-certify every historical browser journey or the unimplemented production tenant adapter.

The separately local [offline adapter slice](INTEGRATION_ADAPTERS.md) adds credential-free request/response fixtures. Its 168 passing regression tests and independent synthetic review do not change this denominator or certify a provider connection.

The subsequent [trusted-consent and offline signed-ingress slice](INTEGRATION_TRUST_INGRESS.md), based on that adapter checkpoint, has 192 passing regression tests and 50 focused integration tests. It reads existing server order-contact records and tests synthetic revocation, raw Meta signatures, scoped mapping and durable-before-ACK transaction behavior. It adds no production startup route, tenant grant, provider lookup, transport activation or migration. Those local checks also leave the 18-item denominator and production release count unchanged.

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

## Selected B presentation candidate

B is a local Seller v82 / Shop v105 presentation candidate, separately documented in [SELLER_STUDIO_B.md](SELLER_STUDIO_B.md). Its 144 passing local tests and responsive/PWA fixture checks do not change this 18-item Production denominator, establish native-device acceptance, or close live tenancy/operations gates. PR16 main merge5966ca8 was verified; its merge did not activate a deployment.
