# Goal

**Status: MVP in local development.** Seller authentication, MYR/SGD product management, public catalog/cart, atomic guest checkout, and seller order review now run locally. Release-quality and production gates remain. The local `sample/` is a separate runnable prototype; its features and tests do not count as new-app implementation.

## Outcome

Deliver a small online-shopping application: a seller configures products, a customer submits an order without registering, and the seller reviews that order on a phone or desktop.

## Success criteria

1. A super admin signs in, manages category codes and the default currency, and creates, edits, activates, or deactivates products. Only active products appear at the public shop link.
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
- Keep real personal data, access tokens, credentials, and database files out of the public repository. Read initial super admin credentials from a local, ignored `.env` or server-only secret file; production must reject missing or weak development credentials.
- Use one Docker frontend proxy/PWA container and one private Node API container with a persistent SQLite volume. Keep the backend at one instance and unpublished until a different persistence/rate-limit design is verified.
- The owner requests permanent server retention of submitted orders and their contact/address snapshots. No automatic order purge exists, but lawful basis and durable recovery must be resolved before real-data release. Browser suggestion history remains separately clearable and expires after 90 days.
- Default to MYR while allowing MYR and SGD product prices. A checkout contains one currency, with no conversion, shipping-charge or logistics calculation. Collect destination addresses for seller review without a delivery-area promise. Accept bounded base64 product images through the seller API. Optional prior phone/address suggestions stay on the same browser with a clear control.
- Update design, API, tasks, progress, and this goal when decisions or implemented behavior change.
- Resolve the open HTTPS-host, contact-retention, backup and recovery choices in [TASK.md](TASK.md) before a real-data release.
