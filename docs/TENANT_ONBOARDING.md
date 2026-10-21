# Opening a new shop (tenant): the end-to-end flow

Status: **R1–R4 are built; owner journey, fault, backup/restore and capacity rehearsals passed. Production activated and read-only verified in R4; the executor leaves first TOTP enrolment to the owner.** See the [release ledger](MULTI_TENANT_LEDGER.md). It describes how a shop A, B, C, D, E is created and kept running from one source code, one Docker deployment and one automatic deploy, with a separate database per shop. Each step says which phase of [MULTI_TENANT_SUPERADMIN_PLAN.md](MULTI_TENANT_SUPERADMIN_PLAN.md) makes it possible and whether that phase exists today. Facts are **[built]** (merged and tested), **[planned]** (phase not built yet) or **[owner]** (a step only the owner can do).

## 0. The picture

- One repository, one image, one set of containers (`backend`, `frontend`, `postgres`, `tunnel`, `tunnel-admin`). Merging to `main` builds that one image and the updater deploys it once for every shop. **[built: R3 multi-database operations]**
- Every shop has its own PostgreSQL database and its own database role. A shop's role cannot even connect to another shop's database. **[built, P2]**
- A small platform database holds the SuperAdmin, the list of shops and an append-only audit trail. It holds no catalog, order or customer data, but it does hold, for every shop, the name, currency, seller username, database identifiers and the sealed database password, so the platform database and its backups are sensitive. **[built, P2]**
- Addresses: `shop.gmb01.xyz/<code>/` for buyers and `seller.gmb01.xyz/<code>/` for the shop's seller; the SuperAdmin is at `admin.gmb01.xyz`. The current live site stays at the root as the default shop. **[built: R1–R4]**

## 1. Owner preparation after activation

The executor supplies the three new private password files, platform roles/database, dedicated admin tunnel/DNS and runtime settings through the ordered activation runbook. Existing secrets, the legacy tunnel and business schema remain unchanged. There is no infrastructure setup left for the owner once the ledger records activation passed.

| Step | Needed for | Status |
| --- | --- | --- |
| Read the bootstrap password from the private host handoff path, sign in, enrol an authenticator and privately retain recovery codes | First SuperAdmin access | **[owner: first sign-in; executor leaves TOTP unenrolled]** |

The provisioner credential is accepted as cross-shop privileged (X6): non-superuser CREATEDB/CREATEROLE with PostgreSQL 16 role self-grant. The existing master key seals tenant passwords. The host limit is twenty shops including the default, enforced before reservation. Optional Cloudflare Access and a narrow provisioner function remain future improvements.

## 2. Creating shop "acme" (SuperAdmin console)

1. The SuperAdmin signs in at `admin.gmb01.xyz` with password and a TOTP code. First-time setup has three steps: account created, authenticator setup, and recovery-code saving. The restricted enrolment screen draws a real QR code locally; scan it with an authenticator or expand **Can't scan? Enter this key manually**, copy the grouped key, and choose Time-based, 6 digits, 30 s. Confirm a current code, then copy or download the 10 one-time recovery codes and tick **I have saved these recovery codes** before continuing. QR/key DOM content is cleared when leaving the screen. No QR service or CDN receives the secret.
2. **Add shop** panel: shop code (3 to 30 lower-case letters and digits, reserved words such as `admin`, `api`, `shop`, `default` refused), shop name, currency (MYR or SGD), seller username, a generated first password. Live hints validate the code format; the server checks availability and reserved words.
3. The platform, in order, and safe to repeat after a failure: records the shop as `PROVISIONING`; creates the shop's database role and database (connect right revoked from everyone else); applies the latest schema; sets the shop up as a production shop with its currency; creates the single seller as the shop's Owner with "must change password at first sign-in"; marks the shop `ACTIVE`. A failure marks it `FAILED` with a short code, and a retry cleans up what was left. **[built, P2]**
4. The console shows, once: the two addresses and the one-time password. The SuperAdmin passes them to the seller by a private channel. Nothing is stored in plain text. **[built: R1–R4]**
5. The platform audit trail records who and when for: `TENANT_CREATE` (start), `TENANT_ACTIVE` or `TENANT_FAILED` (end, with a short code), and `TENANT_CLEANUP` when a retry removes leftovers; never a password. It does not record each inner step (database and role, schema, shop setup, seller), so after a failure the trail shows that provisioning failed, not which step; the short code and the retry cleanup are what recover it. Per-step events are a P4 option. **[built, P2]**

