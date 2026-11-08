# Product editor UI

Implemented locally on 2026-11-08. This document describes the source and local verification; it is not evidence of production deployment.

## Seller workflow

The product editor keeps four mounted panels: **Basic information**, **Product images**, **Rich detail**, and **Variants**. Switching panels retains values, file selections and drafts. Tabs have linked tab/panel roles, roving focus, Arrow Left/Right and Home/End navigation. Native required-field errors reveal the containing panel before focus moves to the field.

A shared identity above the tabs shows the current name, SKU, active state and saved main-image thumbnail when present. Basic information retains the existing required fields, inventory behavior and Active in shop checkbox. The description remains a required plain-text **Short summary**, at most 2,000 characters. A compact currency note explains its existing company-settings source. Variant grouping, option labels, option pickers and existing variant navigation remain in Variants.

Product images retains the existing main-image and gallery controls. **AI product images** opens the existing AI Studio image task with this saved product selected. The entry explains that generation requires a saved main image, every variant inactive and the main gallery holder. It does not change visibility, generate images, create keys or call a paid provider itself. Existing AI Studio owns the actual generation and cost checks. Unsaved-product and non-holder cases show guidance rather than opening an invalid context.

## Rich detail

Rich detail is listing-owned and shared by every variant. Save the product first to obtain its identity; new unsaved products cannot upload detail images or save a document.

The editor supports heading, paragraph (optional whole-paragraph bold), bullet-list, local image and specification blocks. Sellers add, reorder, edit and delete blocks using labeled controls. Images accept PNG, JPEG or WebP up to 512 KiB, require descriptive alternative text and allow an optional caption. There is no raw HTML, external-image URL, arbitrary link or embedded-script mode.

Limits match the server: 40 blocks, 20 image blocks, 50,000 total text characters and a bounded document. Heading text is at most 240 characters; paragraphs 5,000; lists 30 items of at most 500 characters; specifications 30 rows with 120-character labels and 500-character values; image alternative text 500 and captions 1,000. Client validation gives immediate feedback, while the server remains authoritative. Before staging, the browser decodes the selected image and verifies its dimensions, then releases the decoded bitmap. A malformed image shows an actionable error without an upload request or lost draft. This is a usability check, not a server-side image-safety attestation.

**Save rich detail** saves only the document using its opaque expected revision. **Save product** saves existing metadata, prices, stock and gallery behavior. Each save retains the other area's unsaved draft. The unrelated Save product footer is hidden while Rich detail is selected. Leaving the product editor warns for either draft or an active mutation. A stale document save keeps the draft and reports a conflict; explicit reload asks before discarding it. A newly uploaded image removed before saving is discarded through the staged-only DELETE endpoint; saved image removal remains part of the document save. Abandoned staged uploads use the server's expiry policy.

Desktop/mobile preview uses the same `public/shared/product-detail.js` renderer as the shop. Content is rendered through DOM text nodes and fixed elements. The mobile preview is capped at 375 CSS pixels and long images retain their natural aspect ratio. A document without rendered blocks falls back to the existing short summary. The shop retains its existing purchase controls and shows rich content in the description area below them.

A compact assistant-editing disclosure explains a current compatibility boundary: protected MCP catalog mutations remain unavailable for listings with rich content until their protected review covers these additional assets/content. Regrouping a nonempty rich-detail source or destination is rejected rather than silently dropping shared content. To regroup, first copy the content outside the editor and explicitly clear the affected saved document. The UI does not bypass these backend controls.

## Local verification

`test/product-editor-ui-browser.test.js` uses the real loopback Node app, real SQLite data, seller password sign-in and authenticated HTTP endpoints. It has no mocked rich-detail endpoints, no paid-provider calls and fictional test data only. Four viewport/preference cases cover 375/1280 pixels with light/dark browser preferences. The existing application uses its configured palette under both preferences; this does not claim a native dark theme.

The browser cases verify keyboard tabs, independent metadata/detail drafts and saves, actual PNG upload, an undecodable image rejected before any stage request or database write, staged-image deletion, required image text, shared desktop/mobile rendering, inert HTML-like text, no horizontal overflow, cancel/discard behavior, real shopper rendering and a competing HTTP save rejected by revision checks. A fifth case covers new-product required-field panel focus, save-before-media, list/specification reordering, all seven locales without losing drafts and the contextual AI Studio route. The paid AI provider remains untested by this UI suite.

Optional browser execution:

```sh
QA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs NODE_ENV=test \
  node --test --test-concurrency=1 test/product-editor-ui-browser.test.js
```

`PRODUCT_EDITOR_SHOTS` optionally selects a pre-existing screenshot output directory. The manager's final validation and release record should identify the exact committed source and accepted live revision separately.
