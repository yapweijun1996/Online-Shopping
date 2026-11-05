# Implemented operation controls

The three tools are available through the default registry only when the existing
isolated MCP v2 configuration is enabled. The default flag and production rejection
are unchanged. An explicit empty registry still disables them; legacy grants still
list the original eight tools. Actual closed argument/output schemas are exported
from `src/mcp/operation-control-contracts.js` into
[03-OPERATIONS-IMPLEMENTED.json](03-OPERATIONS-IMPLEMENTED.json) by
`node docs/mcp-v2/export-operation-control-contracts.mjs`.

| Tool | Additional explicit scope | Result |
| --- | --- | --- |
| `operations.get` | `operations.read` | Status, fixed resource binding, risk, timestamps, redaction/expiry/receipt-presence flags and an inventory reason code when applicable. |
| `operations.audit` | `operations.read` | At most50 metadata events, stable cursor and explicit coverage. |
| `operations.cancel` | `operations.cancel` | Operation ID, resulting status and replay flag. |

Every call also verifies the original operation's complete source-owned domain
scope set, independent consent evidence, current domain capability, original grant,
account, client, tenant revision, issuer/resource, external epoch and build digest.
Consent must exist no later than operation creation and token issuance. A new grant
cannot access an old grant's operation. Owner/Manager eligibility to request these
scopes grants no domain rights: a Manager can control an authorized order operation
but cannot control an Owner-only company operation. Reserved catalog-media flows
remain rejected. Scope strings, model-supplied identity and `can(null)` are never
authority. Unknown IDs and invalid bindings fail closed.

## Metadata and paging

`operations.get` takes `{"operationId":"<UUID>"}`. It never returns an envelope,
proposal, image, receipt body, contact, note or tracking value. Inventory adjustment
reason is read from the authoritative movement with the same product, operation,
actor, client, grant and correlation IDs; private notes are not copied.

`operations.audit` takes the operation ID plus optional `limit` (1–50, default25)
and `cursor`. Keep the same limit on later pages. One SELECT captures both lifecycle
and typed MCP insertion sequence anchors. Pages use timestamp/source/sequence
ordering, exclude later insertions and restrict records to the90-day window as of
the first page. The canonical cursor is HMAC protected using the raw external epoch
with a fixed domain separator. It binds all original identities, tenant revision,
issuer/resource, build, operation, anchors, limit, position and15-minute expiry.
Each page repeats current authorization. Retention can remove rows between pages;
the cursor is not an immutable backup and does not prolong retention.

Coverage comprises retained lifecycle proofs and operation-linked typed MCP READ
and CALL records. Historical RPCs without an operation link and pre-operation
upload stages are excluded explicitly. Historical lifecycle `COMMIT` keeps its
preview-tool label; the separate typed CALL records the actual commit-tool name
and `COMMITTED` or `REPLAY`. Unknown historical outcome labels become
`HISTORICAL_UNCLASSIFIED`, never free text. Actor IDs and human approver IDs are
metadata; account names are excluded. A read audits itself after collecting its
page, so that new record is outside that page's anchors.

## Cancellation and atomic audit

Cancellation is an explicitly consented low-risk abort. It needs no new approval,
does not undo committed commerce and accepts only a server-owned operation ID.
Inside the same platform-first writer transaction, a nonterminal operation is
compare-and-set to `CANCELLED`, existing approval/challenge proof is consumed, and
fixed logical CANCEL plus typed CALL records are written. An authorized repeated
cancel returns minimal `CANCELLED` metadata. Other terminal states return RPC
`-32009`; an expired nonterminal operation uses the shared expiry transition and
returns `EXPIRED`. Approval and commit recheck state, so cancellation cannot race
into a second commerce application. No proposal TTL, stage lease or receipt horizon
is extended.

All new ordinary reads write typed READ metadata with the actual tool/resource and
verified actor/client/grant/tenant. Engine prepare, commit and authorized replay
write typed CALL in the same writer transaction. An initial commit audit failure
rolls back the domain write and approval consumption. A replay audit failure returns
an error while preserving the original COMMITTED receipt and never reapplies it.
No raw arguments or domain notes enter MCP audit. `duration_ms=0` means unmeasured;
it is not a latency claim. Invalid requests/denials before a durable operation are
not represented as a complete operation-linked invocation history.

Upload begin/append/discard and their authorized retries also write typed CALL
inside the existing coordinator writer transaction, using fixed `STAGE_*` outcomes,
the server stage correlation ID and product/actor/client/grant bindings. Their
operation link stays null, so they remain outside `operations.audit`; existing
media-event proofs are retained. Audit failure rolls back stage/quota/chunk/proof
changes, while the already committed rate reservation remains charged.

## Retention, errors and rollback

Both audit sources retain90days. Trusted maintenance removes at most100 rows and
1MiB of conservative source bytes per transaction; oversized legacy audit rows
block that batch for explicit repair. SQL measures legacy text without fetching
it into Node. Cleanup is tenant scoped, transactional and independent of whether
new tools are enabled. Receipt/grant expiry and redaction rules are unchanged;
even a retained or purged receipt cannot revive an expired grant.

Unknown fields/malformed IDs/cursors use RPC `-32602`. Invalid bearer credentials
use HTTP401; missing scope/consent/current capability or ownership uses HTTP403.
Terminal cancellation conflicts use `-32009`. Invalid audit metadata fails closed
with HTTP503. Audit insertion failure returns internal RPC error without exposing
details. SQLite and PostgreSQL use the same contract and writer ordering.

Schema34 has an explicit transactional migration and strict source fingerprints;
see [AUDIT-STORAGE.md](AUDIT-STORAGE.md). There is no in-place downgrade. Isolated
rollback requires restoring a compatible backup and rotating the externally owned
epoch before re-enablement; disabling v2 denies new calls without deleting evidence.
No production activation, restore, scheduler or infrastructure change is performed
by this implementation.

`test/mcp-operation-controls.test.js` exercises actual OAuth consent/default RPC,
the12-case authority matrix for all three controls on both databases, dynamic
company/Manager permissions, cursors, cancellation races, audit-failure rollback,
redacted replay, original-grant expiry and byte/row-bounded cleanup. Separate central
authority tests cover media markers and each underlying consent. Synthetic media
fixtures do not claim actual native decoding or human image-review proof.