## 3. What the seller does

1. Opens `seller.gmb01.xyz/<code>/`, signs in with the one-time password and must choose a new one. **[built: R1–R4]**
2. Adds categories, products (or imports a CSV), sets company settings. Adds Managers or Staff if wanted; the roles live inside the shop's own database. **[built]**
3. Optional: connects the shop's own WhatsApp Business account (own Meta app and number, the webhook address includes the shop code) and may pick a colour palette, which is a per-browser preference (stored in that browser, not a shop setting). **[built: prefixed callback and serial ACTIVE-shop worker]**
4. Shares `shop.gmb01.xyz/<code>/` with buyers. Buyers stay guests, order status lookups stay per shop. **[built: R1–R4]**

## 4. Everyday operation

| Task | Who | How | Status |
| --- | --- | --- | --- |
| Ship a new version to all shops | developer | Merge to `main`; CI passes; the updater backs up **every** database, upgrades **every** shop's schema, and only if all succeed switches traffic. If one upgrade fails, the databases already upgraded are restored from that backup before the deployment is declared failed (see section 6). | **[built: R3; controller installed in R4 step H]** |
| Reset a seller's password | SuperAdmin | Console: one-time password shown once, seller must change it | **[built: R1–R4]** (per-shop script exists) |
| Suspend a shop | SuperAdmin | The shop answers "unavailable" and sends no WhatsApp message; data stays | **[built: console, routing and worker; real suspension/recovery verified]** |
| Rename a shop code | SuperAdmin only | Old code stays as a redirect so printed links and QR codes keep working | **[built: R1–R4]** |
| Delete a shop | SuperAdmin | Suspend first; deletion only after 30 days, with a final dump; two-step confirmation | **[built: R1–R4]** |
| Back up | automatic | Platform database and every shop database, each verified by a restore into a scratch database | **[built: R3]** |
| See what happened | SuperAdmin | Platform audit trail in the console | **[built: R1–R4]** |

## 5. What stays the same for everyone

One code base means every shop gets every feature at the same moment. There is no per-shop code or per-shop version: a shop differs only by its data and settings (name, currency, WhatsApp account, staff). If one shop needs something the others should not have, it is a setting inside that shop's database, not a code branch.

## 6. Limits to accept

- **Upgrades are not atomic across databases.** R3 implements a maintenance window: pause business requests and worker work, drain existing work, take verified backups, then upgrade main, platform and eligible shops serially. On failure every attempted database is restored and verified while traffic stays paused. This prevents losing orders written after the backup. Ordinary releases with matching schemas use normal image cutover. Real-stack restore/failure evidence passed; controller installation is separately verified in R4 step H. Follow the ledger for the release state.

- One backend process serves all shops: a crash affects all of them. Health checks and automatic restart limit the damage; each shop's errors are handled separately so one broken shop does not stop the others.
- A schema change must be additive and must succeed in every eligible shop's database. A failed upgraded cutover restores the verified snapshots before restarting the previous release. A later voluntary application rollback still requires compatible schemas; never downgrade a live database without an operator procedure.
- The MacBook Air is already heavily loaded. More shops mean more connections and backup time; the application enforces twenty shops. R4 records measured connections and host load; this is a bounded rehearsal, not a throughput guarantee.
- No SuperAdmin impersonation in the first release: support is done by resetting the password.
- Custom domains per shop, billing and plans, moving a shop to another server are out of scope for now.

## 7. Order of work

