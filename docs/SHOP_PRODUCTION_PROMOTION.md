# Promote an existing live shop without replacing its data

An installation can run the production application while its persisted shop setup
still says `demo`. MCP v2 deliberately requires persisted `production` setup.
`src/shop-promotion-cli.js` is an explicit host-operator configuration repair for an
owner-authorized live shop. It does not approve any commerce operation or issue
OAuth consent. No HTTP endpoint or automatic migration calls it.

## Preconditions

- Confirm the exact host, public/seller origins and default shop database. The
  command targets the configured default database only; do not substitute another
  tenant's credentials. Take current read-only product, order and history evidence.
- Use the existing protected release and backup/restore procedure. Stop all
  application, maintenance, integration and other database writers. Take and
  independently restore-test a complete fresh backup before applying.
- Use the production configuration with explicit `NODE_ENV=production`,
  `SHOP_MODE=manual`, and quick login disabled. The existing schema version must
  match the source; this command never initializes, migrates, seeds or resets it.
- The operator must have explicit authorization for this shop's one-way promotion
  and its exact new name. Keep the private plan and receipt outside the repository,
  in a directory owned by the executing UID with mode `0700`. Files must be `0600`.

## Plan, review, apply

Run the image's `/app/src/shop-promotion-cli.js` using the same existing private
database configuration as the release. Never paste database URLs or passwords
into command arguments, logs, documentation or chat. These examples omit that
private environment injection:

```sh
umask 077
node src/shop-promotion-cli.js plan \
  --expected-mode=demo \
  --expected-name='Demo General Store' \
  --shop-name='Approved Live Store' > /private/promotion/plan.json
```

`expected-name` must be the **stored** `shop_setup.shop_name`, read privately from
the verified target. For legacy demo names, the public API displays
`Preview General Store` even though the stored name is `Demo General Store`.
Do not infer the stored name from public presentation. The plan changes no rows.
Review its exact before/after, database/origin identity hash, schema version and
`planHash`. Supply that hash literally to apply:

```sh
node src/shop-promotion-cli.js apply \
  --plan-file=/private/promotion/plan.json \
  --approve=EXACT_64_CHARACTER_PLAN_HASH \
  --receipt=/private/promotion/receipt.json \
  --backup-reference=VERIFIED_BACKUP_REFERENCE \
  --writers-stopped=yes
```

The backup reference and stopped-writers argument are explicit operator
attestations; the command cannot independently prove a backup or writer stop.
Deployment must verify them separately. Promotion runs one serialized transaction
and a compare-and-set on the expected current mode/name. Its sole database UPDATE
changes `shop_setup.mode` and `shop_setup.shop_name`; no business record, account,
grant, consent, schema or platform registry row changes. The destination name must
contain neither `demo` nor `preview`. Another setup/name or database binding fails
closed; an exact production result returns `replayed: true`.

## Receipt and recovery

The command writes and fsyncs a private `PREPARED` receipt before opening its store,
then atomically replaces it with `APPLIED` after a successful transaction. An
existing receipt is reusable only with the same plan hash and backup reference.
Preserve both plan and receipt as the operator audit evidence; it is not an
`account_event`, order event or MCP business-operation receipt.

If an exception or crash leaves `PREPARED`, the database outcome can be unknown.
Read the verified database setup and retry only the same approved plan and receipt.
If the first commit succeeded, the retry observes its exact destination and does
not repeat the write. A receipt I/O failure is never reported as successful apply.
Do not reset the shop, force the mode with SQL, reuse another plan, or overwrite
evidence to recover.

Afterward resume the matched application with `SHOP_MODE=manual`; verify both
readiness revisions, public setup mode/name, and exact product/order/history
readbacks against the pre-change evidence. Retain the schema and existing OAuth
permissions. Test a legitimate MCP preview through the connected client: current
catalog/media consent, RBAC and first-party per-operation approval remain required.
This configuration repair alone does not deactivate any product. Do not roll the
mode back to demo as a release rollback; retained production data must remain intact.

## Verification status

The isolated service and CLI tests cover both SQLite and PostgreSQL: read-only
planning, exact target/name/hash/schema checks, production/manual/password-login
deployment restrictions, concurrent apply/replay, business/account/OAuth preservation,
failed writes, private journal permission checks and recovery after a synthetic
lost commit acknowledgment. These tests do not establish a production promotion.
