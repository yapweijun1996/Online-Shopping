# Opening a new shop (tenant): the end-to-end flow

Status: **R1 core built; browser/edge, operations and production activation remain R2–R4.** See the [release ledger](MULTI_TENANT_LEDGER.md). It describes how a shop A, B, C, D, E is created and kept running from one source code, one Docker deployment and one automatic deploy, with a separate database per shop. Each step says which phase of [MULTI_TENANT_SUPERADMIN_PLAN.md](MULTI_TENANT_SUPERADMIN_PLAN.md) makes it possible and whether that phase exists today. Facts are **[built]** (merged and tested), **[planned]** (phase not built yet) or **[owner]** (a step only the owner can do).

## 0. The picture

- One repository, one image, one set of containers (`backend`, `frontend`, `postgres`, `tunnel`). Merging to `main` builds that one image and the updater deploys it once for every shop. **[built for one shop; P7 makes it cover every shop]**
- Every shop has its own PostgreSQL database and its own database role. A shop's role cannot even connect to another shop's database. **[built, P2]**
- A small platform database holds the SuperAdmin, the list of shops and an append-only audit trail. It holds no catalog, order or customer data, but it does hold, for every shop, the name, currency, seller username, database identifiers and the sealed database password, so the platform database and its backups are sensitive. **[built, P2]**
- Addresses: `shop.gmb01.xyz/<code>/` for buyers and `seller.gmb01.xyz/<code>/` for the shop's seller; the SuperAdmin is at `admin.gmb01.xyz`. The current live site stays at the root as the default shop. **[built: R1–R2; production activation R4]**

## 1. One-time preparation by the owner (before the first new shop)

| # | Step | Needed for | Status |
| --- | --- | --- | --- |
| 1 | Cloudflare: create a dedicated `online-shopping-admin` tunnel and DNS record for `admin.gmb01.xyz`, leaving `deploy/cloudflared.yml` unchanged. Optional: put Cloudflare Access (e-mail one-time code) in front of it | SuperAdmin sign-in | **[executor: R4 activation]** |
| 2 | Create the SuperAdmin secret files on the MacBook Air: initial username, initial password (12+ characters) | first SuperAdmin | **[executor: R4 activation]** |
| 3 | Create the platform database and its roles. Today nothing creates them: `deploy/init-postgres.sh` runs only on a brand-new PostgreSQL volume, which the live installation already has, so P3 must ship an explicit one-time installer step (run by the owner on the MacBook Air) that creates the platform database, its application role and the provisioner login, and writes their password files | SuperAdmin and creating shops | **[executor: R4 setup-platform.py]** |
| 3a | Treat the provisioner login as a **cross-shop privileged credential**. It needs `CREATEDB` and `CREATEROLE`; in PostgreSQL 16 the creator of a role receives administrative rights over it and can grant itself the right to act as that role, so it can in principle read any shop's data. It is therefore kept as its own secret file, mounted only where provisioning runs and used only by the create-shop flow. The longer-term design is to replace it by a narrow privileged database function that creates a shop's role and database and leaves the caller without rights over them | creating shops | **[executor: R4 activation]**, design decision for P4 |
| 4 | Keep the integration master key (already in place); it also seals each shop's database password | shop credentials | **[built]** |
| 5 | Decide the shop limit for this host (recommended 20 until the move to an Ubuntu server) | capacity | **[closed: twenty shops, X12]** |

## 2. Creating shop "acme" (SuperAdmin console)

1. The SuperAdmin signs in at `admin.gmb01.xyz` with password and a TOTP code. The very first sign-in has no TOTP secret yet, so it opens a restricted, password-only enrolment session that can do nothing else: it shows a grouped setup key, account/issuer and an otpauth link, asks for one valid code to confirm it, and only then enables the full session and shows 10 recovery codes once. **[built: R1; activation R4]**
2. **Create shop** form: shop code (3 to 30 lower-case letters and digits, reserved words such as `admin`, `api`, `shop`, `default` refused), shop name, currency (MYR or SGD), seller username, a generated first password. **[built: R1]**
3. The platform, in order, and safe to repeat after a failure: records the shop as `PROVISIONING`; creates the shop's database role and database (connect right revoked from everyone else); applies the latest schema; sets the shop up as a production shop with its currency; creates the single seller as the shop's Owner with "must change password at first sign-in"; marks the shop `ACTIVE`. A failure marks it `FAILED` with a short code, and a retry cleans up what was left. **[built, P2]**
4. The console shows, once: the two addresses and the one-time password. The SuperAdmin passes them to the seller by a private channel. Nothing is stored in plain text. **[built: R1; activation R4]**
5. The platform audit trail records who and when for: `TENANT_CREATE` (start), `TENANT_ACTIVE` or `TENANT_FAILED` (end, with a short code), and `TENANT_CLEANUP` when a retry removes leftovers; never a password. It does not record each inner step (database and role, schema, shop setup, seller), so after a failure the trail shows that provisioning failed, not which step; the short code and the retry cleanup are what recover it. Per-step events are a P4 option. **[built, P2]**

