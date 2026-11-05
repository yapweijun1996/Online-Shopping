# Authorization and human approval

Current status2026-11-05: Phase0 is independently verified at25ec84f and Phase1 company tools at08136e6. Authenticated challenge/password review, explicit scope consent, transactional receipts and matching schema30 migrations are implemented. Safe development opt-in registers three company, four catalog safe-subset and three analytics tools under current scope consent; production activation is rejected. Company changes reuse service validation and require an additional human acknowledgment for currency changes. Actual synthetic snapshot restores and external epoch fencing passed; production multi-instance recovery remains unverified. API.md and10-FINAL-VALIDATION-REPORT.md give current paths, evidence and limits. The original design below is a historical snapshot, not current implementation status.

## Historical design snapshot

Status: **PARTIAL ISOLATED PROTOTYPE**. The baseline provides read-only OAuth. Unregistered local helpers check explicit v2 consent, current scope/role and an operation-specific seller session, password and preview hash; an unregistered review page renders the complete proposal as text. A generic engine has only been exercised with a synthetic adapter. There is no application route, real business adapter, OAuth consent integration or application migration. The pieces do not yet prove a real human saw a real proposal and must not be exposed on their own. The flow below is not complete.

## Trusted inputs

The tenant resolver supplies tenant/store, issuer and resource. Bearer token lookup, `liveGrant`, current account status/auth version, token scope and `roles.can` must be checked inside the same transaction as each operation. The client never chooses its account, tenant, issuer, audience, scope-to-capability mapping or risk. Registry policy supplies them. Resource IDs are looked up only inside the resolved tenant store. Unknown or disabled policies fail closed. The isolated prototype also binds an externally supplied restore epoch and immutable build digest to the proposal: a changed epoch or build denies an old approval. Production provisioning, artifact-digest verification and coordinated instance draining are not implemented.

**PROPOSED:** New read scopes and new write scopes require fresh OAuth consent; existing grants remain unchanged. Write scopes must be disabled by default and individually unchecked on consent. A future grant consent screen must state that the AI vendor may receive seller-entered data, distinguish read and mutation capabilities, and not pretend to be approval of an individual mutation. The existing consent screen describes read-only access; neither the new screen nor an application-level write flag has been implemented.

## Proposed lifecycle

```text
PREPARED -> PENDING_APPROVAL -> APPROVED -> COMMITTED
       \-> CANCELLED          \-> REJECTED | EXPIRED | CANCELLED
                               APPROVED -> EXPIRED | CANCELLED | CONFLICT | FAILED
```

Every transition must be conditional and transactionally serialized; terminal states must never transition back. `PREPARED` is persisted with the immutable normalized proposal and before/after preview; its server-generated ID is not an authorization credential. Expiry must be enforced by the operation path itself, not depend on cleanup. The prototype preview hash covers the immutable envelope and binding, not the mutable lifecycle state or later approval evidence; those are checked separately in the transaction. The unregistered approval helper creates and verifies synthetic approval records, but it is not connected to a real seller route.

1. **Prepare:** authenticate a live token and capability; validate fields using the existing business rules; fetch authoritative before-state and revision; create ID, idempotency key hash, immutable canonical envelope, preview hash, risk and expiry. Use a bounded unique key tied to tenant/account/client. Same-key same-intent retry returns the original authorized result; different intent is a conflict.
2. **Request approval:** transition to PENDING_APPROVAL. The human opens the first-party Seller Portal using its independently known origin, not an AI-rendered approval button or untrusted redirect. The UI loads the server-stored proposal and old/new values; it treats text and images as data and does not let the model insert HTML or modify the proposal.
3. **Human approval:** bind a fresh password-authenticated seller session and per-operation server challenge to the exact operation and digest, after validating same-origin and CSRF. The approver must be active and eligible, have the required current capability, and by default be the account on the grant; high-risk currency changes additionally require OWNER. Verify the seller saw the old and proposed images for replacement. Persist authenticated human identity, session-proof hash, digest, time and short expiry. A client argument `approved:true`, tool response or KB statement is never approval. Decision and proof must be single-use.
4. **Commit:** authorize a still-live access token and original grant/binding again; revalidate account, role, scope, policy, expiry, exact stored hash and approval, resource ownership and current revision and business rules. Use conditional update/returning or equivalent inside the same database transaction as existing business service and audit. Consume approval exactly once; execute only the stored proposal. On any failed check, no business mutation occurs.
5. **Retry:** an authorized replay of a committed identical operation returns its recorded non-sensitive outcome without re-executing. Revocation or tenant mismatch is denied even for replay. Differing content with an existing idempotency key conflicts.

The exact first-party route, challenge lifespan and proof schema are **not yet implemented or validated**. Bind the login challenge to the operation just as the current OAuth consent binds a fresh session; do not copy its authorization-request proof without an explicit new context. The decision endpoint must not accept model-generated approval evidence. Use CSP, `frame-ancestors 'none'`, no-store, output encoding and origin/CSRF validation; avoid approval secrets in URLs and logs.

## Audit and failures

Record human actor, OAuth client, tenant, tool, resource, operation ID, approval identity, outcome, timestamp and correlation ID. Do not record passwords, access/refresh tokens, raw images, contact data or proposal text. Current MCP audit has a fixed tool/event constraint and 90-day policy: adapt compatibly without silently changing the policy. Successful commit and its audit must succeed or roll back together. Denial-audit failure must never become authorization success.

Revoke, account disable, password reset, role downgrade, session invalidation, expiry, stale revision, hash mismatch, cross-tenant access, injected text and concurrent commit must all be tested. A hash proves only byte-level integrity under the selected canonicalization; it does not prove human review, authorization or resource ownership.