P3 SuperAdmin sign-in, P4 create and manage shops, P5 and P6 addresses and front end under `/<code>/`, P7 updater and backups for every shop, P8 security review and drills. P3–P7 are built in R1–R3; P8 real rehearsals and independent review are complete. Ordered production activation, controller installation, read-only verification and private handoff are complete; the legacy root remains the default shop. See the release ledger for evidence and recorded deviations.

## Local real-server claim rehearsal

Run against a disposable local PostgreSQL 16+ cluster using a superuser:

```sh
SHOP_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/online_shopping_test node scripts/qa-platform-e2e.mjs
```

The dependency-free rehearsal uses the installed `pg` dependency, random database/role names, private temporary secret files, and a child `node src/server.js` process. It exercises claim closure, separate console login, restricted-session denial, TOTP and recovery-code delivery, tenant provisioning, forced seller password changes, catalog and guest orders in both databases, bidirectional isolation, suspend/resume and seller reset. It prints status-only PASS/FAIL evidence and removes its child, databases, roles and secrets in `finally`; interruption with SIGKILL cannot guarantee cleanup. No real providers are configured or called.

File-based database connections accept `DATABASE_PORT` and `PLATFORM_DATABASE_PORT` (1–65535, default 5432); the platform port also applies to its provisioner connection. Deployment defaults remain unchanged.

The API-only rehearsal uses `NODE_ENV=development` because production requires HTTPS. Its scoped cookie jars send the required HTTPS admin Origin over loopback HTTP. For browser review, add `--serve --seed-shops`: the same bootstrap prints a throwaway claim URL, console URL and fixture shop-code prefix, creates three fictional shops, and remains running until Ctrl-C. The loopback-only HTTP development edge translates the exact local admin Origin and removes Secure from local response cookies; the real application keeps its production Origin checks and cookie flags. Claim navigation stays HTTP only for literal loopback targets on the same port. Never expose this QA edge or use real data. Ctrl-C removes the edge, server, fixture databases/roles and secret directory, including additional shops created through this rig's console. The cleanup reads only the rig-owned random platform database and validates each provisioner-derived database/role identifier. SIGKILL still cannot guarantee cleanup.

## Console appearance and browser evidence

The console and claim page reuse the seller's Evergreen Teal design tokens, follow the system light/dark preference, and have labelled forms, password visibility controls, visible keyboard focus, responsive shop cards/status chips, URL copy/open controls, a shop-actions disclosure, one-time credential dialogs, and timestamped activity. The Add shop flow uses a page panel rather than a dialog. Account password/recovery actions and all lifecycle APIs remain available. Shop list/detail responses additionally include server-derived `shopUrl` and `sellerUrl`; default-shop URLs remain `/shop/` and `/seller/`, and renamed shops use the current code.

Local Chrome verification used the real PostgreSQL-backed server. Independent Chrome `BarcodeDetector` decoded the QR pixels and the result equalled the full enrolment URI byte-for-byte. Setup-key/recovery-code clipboard copies, recovery-file download, acknowledgement gating, secret-dialog clearing, shop creation, suspend/resume, sign-out and recovery-code sign-in were exercised. Every captured screen passed automated horizontal-overflow and accessible-name checks at 360 px. This does not establish production deployment, physical-device authenticator compatibility, or a screen-reader audit.

Screenshots are outside the repository under the task's `job-ui/shots/` directory. Each prefix below has `-390-light.png`, `-390-dark.png`, `-1280-light.png`, and `-1280-dark.png` variants:

- `claim`, `claim-error`, `sign-in`, `sign-in-error`
- `authenticator`, `authenticator-manual`, `confirm-authenticator`, `recovery`
- `dashboard`, `shop-actions`, `add-shop`, `add-shop-error`
- `credentials`, `shop-detail`, `activity`, `account`

Additional images: `qr.png`, `dashboard-768-dark.png`, and `review-<prefix>.png` contact sheets. Full-page captures may exceed the viewport height; dimensions above are browser viewport sizes. These images contain only disposable fixture credentials; do not use production enrolment/recovery screenshots as documentation.
