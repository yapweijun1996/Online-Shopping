# Seller Team list and account drawers

Implemented from main940c425 for the approved Team redesign. This document describes source behavior; local fixture evidence and actual live acceptance are separate.

## Interface and existing account contract

The Owner-only Team page starts with a member list instead of a permanent Add form. The centered content area is limited to1200px. Add person is the heading action. Username, Role, Status, Last sign-in and Actions are separate desktop columns; small screens use cards. A never-used account says Never signed in. The Owner row is protected and exposes no mutation controls. No current-account badge is inferred from an Owner role.

Username search, Role and Status filters run locally over the existing complete account-list response; the API is not newly paginated or bounded by this change. All members is the default. The result count distinguishes matching from total people. Filters remain after successful operations. A newly created or changed member is highlighted; when filtered out, feedback explains how to clear filters. The existing latest20 account events remain in a secondary Activity disclosure.

Add person, Change role and Reset password use a shared accessible modal as a480px right drawer, full width on small screens. Only Manager/Staff are assignable. Username validation matches the server ASCII regex: first character is a letter/digit, followed by letters/digits/dot/underscore/dash,3–64 characters total. Temporary passwords use12–256 characters, cannot contain the username case-insensitively, and cannot repeat one character throughout. These checks assist the user; backend validation and authorization remain authoritative.

Staff fulfil orders and reply to chats; Managers additionally manage the catalog, decide sales orders and read sales figures. Neither role manages people or company settings. Existing account/session/OAuth business rules remain unchanged: role changes take effect on the next request and revoke OAuth authorizations without ending all browser sessions; deactivation and password reset end the member's sessions and revoke OAuth authorizations; reactivation does not restore previous sessions or grants. Reset passwords require first-sign-in change. No delete, invitation, email, owner recovery or credential persistence feature is added.

## Feedback, drafts and security

Failed writes preserve drawer inputs and show inline errors. Pending mutations disable inputs/actions and have duplicate guards. Successful writes close and clear credential fields, then reload the list. Failed refresh keeps old rows with an explicit stale warning and Retry, separately from the successful mutation message. The page/session identity and request sequence reject detached results. Owner page routing and backend security boundaries remain unchanged.

All drawer close surfaces use the existing draft guard and focus trap. Closing removes the dialog; disposed pages remove credential inputs. Team-owned confirmations use an optional AbortSignal on the shared confirmModal helper: disposal removes the top layer and resolves cancellation false. Existing callers without a signal retain their behavior.

Temporary passwords opt into non-secret revision signatures using data-private-draft and data-private-draft-revision. The shared update guard serializes only this marker/revision for opted-in controls, including when Show password changes the input type to text. Team's own guard identity is a monotonic edit revision, never a password. Ordinary forms retain existing signature behavior. Passwords are not placed in URLs, storage, summaries, account history or status messages.

## Verification and limits

Targeted tests cover account/session rules on SQLite and optional disposable PostgreSQL, private-draft signature redaction, the shared confirmation lifecycle, and real Team browser flows at390/768/1280/1920px under OS light/dark preferences. The current application has no actual dark theme; OS dark compatibility is not dark-theme acceptance. Browser checks cover one Owner, multiple/long usernames, filters/no matches, first-load delays/failures, drawer validation/focus/Escape, duplicate/error/pending writes, role/reset/deactivation/reactivation, hidden creation, stale refresh recovery, locale, navigation/session disposal and existing collapsed-sidebar tooltips. The full root application test suite is intentionally not run for this task.

Screenshots/logs are external artifacts. Fictional disposable browser checks do not establish authenticated production acceptance. The release manager separately verifies deployed identity/public assets and must report any owner-session live checks as verified or unverified. No real production account or password is mutated merely to manufacture evidence.
