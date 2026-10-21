# WhatsApp Cloud: GCP owner checklist

Open https://seller.demoonlineshopping.xyz with an Owner password login → Settings → WhatsApp connection → How to connect. Never paste credentials into chat, Git, screenshots or issues. Integration keys and provider egress are operator prerequisites; this checklist does not deploy or alter them.

## Connect

- [ ] Create a Meta developer app (Business type), add WhatsApp, and follow the dashboard's account-specific registration, verification, access and billing requirements. For Sandbox use a Meta test number and an allowlisted handset you control. Sandbox and Production are separate saved connections, not separate Graph hosts.
- [ ] Create a System User permanent access token with `whatsapp_business_messaging` and `whatsapp_business_management`, assigned to the correct WABA assets. Permanent does not mean immune to revocation.
- [ ] Copy **App Secret** from App settings → Basic. Copy **Phone Number ID** and **WhatsApp Business Account ID** from WhatsApp → API Setup. These are not the phone digits or Business Portfolio ID.
- [ ] Paste the four values into Sandbox and Connect. CONNECTED only proves the token/phone lookup succeeded.
- [ ] Copy the returned Callback URL (default GCP: `https://demoonlineshopping.xyz/api/v1/webhooks/whatsapp`) and generated Verify token using the page's Copy buttons. Paste them into Meta webhook settings, verify the callback, subscribe to `messages`, and subscribe the app to the WABA. Verify token is not App Secret; a successful challenge does not prove signed POST delivery.

## Create templates

Create these exact names as **Utility**, with body variables in the listed order. Meta decides category and approval. Supply fictional sample values when Meta asks for examples.

| Name | Suggested English body |
| --- | --- |
| `order_submitted` | Hello {{1}}, we received your order {{2}}. |
| `order_confirmed` | Hello {{1}}, your order {{2}} is confirmed. |
| `order_rejected` | Hello {{1}}, we cannot accept your order {{2}}. |
| `order_shipped` | Hello {{1}}, your order {{2}} has shipped with {{3}}. Tracking number: {{4}}. |

`{{1}}` = buyer name, `{{2}}` = order number; shipped adds `{{3}}` = carrier and `{{4}}` = tracking number (`-` when empty). Create every language offered to buyers: `en`, `ms`, `zh_CN`, `vi`, `th`, `ja`, `ko`; other buyer locales fall back to English. The readiness matrix conservatively checks all seven supported languages, not a dynamically selected subset.

## Check and exercise

- [ ] Click **Check readiness**. Correct WABA/phone IDs and token asset access on phone FAIL. Subscribe the app on subscription FAIL. Create missing templates or obtain approval on template FAIL. PENDING and REJECTED are not ready. UNKNOWN is unavailable/incomplete evidence, never success; check connectivity, permissions and Meta configuration, then retry.
- [ ] App Secret is proven by the first valid signed, phone-matched webhook since connect/rotate. Send a handset reply or trigger a delivery receipt and check again. Callback verification alone cannot prove it. Rotation clears this proof; replaying an old body does not restore it.
- [ ] With explicit order WhatsApp consent and an owner-controlled recipient, exercise submitted, confirmed, rejected (separate order) and shipped messages. Observe actual handset delivery, panel delivery/read receipts where available, and an inbound reply. Readiness does not prove messaging permission, billing, registration, template body compatibility or handset delivery.
- [ ] Repeat with the intended Production account before contacting buyers. Confirm reply retention/lawful basis. A non-empty subscribed-app list proves some app is subscribed, not that it is the intended app.

## Stop / recover

Disconnect removes local credentials and prevents subsequent claims; an already in-flight send cannot be recalled. Revoke tokens in Meta when required. Unknown send outcomes stay RECONCILE and are never automatically resent; inspect the handset before deciding to resend. Backups retain historical records until expiry.

## Graph evidence and limitations

Inspected 2026-10-21; the implementation deliberately retains existing Graph `v21.0` rather than silently upgrading:

- `GET /{waba-id}/phone_numbers?fields=id,display_phone_number`: **UNVERIFIED** in the current reference. [Meta phone_numbers reference](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/phone_numbers/) currently says Reading is unavailable and documents POST. Retained as requested; unsupported responses fail/produce UNKNOWN, never synthetic success.
- `GET /{waba-id}/subscribed_apps`: [Meta reference](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/subscribed_apps/) confirms GET and a `data` list.
- `GET /{waba-id}/message_templates?fields=name,language,status&limit=100`: [Meta reference](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/) confirms GET, name/language/status response fields and paging. Exact field projection and page-size behavior on v21.0, its current support lifetime, real account access and Meta dashboard labels remain **UNVERIFIED** without a live account. No live Meta request was used for development/tests.

Each GET has a 10-second timeout and 16 KiB cap, refuses redirects and uses bearer authentication only on HTTPS graph.facebook.com. Templates read at most five pages total; off-host paging is refused. If pagination is incomplete, unseen templates are UNKNOWN rather than MISSING. Phone-list pagination is not followed: absence on a partial page is UNKNOWN. Unsupported template states are conservatively treated as not available (MISSING after a complete listing), never APPROVED. Readiness is read-only and is not persisted as a verified connection status.
