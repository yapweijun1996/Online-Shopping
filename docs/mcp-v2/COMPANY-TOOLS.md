# Company tools: isolated implementation

The module exports server-owned descriptors. Importing it registers no tool. Production activation stays blocked; the eight existing read tools and portal APIs retain their contracts.

## Verified fields

The target is the current resolved shop's singleton company row. No company/shop/account ID is accepted.

| Fields | Existing service behavior |
| --- | --- |
| `defaultCurrency` | MYR/SGD only; an actual change fails while any product uses another currency. No price or historical order currency conversion. |
| `sellerWhatsAppPhone`, `senderPhone` | Existing MY/SG normalization; null/empty clears. |
| `mobileHideBarsOnScroll` | Boolean only. |
| `availabilityText`, `shippingText`, `returnsText` | Existing newline/trim/1000-character rules; null/empty clears. |
| `senderName`, `senderAddressLine1`, `senderAddressLine2`, `senderCity`, `senderState`, `senderPostcode`, `senderCountry` | Existing sender limits/trim rules; country is uppercase two-letter text or cleared. |

Omitted fields stay unchanged. Unknown fields/IDs, empty changes and invalid values reject. Shared read-only `prepareCompanySettings` contains the existing normalization/currency rules; both portal update and MCP preview reuse it. Preview performs no write.

## Authority and review

Read requires fresh `company.read`; mutation requires `company.write`. Both require current OWNER-only `settings.write`. The registry checks token/grant/tenant/epoch and holds the lifecycle fence before the store transaction. Read output includes the seller's business contact/address data for this explicitly consented OWNER connection.

Every mutation is HIGH risk and uses password-confirmed first-party review, session challenge, exact Origin/CSRF and one-use approval. Stored proposal includes complete normalized before/after, changed field names, currency change flag and fixed warnings. Text stays data.

Currency change additionally requires an unchecked first-party human acknowledgment. The engine checks its server-written APPROVE event against operation, tenant, account, client, grant, tool, human, correlation ID and exact approval timestamp. Model acknowledgment/approval flags are rejected. Shared UI/policy/read-registry integration must pass before acceptance or global registration.

## Revision and commit

Revision hashes the complete company row and exact catalog currency counts under the shared writer lock. This covers portal/setup/reset/import company writes and the existing product-currency conflict predicate. Company updates never overwrite product names/prices; balanced catalog changes preserving currency counts preserve that predicate.

A bounded subquery reads at most 10,001 product rows. Above 10,000, review fails closed. Output is at most two currency groups; revision is not timestamp-only.

Commit rechecks revision and passes only stored normalized after-values to the existing update service. Domain write, approval consumption and audit are atomic. An identical authorized retry returns its saved receipt without reapplying.

Receipt contains only revision, verified changed-field names and currency-change boolean, never text/phone/address values. Common proposal redaction/receipt retention applies. Historical order currency remains an independent snapshot.

## Scope

The worker owns helper extraction, company descriptors/tests, engine currency-evidence validation and this document. Shared read registry and first-party currency UI/policy are separately reviewed. No provider call, production execution, deployment or main publication is included.
