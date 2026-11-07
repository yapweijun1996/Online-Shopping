# ChatGPT tool invocation investigation — 2026-11-06

Baseline: `6be1dcc3b5b0775c75aa814c74725d86a5a58bd4`. Dedicated local branch: `codex/oauth-consent-default-all`.

## Reported production evidence

The owner reports 15 unsuccessful read calls across catalog, orders, analytics and company settings, while discovery exposes 32 tools. The reported client error is `INVALID_ARGUMENT` / `McpServerError: Invalid params`. This is owner-provided evidence, not an agent replay of authenticated production calls. A public `/ready` observation returned baseline revision `6be1dcc3b5b0775c75aa814c74725d86a5a58bd4`; readiness does not prove authenticated tools work.

The original raw JSON-RPC request and response, including transport metadata and headers, are not available. No conclusion about database health, successful authorization or this incident's unique root cause is justified from that error alone.

## Verified protocol defect

`src/mcp/protocol.js` previously permitted only `name` and `arguments` in `tools/call` params, while ping/list allowed no params. The published MCP 2025-06-18 Request schema additionally permits `params._meta` with optional `progressToken` and arbitrary metadata keys. A valid call with an object-valued `_meta` failed locally with exactly JSON-RPC `-32602`, `Invalid params`, before tool execution. The pre-fix regression was actually run and failed on `catalog.list`.

Reference: [MCP 2025-06-18 JSONRPCRequest](https://modelcontextprotocol.io/specification/2025-06-18/schema#jsonrpcrequest).

A minimal reproducer (with a synthetic test token and normal MCP headers) is:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"catalog.categories","arguments":{},"_meta":{"progressToken":"synthetic-progress"}}}
```

The metadata belongs beside `arguments`, not inside it. No customer or OAuth secret is required in a diagnostic copy of the request body.

The focused fix validates the metadata container and optional string/finite-number progress token, removes transport metadata before dispatch and leaves the strict business-argument schemas and unknown-param checks intact. Metadata is not approval, account identity, scope authority, business input or audit content. The existing body bounds, credentials, rate limits, protocol version and per-operation fences remain enforced. No progress notifications are promised; the protocol does not require them.

Synthetic regression covers the five originally reported read-tool names with standard metadata, list/ping, malformed metadata, metadata incorrectly nested inside business arguments, unknown tools/params and grant revocation. The fresh full-scope OAuth test additionally calls `company.get` with metadata through the real v2 dispatcher. All fixtures are fictional, with actual SQLite/PostgreSQL adapters.

**Incident attribution remains UNCONFIRMED** until the actual client envelope is compared or the owner successfully retries a deployed candidate. This verified compatibility repair must not be presented as proof that every ChatGPT failure has been fixed.

## Consent selection request

The same owner explicitly requested default selection of all requested scopes. The shared renderer now preselects only validated requested permissions, including read, mutation and cancellation. Deselect/deny remain available and copy states the default. Login and preselection alone create no grant. Explicit consent and existing scope/RBAC enforcement remain required. Existing grants do not expand. Individual operation review acknowledgments are unchanged and still start unchecked; source write flags remain OFF by default.

## Verification and release state

Syntax check passed. Initial focused both-adapter OAuth/protocol regression: 60 passed, 0 failed, 0 skipped, 18172.887901 ms. Dependency audit: 0 vulnerabilities. Full `NODE_ENV=test SHOP_TEST_DATABASE_URL=<task-owned synthetic PostgreSQL16 on loopback59026> npm test` exited0:2049total,2007passed,0failed,0cancelled,42explicit opt-in skips,523767.6588ms. Node24.22.0 on Ubuntu ARM64; synthetic SQLite and task-owned PostgreSQL16. Optional browser/native tests skipped by this run are not passed evidence. Full-suite log: `/home/ai-agent/oauth-consent-metadata-full-suite.log`. Source and tests were unchanged during this run; documentation was completed afterward. These local observations are not deployment evidence. No production mutation, real seller login/token use, customer read or business change was performed in this investigation.

## Rollback

Revert this focused source/test/docs patch. No migration, configuration, dependency or data rewrite is involved. Existing grants remain intact; a revert restores unchecked consent defaults and the metadata incompatibility. Live rollback, if separately released, must still follow the established protected MCP deployment/epoch policy; do not replay a consumed prior release input.
