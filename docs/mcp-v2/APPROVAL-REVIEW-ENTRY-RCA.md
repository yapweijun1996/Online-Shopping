# Approval review entry investigation

Original investigation baseline: `edf2deae2c40877a5c6b213d4f6fb4d79198e531`.
The owner subsequently authorized commit, merge, push and deployment. The local
candidate is integrated onto `538983b89328efd81e5279a10a8dc8ab5ed66827`, retaining
that release's selection-header UI. Integration changes only cache versions and
their official generated fingerprint; the three reviewed runtime logic files are
byte-identical to the isolated candidate. Local commits preserve the candidate;
independent verification and the actual merge, push and deployment remain pending.

## Confirmed trigger and limits

A paired live read of the same review address returned HTML200 for the plain
`operationId` URL and HTTP400 `invalid_request` after adding
`utm_source=chatgpt.com`. The server and review JavaScript both required exactly
one query parameter. The attribution parameter therefore prevented the public
review shell from opening. The new route regression actually failed before the
repair: expected200, actual400 for the attributed link.

The owner's reported failure of a plain link is not proven to have this same
cause. The paired plain live request returned HTML, and the anonymous browser
showed the sign-in/unavailable state. That is distinct from the attributed URL's
HTTP400. Neither observation proves that the original operation, seller session,
grant or approval was valid at the time of the report.

The shell is deliberately public and contains no proposal. It retrieves the
seller session and proposal through the authenticated seller API. Previously an
anonymous user received a link to Seller Studio, but a successful normal sign-in
did not return to the operation. There was no existing safe general return-URL
mechanism to reuse.

## Minimal repair

Only `GET /oauth/operation` accepts one valid UUID `operationId` and an optional
single `utm_source` containing1–128 ASCII letters, digits, `.`, `_`, `~` or `-`.
The attribution value is neither reflected into the HTML nor passed to APIs,
authority, proposal hashes or consent. Server and browser apply the same closed
query rules. Unknown keys, duplicate parameters, missing/malformed IDs and
malformed attribution remain rejected. Asset and authenticated API query rules
remain unchanged and do not accept attribution.

On session401, the review shell links to the same shop's
`/seller/?reviewOperation=<UUID>`. The seller application accepts that one bounded
identifier only when it is the sole query parameter and has no fragment. After
real sign-in or session restoration it constructs the same shop's fixed
`/oauth/operation?operationId=<UUID>` address. It never accepts a URL, host,
arbitrary return path or another tenant prefix from the query. Temporary-password
replacement must complete first; quick-login sessions do not continue to review.

Unknown, unauthorized, expired, cancelled and committed references show the same
generic unavailable message with instructions to request a new preview. No
proposal is rendered on those failed paths. Sessions, scope/consent checks,
ownership, tenant isolation, Origin/CSRF, fresh password, image/page evidence,
revision checks and commit/replay behavior retain their existing API enforcement.

The integrated cached seller application is version167 and the platform shell is version21.
Their service-worker versions and the official generated shell fingerprint are
updated together; the shop version remains155. No general restyle is included.

## Isolated evidence

The route matrix covers accepted plain/attributed URLs,128/129-character bounds,
unknown/duplicate/malformed queries and unchanged strict asset/API queries on
SQLite and disposable PostgreSQL. Attribution produces byte-identical shell HTML.

Real HTTPS Chromium tests cover default and configured `/alpha` prefixes on both
stores:390px dark preference and1280px light preference. They use real HTTP OAuth
registration, PKCE login/consent/token handlers and a separate initially anonymous
seller browser context. They follow the displayed sign-in link, reject a wrong
password, accept the real fictional seller password, return to the exact review,
and open both plain and attributed authenticated links.

The CREATE cases use a genuine empty BEFORE and zero image assets. PAGE delivery
and one-use acknowledgments still occur; native decode is never called, so this is
not native-codec coverage. Approval requires the initially unchecked full-review
acknowledgment and a fresh password. An unapproved commit is rejected; approved
commit creates exactly one intended product with expected price/stock, and retry
returns a replay receipt without another product. The same genuine OAuth client
independently re-reads the committed product through `catalog.get` (ID, SKU,
active flag, price and stock) and `catalog.list` (one record, complete pagination),
in addition to database assertions. Replaying the exact browser approval POST
with its same session/CSRF/body is rejected403 and leaves the operation APPROVED;
the password-bearing synthetic request body remains only in test memory.

The browser matrix also covers a different Manager account signing in and
replacing its temporary password before being denied the Owner's pending proposal;
actual `operations.cancel`; unknown/committed references; and expiry through an
isolated Node fixture clock advanced past the original unchanged operation expiry,
with real operation controls persisting EXPIRED. It tests expired seller sessions,
mandatory password replacement before continuation, quick-login refusal, and
malicious/duplicate/fragment return inputs. No DOM, cookie or approval-state
injection grants access. Screenshot inspection confirmed readable mobile layout
without horizontal overflow and generic unavailable recovery. The existing review
stylesheet remains light under the dark browser preference; no new theme behavior
is claimed.

Independent final verification: syntax checks passed. Full isolated SQLite and
PostgreSQL16 regression completed with2064 total,2018 passed,0 failed and46
explicit optional skips in424512.481428ms. Skips are not passed evidence. A separate
real HTTPS Chrome run passed5/5 with zero skips in15018.99227ms: the four new
database/prefix cases plus the existing actual review/rejection browser test.
Independent focused route/approval/PWA checks passed23/23, and the final security
review found no blocking issue. The exact repeated approval POST was rejected403;
approved commits were independently read back through the genuine OAuth client's
catalog.get and catalog.list calls.

The candidate is ready for release review (local GO). Production release remains
HOLD under this task's explicit requirement for separate authorization: no commit,
push, merge or deployment was performed. These isolated observations do not prove
a successful seller approval or commit on production, nor establish the unique
cause of the owner's reported plain-link failure. A separately authorized release
must use fresh proposals for live verification rather than expired incident URLs.
