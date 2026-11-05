# Company tools: isolated implementation

The module exports server-owned descriptors. Importing it registers no tool. With safe MCP v2 enabled, the default constructor registers these three built-ins; explicit `operationTools: []` disables them. The global flag remains off by default and production activation stays blocked. Legacy read grants retain their eight tools and portal APIs retain their contracts.

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

Currency change additionally requires an unchecked first-party human acknowledgment. The engine checks its server-written APPROVE event against operation, tenant, account, client, grant, tool, human, correlation ID and exact approval timestamp. Model acknowledgment/approval flags are rejected. The read registry and first-party acknowledgment UI are integrated and exercised through real Fetch/JSON-RPC and approval routes on both database adapters.

## Revision and commit

Revision hashes the complete company row and exact catalog currency counts under the shared writer lock. This covers portal/setup/reset/import company writes and the existing product-currency conflict predicate. Company updates never overwrite product names/prices; balanced catalog changes preserving currency counts preserve that predicate.

A bounded subquery reads at most 10,001 product rows. Above 10,000, review fails closed. Output is at most two currency groups; revision is not timestamp-only.

Commit rechecks revision and passes only stored normalized after-values to the existing update service. Domain write, approval consumption and audit are atomic. An identical authorized retry returns its saved receipt without reapplying.

Receipt contains only revision, verified changed-field names and currency-change boolean, never text/phone/address values. Common proposal redaction/receipt retention applies. Historical order currency remains an independent snapshot.

## Scope

The worker owns helper extraction, company descriptors/tests, engine currency-evidence validation and this document. Shared read registry and first-party currency UI/policy are separately reviewed. No provider call, production execution, deployment or main publication is included.

## Actual JSON Schema contract

[03-COMPANY-IMPLEMENTED.json](03-COMPANY-IMPLEMENTED.json) contains complete input/output schemas exported from the actual descriptors and registry. Regenerate with `node docs/mcp-v2/export-company-contracts.mjs`; it uses a disposable in-memory store, starts no listener and refuses operation execution. Source exports are `companyReadContract`, `companyReadTool()` and `companyMutationTool()` in `src/mcp/company-tools.js`. Input definitions apply to `tools/call.arguments`; output definitions apply to `result.structuredContent`. The broader proposed JSON bundle remains historical design material.

| Tool | Scope and current role | Contract |
| --- | --- | --- |
| `company.get` | `company.read`, OWNER `settings.write` | `{}` → `{company:{revision,...14 verified fields}}`; snapshot under tenant fence/store lock; metadata-only compatible READ audit. |
| `company.preview_update` | `company.write`, OWNER `settings.write`, HIGH risk | Input wrapper below; immutable 10-minute proposal; same key/same input replays, differing input conflicts. |
| `company.commit_update` | `company.write`, OWNER `settings.write`, HIGH risk | Only operation ID; current revision, one-use approval and currency acknowledgment evidence rechecked; service write and audit atomic. |

The company revision is 64 lowercase hex characters, never a number. Nullable values stay null. Preview arguments:

```json
{
  "input": {
    "expectedRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "changes": { "shippingText": "Synthetic dispatch policy" }
  },
  "idempotencyKey": "synthetic-company-update-0001"
}
```

Preview returns `operationId`, `status`, `previewHash`, `expiresAt`, `replayed` and a first-party `reviewUrl` under `/oauth/operation?operationId=...`. Full before/after is available only through authenticated first-party review, not in a write-only MCP response.

Commit arguments are `{"operationId":"00000000-0000-4000-8000-000000000001"}`. A successful structured result is:

```json
{
  "operationId": "00000000-0000-4000-8000-000000000001",
  "status": "COMMITTED",
  "result": {
    "revision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "changedFields": ["shippingText"],
    "currencyChanged": false
  },
  "replayed": false
}
```

Expired/stale commit returns `{operationId,error:"EXPIRED"}` or `{operationId,error:"STALE_REVISION"}`. Invalid fields and service validation map to JSON-RPC `-32602`; prepare/idempotency/currency conflicts to `-32009`; credential/scope/approval denial uses HTTP 401/403; temporary unavailability/rate limits use HTTP 503/429. Internal schema/audit/storage failure gives `-32603` without acknowledging a mutation.

`test/mcp-company-tools.test.js` covers service parity, auth/scope/role/tenant, schema errors, first-party review, acknowledgment event binding, idempotency, stale portal/catalog state, concurrent portal writes, historical order snapshots and audit rollback on SQLite/PostgreSQL. `test/mcp-company-default-registration.test.js` exercises the actual default constructor, explicit empty override and unchanged legacy tool definitions. The contract snapshot is compared against runtime schemas in the company tests.
