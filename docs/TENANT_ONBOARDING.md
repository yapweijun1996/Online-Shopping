# Opening a new shop (tenant): the end-to-end flow

Status: **flow for owner review.** It describes how a shop A, B, C, D, E is created and kept running from one source code, one Docker deployment and one automatic deploy, with a separate database per shop. Each step says which phase of [MULTI_TENANT_SUPERADMIN_PLAN.md](MULTI_TENANT_SUPERADMIN_PLAN.md) makes it possible and whether that phase exists today. Facts are **[built]** (merged and tested), **[planned]** (phase not built yet) or **[owner]** (a step only the owner can do).

## 0. The picture

- One repository, one image, one set of containers (`backend`, `frontend`, `postgres`, `tunnel`). Merging to `main` builds that one image and the updater deploys it once for every shop. **[built for one shop; P7 makes it cover every shop]**
- Every shop has its own PostgreSQL database and its own database role. A shop's role cannot even connect to another shop's database. **[built, P2]**
- A small platform database holds the SuperAdmin, the list of shops and an append-only audit trail. It holds no shop data. **[built, P2]**
- Addresses: `shop.gmb01.xyz/<code>/` for buyers and `seller.gmb01.xyz/<code>/` for the shop's seller; the SuperAdmin is at `admin.gmb01.xyz`. The current live site stays at the root as the default shop. **[planned: P5, P6; SuperAdmin host P3]**

## 1. One-time preparation by the owner (before the first new shop)

| # | Step | Needed for | Status |
| --- | --- | --- | --- |
| 1 | Cloudflare: add a DNS record and a tunnel ingress rule for `admin.gmb01.xyz` (the tunnel file `deploy/cloudflared.yml` is protected, so this is done by hand). Optional: put Cloudflare Access (e-mail one-time code) in front of it | SuperAdmin sign-in | **[owner]** before P3 goes live |
| 2 | Create the SuperAdmin secret files on the MacBook Air: initial username, initial password (12+ characters) | first SuperAdmin | **[owner]** with P3 |
| 3 | Create the platform database password file and the provisioner password file (a role that can create databases and roles, but never reads shop data) | creating shops | **[owner]** with P3 and P4 |
| 4 | Keep the integration master key (already in place); it also seals each shop's database password | shop credentials | **[built]** |
| 5 | Decide the shop limit for this host (recommended 20 until the move to an Ubuntu server) | capacity | **[owner]** |

## 2. Creating shop "acme" (SuperAdmin console)

1. The SuperAdmin signs in at `admin.gmb01.xyz` with password and a TOTP code. First sign-in forces TOTP enrolment and shows 10 recovery codes once. **[planned: P3]**
2. **Create shop** form: shop code (3 to 30 lower-case letters and digits, reserved words such as `admin`, `api`, `shop`, `default` refused), shop name, currency (MYR or SGD), seller username, optional first password (otherwise generated). **[form planned: P4; the creation logic is built, P2]**
3. The platform, in order, and safe to repeat after a failure: records the shop as `PROVISIONING`; creates the shop's database role and database (connect right revoked from everyone else); applies the latest schema; sets the shop up as a production shop with its currency; creates the single seller as the shop's Owner with "must change password at first sign-in"; marks the shop `ACTIVE`. A failure marks it `FAILED` with a short code, and a retry cleans up what was left. **[built, P2]**
4. The console shows, once: the two addresses and the one-time password. The SuperAdmin passes them to the seller by a private channel. Nothing is stored in plain text. **[planned: P4]**
5. Every step is written to the platform audit trail (who, what, which shop, when; never a password). **[built, P2]**

## 3. What the seller does

1. Opens `seller.gmb01.xyz/<code>/`, signs in with the one-time password and must choose a new one. **[forced change built; the address needs P5, P6]**
2. Adds categories, products (or imports a CSV), sets company settings. Adds Managers or Staff if wanted; the roles live inside the shop's own database. **[built]**
3. Optional: connects the shop's own WhatsApp Business account (own Meta app and number, the webhook address includes the shop code) and chooses the shop's palette. **[connection built; per-shop webhook address P7]**
4. Shares `shop.gmb01.xyz/<code>/` with buyers. Buyers stay guests, order status lookups stay per shop. **[planned: P5, P6]**

## 4. Everyday operation

| Task | Who | How | Status |
| --- | --- | --- | --- |
| Ship a new version to all shops | developer | Merge to `main`; CI passes; the updater backs up **every** database, upgrades **every** shop's schema, and only if all succeed switches traffic. One failure keeps every shop on the old version | **[planned: P7]** (today the updater upgrades one database) |
| Reset a seller's password | SuperAdmin | Console: one-time password shown once, seller must change it | **[planned: P4]** (per-shop script exists) |
| Suspend a shop | SuperAdmin | The shop answers "unavailable" and sends no WhatsApp message; data stays | **[planned: P4]** |
| Rename a shop code | SuperAdmin only | Old code stays as a redirect so printed links and QR codes keep working | **[planned: P4]** |
| Delete a shop | SuperAdmin | Suspend first; deletion only after 30 days, with a final dump; two-step confirmation | **[planned: P4]** |
| Back up | automatic | Platform database and every shop database, each verified by a restore into a scratch database | **[planned: P7]** (today one database) |
| See what happened | SuperAdmin | Platform audit trail in the console | **[planned: P4]** |

## 5. What stays the same for everyone

One code base means every shop gets every feature at the same moment. There is no per-shop code or per-shop version: a shop differs only by its data and settings (name, currency, palette, WhatsApp account, staff). If one shop needs something the others should not have, it is a setting inside that shop's database, not a code branch.

## 6. Limits to accept

- One backend process serves all shops: a crash affects all of them. Health checks and automatic restart limit the damage; each shop's errors are handled separately so one broken shop does not stop the others.
- A schema change must be additive and must succeed in every shop's database; after a successful upgrade the previous release cannot roll back (restore the verified backup instead).
- The MacBook Air is already heavily loaded. More shops mean more connections and backup time; the plan limits the host to about 20 shops.
- No SuperAdmin impersonation in the first release: support is done by resetting the password.
- Custom domains per shop, billing and plans, moving a shop to another server are out of scope for now.

## 7. Order of work

P3 SuperAdmin sign-in, P4 create and manage shops, P5 and P6 addresses and front end under `/<code>/`, P7 updater and backups for every shop, P8 security review and drills. Until P5 and P6 are merged, new shops can exist but cannot be opened in a browser; the live site is not affected by any of it.
