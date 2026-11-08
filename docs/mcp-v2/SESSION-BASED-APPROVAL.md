# Seller session based operation approval

Owner decision, 2026-11-08: an already signed-in seller must not re-enter their
password to approve or reject an MCP operation. This supersedes the earlier
per-operation fresh-password requirement. Seller login, OAuth login/consent,
account password changes and recovery keep their existing authentication rules.

The first-party review page contains no operation password input and sends no
password. Approval requires an explicit seller decision bound to its exact
preview, a live authenticated browser session and its one-use review challenge.
Every protected PAGE and full ASSET must still be delivered and acknowledged;
the media acknowledgment and any required currency warning remain unchecked
until the seller explicitly accepts them.

The existing two lifecycle/tenant fences re-read the seller session, CSRF,
account auth version, original live OAuth grant, consent, capability, tenant,
epoch/build, proposal hash and media evidence. Session expiry, logout, account
change, revoked grant, stale revision, altered content, forged CSRF, cross-session
challenge and replay remain denied. Approval records, audit and commit validation
are unchanged. No preview or mere page view changes commerce state.

For first-party client compatibility, an optional legacy `password` property
may be submitted as a string of at most 256 characters. It is ignored and never
used as authority or persisted. New clients omit it. A valid session is mandatory
regardless of whether that compatibility property is present.

Security consequence: a stolen still-valid seller session can authorize an
explicit operation without a separate password step. Secure/HttpOnly/SameSite
cookies, same-origin and CSRF controls, session revocation, exact-content review
and scope/ownership fences remain required. This is the owner-selected policy;
it does not claim a password step-up or protection against seller-origin XSS.

Meaningful regression coverage includes session-only approval, no password DOM
or request field, logout between the two verification fences, cross-session and
expired challenges, missing image ACKs, wrong owner/tenant/scopes, stale product
content, audit failure and concurrent/repeated decisions. Native browser evidence
and production acceptance are recorded separately by the release manager.


The batch review preserves the entire bounded UUID list through a fixed
`reviewOperations` sign-in continuation (one to five distinct UUIDs). It accepts
no external return URL or arbitrary route. A seller may reject the current batch
item before advancing. If an approval request is lost, reload restores pending
items with fresh challenges and unchecked metadata/image acknowledgments; it
never treats saved progress as approval. The existing job ID is reused for the
pending-only approval packet. Exact-image uploads must be viewed and acknowledged
again after recovery. The seller cache version advances with this login-return
change so installed browsers receive the updated app script.
