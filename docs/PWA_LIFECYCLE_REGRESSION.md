# Genuine historical PWA lifecycle regression

The focus repair candidate8ab072e labelled its app shells Shop110 / Seller85 but left both worker versions at109 /84. Genuine109 /84 controlled clients could not discover an update because their worker scripts and imported core remained identical. Align both worker cache versions with the app versions. This changes two cache identifiers, without changing update policy or clearing business storage. A unit regression now requires each worker and app version to agree.

`scripts/qa-pwa-lifecycle.mjs` reuses the existing local PWA harness and actual Worker/API ingress. It serves every historical public asset directly from Git, with its source commit and SHA-256 recorded. The current target must match all committed public/src bytes. No new code receives an old version label.

Run serially with one cached browser worker:

```sh
QA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
QA_EXPECTED_HEAD=<exact-current-head> \
QA_PREDECESSOR_HEAD=fb3ee4074d07b630cb2862bdbf390e35224cd059 \
QA_OUTPUT_DIR=output/qa/pwa110/genuine109-84 \
node scripts/qa-pwa-lifecycle.mjs
```

The default predecessor is the verified Shop109/Seller84 commitfb3ee40. A second invocation uses genuine8ab072e as the predecessor. That actual candidate loads110/85 app bytes with109/84 workers, so its real update-confirmation dialogs contain the focus repair and can exercise Tab/Shift+Tab, Escape, cancellation and opener restoration while native waiting110/85 workers activate. This is a separate genuine candidate-to-repair hop, not a relabelled old shell. Both predecessors are installed and then launched through one real controlled-page reload before any draft is created. Genuine8ab072e has a known initial bootstrap mismatch (app110/85, controller109/84); its first-install update can take the reload branch. This pre-fix observation is retained separately. A fresh current110/85 installation checks matching controllers and no spurious reload request. Legacy109/84 confirmation dialogs retain their historical behavior; they do not claim to contain the later focus repair.

Checks cover separate native registrations/caches, waiting version labels, cart/Profile and Seller gallery drafts, update cancellation, actual busy order and product requests, late edits during activation, requesting-tab reload deferral, other Seller-tab preservation, explicit saved reload, offline update failure and automatic online recovery, offline save/submit truthfulness, cached offline navigation, real API retry and precached byte/privacy boundaries. The late-edit fixture briefly holds only the outgoing SKIP_WAITING message, then forwards it to the native waiting worker; it does not replace registration or activation with mocks.

The database is disposable and in memory, credentials are random runtime fixtures and never serialized. This bounded Chromium check does not establish physical-device installation, Safari/iOS, real Edge, deployed behavior or complete site acceptance. It does not change CI, authorization, product currency, prices, order snapshots, cancellation or Profile draft policy. No real payment, courier, print or provider calls occur.
