# SuperAdmin trusted-device sessions

The platform authenticator confirmation form provides an optional **Trust this device and keep me signed in** checkbox. It starts unchecked so a shared browser is not trusted silently. The period selector defaults to **1 week**, and offers 1 day, 1 week, 1 month (30 days), and 1 year (365 days). The selector is enabled only after explicit opt-in. The same choice applies after a recovery-code sign-in or initial authenticator enrollment.

## API contract

`POST /api/v1/platform/totp/confirm` still requires a valid password-stage session, the exact configured Origin, its CSRF token, and a valid, replay-safe authenticator code or unused recovery code. Optional request fields:

- `trustedDevice`: boolean. Omitted or false preserves the existing 30-minute idle / 4-hour absolute session limits.
- `trustedDeviceDuration`: one of `1d`, `1w`, `1m`, `1y`, only when `trustedDevice` is true. Omitted with true defaults to `1w`. Invalid types or selections are rejected before consuming the second factor.

A trusted session starts its fixed expiry when second-factor confirmation succeeds. It has no inactivity logout before that deadline. Activity never slides or renews the deadline. Each new sign-in rotates the restricted token into a new full-session token. New browsers still require both factors; this feature does not bypass MFA or trust browser storage flags.

The random bearer token exists only in the host-only, Secure, HttpOnly, SameSite=Strict cookie scoped to `/api/v1/platform`. Its Max-Age matches the selected server-side expiry; the database retains only the token hash. No token is put in localStorage or JavaScript-accessible persistent storage. Existing platform session expiry columns represent the fixed trusted deadline; no schema, migration, seller/customer session, deployment or dependency change is required.

## Revocation and risk

Signing out deletes the current session server-side and expires the cookie. Changing the SuperAdmin password revokes other sessions, including other trusted devices, while retaining the current session as before. Host-side admin reset revokes every session. Existing administrator lockout and Origin/CSRF controls still apply. Clearing browser cookies also removes browser access, but does not itself delete the server record; expired records are removed by the existing session creation cleanup.

Trust only a private device. A one-year bearer session increases exposure if the device or browser is compromised; this change does not establish hardware binding, remote device inventory, or fresh second-factor step-up for every administrative action. Select the shortest suitable period and sign out on a lost/shared device. Password changes and recovery-code regeneration continue to require the current password.

## Verification and release boundary

`test/platform-trusted-device.test.js` covers all fixed deadlines, inactivity, opt-out, invalid selections, mandatory MFA, token rotation/hash storage and revocation on logout/password change/reset. `test/platform-trusted-device-api.test.js` exercises the real routes and PostgreSQL-backed authentication with synthetic accounts, including cookie flags, CSRF/Origin, restored access after inactivity and logout. `test/platform-trusted-device-ui.test.js` exercises desktop/mobile Chromium with simulated API responses; it is UI wiring evidence, not a live production login test. Run PostgreSQL tests with a disposable `SHOP_TEST_DATABASE_URL`, and browser tests with `QA_PLAYWRIGHT_MODULE`.

The feature is staged in a separate worktree. Do not describe it as deployed until the reviewed release is authorized and the actual deployed revision and behavior have been checked.
