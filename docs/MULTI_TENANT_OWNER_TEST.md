# Multi-tenant owner test

Status: prepared; activation is not complete. Check [MULTI_TENANT_LEDGER.md](MULTI_TENANT_LEDGER.md) and the private host handoff before using the console. Production contains no QA shops or orders.

1. Open the console address recorded in the private handoff. Read the bootstrap password from the host-only file path there. Sign in, add the displayed grouped setup key to your authenticator, and confirm the current six-digit code. Store the ten one-time recovery codes privately, then close and clear the dialog. No capability is granted before the second factor succeeds.
2. Create a real shop with a unique lowercase code (3–30 letters or digits), its name, MYR currency and an Owner username. Keep the one-time seller password and the two shop addresses privately before closing the dialog. The password cannot be shown again; use reset if lost.
3. Open the seller address in another browser context, sign in with that password, and change it when prompted. Confirm that catalog/order actions remain blocked until the password change.
4. In Settings, create active product category `SAMPLES`, label `Sample goods`. In Products, import [tenant-sample-products.csv](tenant-sample-products.csv), review the preview (two creates, zero errors), then commit. The file contains fictional products; adapt prices and stock before offering real products. Remove sample products when finished.
5. On a phone, open the buyer address, add a product and submit a guest order with information you are authorized to use. Check its total and the private order access link. In the seller console confirm the order and check the buyer status updates and stock changes. No payment or live courier integration is implied.
6. In the SuperAdmin shop detail, suspend the shop. Its buyer/seller routes should report unavailable and its worker should skip it. Resume and check both addresses work.
7. Rename the code. Confirm old links redirect permanently to the new path and the existing cart/profile remain with the same shop. The old code cannot be reused.
8. Suspend, request deletion by typing the current code, and check the thirty-day retention date. Cancel deletion and resume. This console action does not drop a database. Host purge is a separate manual operation requiring a verified final backup.
9. Reset the seller password. Keep the new one-time password, check the old session/password no longer works, then complete the forced change again.
10. Inspect the audit trail. In Account, test changing the platform password and replacing recovery codes only when you can retain the new values privately. Use a fresh recovery code for a later sign-in; it must not work twice.
11. Open the original `/shop/` and `/seller/` addresses. Verify their catalog, manifest/install identity and usual seller entry still behave as before.

The host supports at most twenty non-purged shops including the original shop. Schema upgrades have a drained maintenance window; ordinary releases use normal image cutover. A platform outage leaves the original shop and readiness independent. Keep the host and private backups available. Do not submit passwords, setup keys or recovery codes in issue reports.
