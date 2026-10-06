# Gallery, public business Chat and preview copy — local checkpoint

Branch: `codex/customer-seller-qa-local`. Based on main
`5966ca8626c6c75e8e0ec4e34488a7c47fa29376`, following QA inventory commit
`58394d2bbb15da66df82d9450b7f6cf78af31eb0`.
The saved review package records the exact candidate commit and includes its
patch, changed source, test logs and inspected screenshots.

## Result

The local candidate is Shop106 / Seller83. Publication is not authorized.
The public deployment was previously verified as Shop103 / Seller79; it has
not been changed by this work. No PR, push, merge or live migration was made.

- Product detail, catalog covers and variant covers now resolve a saved gallery
  order. Static reference files keep their original URLs and bytes. Adding an
  upload retains all six existing reference images. The first selected identity
  is the primary image; selected uploads retain their IDs and bytes.
- The Seller editor stages image addition, removal, ordering and primary changes
  until **Save product**. Cancel does not write. Metadata and gallery save in one
  transaction. A stale `expectedUpdatedAt` rejects the write and retains the
  draft. Duplicate reference IDs and identical uploaded bytes are deduplicated;
  the resulting gallery is limited to ten images. Arbitrary URLs, other products'
  reference IDs and other stores' upload IDs are rejected.
- The public shop DTO reads only `company_setting.seller_whatsapp_phone`, whose
  settings UI now explicitly calls it the **public business WhatsApp number**.
  It never reads an account/principal phone or buyer contact. Valid +60/+65
  numbers are normalized and exposed; blank or invalid stored values return null.
  The customer button builds a safe `wa.me` link. No link was opened and no
  automatic messaging integration was enabled.
- Controlled labels and seeded descriptions use Preview or factual language in
  all seven translation dictionaries. Technical `DEMO-*` SKUs, order IDs, routes,
  cookies and namespace identities remain unchanged. An exact controlled legacy
  description/shop name is presented neutrally without rewriting stored data.
  Arbitrary seller descriptions, customer records and historical snapshots are
  preserved. No-payment, no-shipment and manual-packing limits remain visible.

## Evidence and boundaries

`test/priority-fixes.test.js` reproduced three failures before implementation:
the 6-to-2 loss, missing canonical gallery editing, and saved contact masked by
the public DTO. Its five final regressions cover those contracts, rejection
rollback, stale writes, deduplication, authorization/CSRF, product/store isolation,
the public shop field allowlist, invalid/blank contacts, and seven-locale text.

The final complete source suite passed **147/147**, including the five priority regressions.
JavaScript syntax checks and `git diff --check` passed.

Eight actual browser cases passed using one cached Chromium worker and a fresh
in-memory SQLite database. They cover six-image display, ten-image draft and
overflow/invalid upload, keyboard reordering/primary selection, repeated Save,
customer identity/order and image decoding, cancel/reopen, failed-save retention
and retry, public contact save/link, invalid contact retention and clearing Chat.
The browser recorded zero page exceptions and zero external requests.

Inspected pixel evidence includes Seller six-image editing, Customer ten-image
detail, the public business contact setting, and unconfigured Customer Chat.
The Seller ten-image full-page capture was taken immediately after resizing;
its transition frame is not accepted as settled mobile layout evidence.

At the owner's requested boundary, the browser's remaining seven-locale rendered
pages, settled Seller mobile gallery, and PDF/HTML generation/reopen cases are
**not run**. The scripted cases are retained for the next authorized test unit.
Translation dictionary tests are not a substitute for those browser checks.
The complete 100-criterion QA inventory remains open.

## Review and release gates

Schema12 adds nullable `gallery_layout_json` and raises the upload position
constraint to ten. The local migration copies existing upload IDs, bytes,
positions and timestamps; untouched products have a null layout. No production
database was opened. Deployment would automatically apply this migration and
therefore requires exact migration, backup/restore and rollback review before
release. Old application versions do not understand saved layouts.

The public business-contact exposure is an intentional public-field contract
change requiring review before release. A configured number becomes visible
on Customer product pages, including preview mode. Fixture numbers are fictional.
Preview orders remain anonymous and do not grant contact permission.

The existing production app still uses one store per shop. The isolated Admin
workspace remains ephemeral fiction. Store/product negative tests and existing
Admin sandbox tests do not certify production multi-company principals or grants.
No new grants, credentials, production tenant migration or provider calls exist.

Other release gates remain: exact deployed candidate verification after approved
release, physical iOS/PWA checks, full Customer/Seller journeys, PDF/export
acceptance, production access isolation, and restore evidence. The original
18-MVP denominator remains separate from these priority tests: historical 16/18
is not a production pass; production acceptance remains unverified (0/18).
Payment/courier automation remains outside that original MVP.

## Reproduce locally

Use the repository's Node24 runtime and existing dependencies. Run `npm test`
with one worker (already configured), then `npm run check`.
`QA_CASE_LIMIT=8 node scripts/qa-priority-browser.mjs` runs exactly this bounded
browser package. The Mac-specific cached Playwright import may need to be
adapted on another review machine; it never installs or removes browser binaries.
All browser writes target newly created synthetic memory stores.