## 3. What the seller does

1. Opens `seller.gmb01.xyz/<code>/`, signs in with the one-time password and must choose a new one. **[built: R1–R2; production activation R4]**
2. Adds categories, products (or imports a CSV), sets company settings. Adds Managers or Staff if wanted; the roles live inside the shop's own database. **[built]**
3. Optional: connects the shop's own WhatsApp Business account (own Meta app and number, the webhook address includes the shop code) and may pick a colour palette, which is a per-browser preference (stored in that browser, not a shop setting). **[connection built; per-shop webhook address P7]**
4. Shares `shop.gmb01.xyz/<code>/` with buyers. Buyers stay guests, order status lookups stay per shop. **[built: R1–R2; production activation R4]**

## 4. Everyday operation

| Task | Who | How | Status |
| --- | --- | --- | --- |
| Ship a new version to all shops | developer | Merge to `main`; CI passes; the updater backs up **every** database, upgrades **every** shop's schema, and only if all succeed switches traffic. If one upgrade fails, the databases already upgraded are restored from that backup before the deployment is declared failed (see section 6). | **[planned: P7]** (today the updater upgrades one database) |
| Reset a seller's password | SuperAdmin | Console: one-time password shown once, seller must change it | **[built: R1; activation R4]** (per-shop script exists) |
| Suspend a shop | SuperAdmin | The shop answers "unavailable" and sends no WhatsApp message; data stays | **[planned: effective only when P4 (the action), P5 (routing returns 503) and P7 (the WhatsApp worker skips suspended shops) are all built]** |
| Rename a shop code | SuperAdmin only | Old code stays as a redirect so printed links and QR codes keep working | **[built: R1; activation R4]** |
| Delete a shop | SuperAdmin | Suspend first; deletion only after 30 days, with a final dump; two-step confirmation | **[built: R1; activation R4]** |
| Back up | automatic | Platform database and every shop database, each verified by a restore into a scratch database | **[planned: P7]** (today one database) |
| See what happened | SuperAdmin | Platform audit trail in the console | **[built: R1; activation R4]** |

## 5. What stays the same for everyone

One code base means every shop gets every feature at the same moment. There is no per-shop code or per-shop version: a shop differs only by its data and settings (name, currency, WhatsApp account, staff). If one shop needs something the others should not have, it is a setting inside that shop's database, not a code branch.

## 6. Limits to accept

- **Upgrades are not atomic across databases.** The backend refuses a shop whose schema version is not the one it expects. While the updater upgrades the shops one by one, the release that is still serving traffic therefore cannot serve a shop that has already been upgraded: that shop is unavailable from its upgrade until traffic switches. If a later shop fails, those already-upgraded shops stay unavailable until they are restored from the pre-deployment backup, which P7 must do automatically (restore every upgraded database, verify, only then report the failure). Keeping the unavailable window short, or letting a release accept the next additive schema version, are P7 design choices.

- One backend process serves all shops: a crash affects all of them. Health checks and automatic restart limit the damage; each shop's errors are handled separately so one broken shop does not stop the others.
- A schema change must be additive and must succeed in every shop's database; after a successful upgrade the previous release cannot roll back (restore the verified backup instead).
- The MacBook Air is already heavily loaded. More shops mean more connections and backup time; the plan limits the host to about 20 shops.
- No SuperAdmin impersonation in the first release: support is done by resetting the password.
- Custom domains per shop, billing and plans, moving a shop to another server are out of scope for now.

## 7. Order of work

P3 SuperAdmin sign-in, P4 create and manage shops, P5 and P6 addresses and front end under `/<code>/`, P7 updater and backups for every shop, P8 security review and drills. P3–P6 are built in R1–R2. Production activation is gated on R3 operations and the R4 rehearsal, review and host prerequisites; the legacy root remains the default shop.
