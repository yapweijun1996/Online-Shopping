# Goal

**Status: MVP in local development.** Seller authentication, MYR product management, public catalog/cart, atomic guest checkout, and seller order review now run locally. Release-quality and production gates remain. The local `sample/` is a separate runnable prototype; its features and tests do not count as new-app implementation.

## Outcome

Deliver a small online-shopping application: a seller configures products, a customer submits an order without registering, and the seller reviews that order on a phone or desktop.

## Success criteria

1. A super admin signs in and creates, edits, activates, or deactivates products. Only active products appear at the public shop link.
2. A customer browses and searches products, uses a cart, and submits an order with one or more delivery destinations.
3. Buyer contact and each destination's recipient contact remain separate. Buyer WhatsApp phone is required; email is optional. Neither is verified in the MVP. Buyer and recipient phone inputs support Malaysia (+60) and Singapore (+65).
4. The server returns a unique order number after saving the order. The customer sees a receipt, with a minimal same-browser copy kept when local storage remains available.
5. The seller sees authoritative prices and order snapshots, confirms or rejects submitted orders with an audit record, copies individual contact and address fields, and can manually open an opted-in buyer's WhatsApp chat.
6. The seller panel has a collapsible SVG-icon side bar and an account menu for profile viewing and sign-out.
7. Customer and seller frontends use a documented backend API. The server is the source of truth for products, prices, orders, authorization, and review decisions.
8. Seller setup, customer checkout, and order review pass targeted automated and browser checks before release.
9. Both public and seller web surfaces are installable PWAs with a safe offline shell; offline checkout and seller decisions cannot claim success.
10. Both interfaces support English by default, followed in the selector by Malay, Mandarin, Vietnamese, Thai, Japanese, and Korean.

These outcomes are broken into **18 independent acceptance items** in [SPEC.md](SPEC.md). Track Planned, Implemented, Verified, and Released separately in [PROGRESS.md](PROGRESS.md); a design or sample test is not implementation evidence.

## Not in the MVP

Payment, GST calculation, customer accounts, contact verification, cross-device history recovery, automated messaging, courier integration, shipping automation, and batch CSV/Excel export. Ninja Van import format and integration feasibility remain a later investigation.

## Constraints

- Treat `sample/` as domain reference only. Build a new implementation rather than copying its code or appearance.
- Keep source, identifiers, and technical documentation in English. Explain progress to the owner in Mandarin.
- Keep real personal data, access tokens, credentials, and database files out of the public repository. Read initial super admin credentials from a local, ignored `.env`; production must reject missing or weak development credentials.
- Use MYR prices and no shipping-charge or logistics calculation in the MVP. Collect destination addresses for seller review without a delivery-area promise. Accept bounded base64 product images through the seller API. Optional prior phone/address suggestions stay on the same browser with a clear control.
- Update design, API, tasks, progress, and this goal when decisions or implemented behavior change.
- Resolve the open commerce and hosting/data choices in [TASK.md](TASK.md) before implementing behavior that depends on them.
