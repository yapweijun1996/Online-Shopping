# Bounded route, keyboard and palette regression

The acceptance checklist defines88 as critical routes at320/390/820/1440px,
90 as keyboard focus, dialogs and Escape, and91 as accessible palette preview
and persistence. This command tests those local scopes rather than whole QA100.

Run `npm run test:usability-palette` with Node24 and an existing cached Playwright
installation/browser. `QA_PLAYWRIGHT_MODULE` may be an absolute external
`index.mjs`; `QA_EXPECTED_HEAD` optionally rejects a different commit;
`QA_OUTPUT_DIR` selects output (default `output/qa/usability-palette`).
It installs nothing and uses one Chromium worker sequentially at all four widths.

## Route inventory

Each width checks24 existing states: eleven Customer and thirteen Seller.
Customer covers catalog, six-image product/variant detail, empty/populated cart,
Profile, addresses, order list/detail, Settings, checkout and receipt. Seller
covers login, unconfigured/configured Dashboard, product list/new/edit/gallery,
categories, Company Settings, sales-order list/pending/confirmed detail and
confirmation-queue list/detail. Document width must stay within the viewport;
selected critical controls must have usable horizontal bounds after scrolling.
Screenshots retain every route state. This is an English normal-state matrix,
not every error/empty state, all locales, browser zoom or physical-device proof.

Fixtures use a disposable SQLite database, fictional store, two variant products,
six distinct valid PNG byte fixtures, browser-local Profile/address and two local
orders. One order is placed through actual Customer UI. A second API fixture is
confirmed only to reach the existing packing preview. The existing setup form's
`production` value configures only this temporary local database. It grants no
live production access. The real `Worker.fetch` and API are used; external browser
requests are blocked and no messages/payments/logistics are sent.

## Keyboard focus repair and checks

At the original application head, Tab from the address chooser's final Use
address button left the document while the dialog remained open. The captured
trace reported BODY and `document.hasFocus=false`. Native `showModal()` alone did
not maintain the requested document focus loop in the tested Chromium. The
shared `containDialogFocus` helper now wraps unmodified Tab/Shift+Tab at visible,
enabled controls' boundaries. It covers shared modals, Seller profile/decision/
document dialogs and Customer variant chooser. Existing image-viewer trapping
remains in its gesture controller. Escape and business actions retain their
existing handlers. Shop110/Seller85 invalidate both affected PWA asset caches;
this change is not a release or waiting-worker lifecycle recertification.

Actual dialogs are opened using native Enter and exercised through forward and
reverse Tab loops, accessible names, Escape, close-event completion and restored
focus. The matrix includes address add/edit/chooser, image viewer, mobile variant
chooser, category/language selection, Seller profile, confirm/reject decisions,
summary/packing preview and both palette previews. Account/language popups and
the responsive Seller drawer have keyboard/Escape checks. A temporarily disabled
decision action tests hidden/disabled control skipping without any order request.
No print/PDF action is triggered.

The shared update-confirm component is exercised with a disposable DOM trigger;
Escape must resolve cancellation and write nothing. No real waiting worker or
update activation is created. Native browser address deletion is cancelled via
Playwright's dismiss API; its native OS keyboard Escape is not exercised. These
limits remain explicit. This is not full accessibility, screen-reader, real Edge
or physical-device certification.

## Palette evidence

All five choices on both surfaces at all widths are previewed, cancelled with
Escape and applied explicitly with Enter. Preview/cancel must leave preference
unchanged and restore focus. Apply must select the radio, report saved and survive
reload. Seller and Customer keys remain independent. Six rendered text/action/
field/warning/error pairs per preview must reach4.5:1 (240 sampled pairs total).
Six price/status role tokens remain invariant. Existing Node tests additionally
check five palettes' text, controls and focus token thresholds.

Native Space selects a radio; an actual second same-origin tab must update its
palette and selected radio. A fixture throws only palette storage writes, so the
UI must report session-only application, keep the old saved value and restore it
on reload. Cart, selection, Profile, addresses and IndexedDB orders are compared
by browser-state hash. Every business-table hash must remain unchanged throughout
palette/dialog checks. Authentication/session/rate-limit bookkeeping is excluded.

## Evidence and boundaries

JSON retains exact head/worktree status, source hashes before/after, versions,
viewport cases, geometry, safe focus traces, rendered contrast samples, Worker
method/path/body length/status records and cleanup. Actual fixture credentials,
cookies, CSRF and order access keys are generated/held in memory and redacted;
no database or secrets are archived. Screenshots reject an uncleared fixture
authentication input. Disposable databases/browser contexts are removed, while
shared Playwright binaries and Printform processes are preserved.

Earlier failed/incomplete fixture and focus runs retain original labels and are
not credited as passing matrix runs. Final evidence must match a clean commit;
partial runs keep the entire criterion unverified. Local checks do not relabel
unrelated prior-head QA results or close cancellation/draft policy, tenant/auth,
provider, deployed-build or18-MVP release gates.

This independent npm command is outside `npm test` and the existing CI workflow;
CI/dependencies/publishing/authentication are unchanged. Parse it explicitly with
`node --check scripts/qa-usability-palette.mjs`; `npm run check` covers application
`.js` files. Focused Node checks use mobile-navigation, shop-palette, image-zoom
and PWA tests. No unchanged heavy browser/Printform/PDF suites are repeated.
