# Payment gateway research: Malaysia and Singapore

Research date: 2026-11-24. Owner decision: no merchant account exists yet; research first, prefer the simplest set-up that covers Singapore and Malaysia; the owner picks after review. Status: **research only, nothing integrated**.

**Source quality warning.** Most comparisons found were published by competing vendors (HitPay, Airwallex). Treat claims about coverage and fees as **unverified** until confirmed on each provider's official documentation and pricing page, or in a sandbox account. Fees quoted differ between pages (for example DuitNow QR 1.2% on HitPay marketing pages versus 2.3% on its global pricing table, possibly domestic versus cross-border); do not rely on them.

## Coverage as reported (unverified)

| Provider | Singapore PayNow | Malaysia DuitNow QR | Touch 'n Go eWallet | FPX | Notes |
| --- | --- | --- | --- | --- | --- |
| HitPay | Reported yes | Reported yes | Reported yes (auto-enabled for verified merchants) | Reported yes | One API for SG and MY; hosted checkout; payment request endpoint `POST /v1/payment-requests`; reported no monthly fee; reported approval 1 to 3 business days; MAS-licensed per its own site |
| Stripe | PayNow reported for SG (verify) | Reported not natively supported in Malaysia | Conflicting: competitor pages say no; one Stripe page lists it (verify) | Reported yes | Strong API and docs; Malaysian local wallet coverage narrower |
| Airwallex | Verify | Reported yes | Reported yes | Reported yes | Competitor pages are its own marketing |
| Billplz, iPay88, Fiuu, Xendit, SenangPay, eGHL | Verify | Mostly Malaysia-focused | Varies | Varies | Not reviewed in depth |

## Recommendation for the owner to confirm

Start with **HitPay** as the first adapter: one integration reportedly covers both markets (PayNow for Singapore; DuitNow QR, Touch 'n Go and FPX for Malaysia) with hosted checkout, so the shop does not handle card or wallet data. Keep the adapter behind `src/integration-*.js` so a second gateway (Stripe or a Malaysian provider) can be added per tenant later.

## Design requirements for any gateway

- Payment is server-confirmed: order is marked paid only from a verified webhook (signature check, replay protection), never from the browser return URL.
- Per-tenant merchant credentials stored with the existing secret handling; tenants bring their own gateway account unless the owner decides on a platform-level account.
- Idempotent payment-request creation per order; amount and currency always from server-side prices; refunds and partial refunds are a later phase.
- Sandbox first: obtain a sandbox account, record real webhook payloads, then implement.

## Open items

- Owner to open a sandbox or merchant account (or approve a test account) so signatures, fees and activation can be verified.
- Confirm which methods activate instantly versus after review, and settlement timing, from official pages.
- Decide platform account versus tenant-owned accounts.

## Sources (vendor pages, unverified)

- HitPay: hitpayapp.com (pricing, DuitNow, Touch 'n Go, API pages).
- Airwallex blog comparisons of Malaysian gateways.
- Stripe documentation for FPX; Stripe Malaysia payment-method coverage not confirmed from Stripe's own list.
