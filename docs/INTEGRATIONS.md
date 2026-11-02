# Integration plan: WhatsApp and Malaysian couriers

**Status: planning only. Nothing here is implemented.** The current design and release plan is [INTEGRATION_DESIGN.md](INTEGRATION_DESIGN.md); this file keeps the earlier options for reference. Vendor capabilities, prices and approval rules below are from general knowledge and were not re-verified against vendor documentation on 2026-10-05; confirm each with the vendor before building. Current product boundary: no automatic outbound messages, courier or tracking integration (see [SPEC.md](SPEC.md)); this plan describes how that boundary could be lifted.

## WhatsApp

### Option A (preferred): WhatsApp Business Platform, Cloud API
- Official Meta API over HTTPS, so it runs from the Cloudflare Worker without a separate server.
- Needs a Meta business account with business verification, a dedicated phone number that is not used in the normal WhatsApp app, and an app with a permanent access token, phone number ID and business account ID.
- Business-initiated messages must use templates approved by Meta (for example order submitted, order confirmed, shipped). Free-form text is allowed only inside the 24-hour window after the buyer replies.
- Messages are billed by category; a payment method is required. Meta provides a free test number limited to a few registered recipients, which is enough for a Demo.
- Inbound replies and delivery status arrive on a webhook that must verify Meta's signature.

Design sketch: secrets in Worker secrets, never in source; a message log table (template, recipient hash or id, status, error, timestamps) to prevent duplicate sends; reuse the existing WhatsApp consent flag and consent timestamp so buyers who did not opt in are never messaged; show buyer replies in the seller order detail only if the owner wants them.

### Option B (on hold): Baileys, QR-linked Node library
Requested for Demo purposes only, then put on hold by the owner. Constraints if it is revived:
- Unofficial and against WhatsApp's terms, with a real risk that the number is banned. Use a disposable test number, never the seller's business number.
- Needs a long-running Node process and persistent session storage, so it cannot run in a Cloudflare Worker; it would be a separate service on the owner's Docker host called through an authenticated internal endpoint.
- In the public Demo, send only fixed templates to the number the visitor enters, rate limited per number and per client, so the page cannot be used to send spam.
- Needs a seller settings page that shows the pairing QR code and the connected or disconnected state.
- [PRODUCTION_ACCEPTANCE.md](PRODUCTION_ACCEPTANCE.md) and the MVP boundaries must be amended to say "Demo only" before this ships.

### Comparison

| | Cloud API | Baileys |
| --- | --- | --- |
| Runs in a Worker | Yes | No |
| Ban risk | None | Yes |
| Proactive messages | Approved templates only | Any text |
| Cost | Per message | Free |
| Setup | Business verification and template approval | Scan a QR code |

### Owner decisions
1. Answered 2026-10-05: the owner has no Meta business account or dedicated number yet, so the code is to be built behind a switch that is off by default.

Still open:
2. Which messages first (suggested: order submitted, order confirmed or rejected, shipped)?
3. Should buyer replies appear in the seller panel, or stay in WhatsApp?

## Couriers (Malaysia)

| Option | Known capability | To verify |
| --- | --- | --- |
| Ninja Van | Public developer API: create orders, label PDF, cancel, status webhooks; needs a shipper account and API credentials; Malaysia supported. | Rates, account onboarding. |
| Shopee Express (SPX) | No public API for independent web shops known; usually used through Shopee's own platform. | Whether SPX opens an API to non-Shopee merchants; ask SPX sales. |
| J&T, Pos Laju, DHL eCommerce, Flash Express | Vary by carrier. | Each carrier's API access. |
| Aggregators (EasyParcel, Delyva, ParcelHub and similar) | One API for several couriers, rate comparison and labels. | Fees and supported couriers. |

Recommendation: integrate one aggregator or Ninja Van first, rather than several carriers.

## Prerequisites in this codebase
1. Order statuses after confirmation, with tracking number and carrier fields (SEL-02).
2. New tables for shipments, tracking events and notification sends, with migrations on both runtimes.
3. Worker secrets for each vendor, and signed webhook endpoints.
4. Demo isolation: the public Demo states that no delivery or outbound contact occurs, so integrations must be simulated or tightly limited there.
5. Recipient name, phone and address would be sent to carriers and to Meta, so the retention and lawful-basis decision DEC-07 (AC-16) must be settled first.

## Suggested sequence
1. SEL-02 fulfilment statuses.
2. INT-02 one courier: create shipment, fetch label, receive status.
3. INT-01 WhatsApp Cloud API with two templates on Meta's test number, then the real number.
