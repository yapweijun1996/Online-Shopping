# Bulk shipping export and tracking CSV import

Research/design date: 2026-10-20. Status: proposed, not implemented. Repository: `/Users/yapweijun/Documents/GitHub/Online-Shopping`. Only this document was written; repository files were read only. All public sources below were retrieved on 2026-10-20. Source modification dates are publisher claims, not evidence of a tested portal contract.

## 1. Decision and scope

Build two separate operations: export selected confirmed orders for external booking, then preview and atomically import tracking assignments. Neither export nor booking-file creation changes order status. Import is an authenticated seller declaration that parcels have actually shipped, not a provider webhook or proof of collection. No courier API, polling, credential storage, payment, live shipment creation, automatic email, or courier webhook in this phase.

Use a shop-owned, explicit inbound CSV contract immediately. Put EasyParcel-specific outbound serialization and any future result-column mapping behind `src/integration-*.js`, as AGENTS.md requires. Do not claim a file is EasyParcel-compatible until an actual current MY template and a portal validation example establish its exact headers, enumerations and cell behavior.

Important unresolved prerequisite: public EasyParcel documentation confirms booking by Excel/CSV and retrieval of AWBs/tracking in its dashboard; this research did **not** establish a downloadable results CSV containing our reference, courier and tracking number. The fully automatic file round trip is therefore **UNVERIFIED**, not an assumed EasyParcel feature. A seller can prepare the shop-owned inbound CSV in a spreadsheet, but that is a documented manual conversion, not completion of the desired provider-native round trip.

The current order has one tracking pair even though it may have several destinations. Propose explicitly rejecting multi-destination orders from the first bulk workflow. This is a proposed scope gate requiring owner acceptance before implementation, not an implicit reduction of the request. If all orders must be supported, implement delivery-level shipments first (section 9); never mark several destinations shipped with one destination's tracking.

## 2. Public evidence ledger

| ID | Primary source and date | Confirmed facts and limitations |
| --- | --- | --- |
| E1 | [MY domestic Bulk Upload](https://helpcentre-my.easyparcel.com/support/solutions/articles/9000188595-how-to-send-domestic-parcels-via-fileupload-bulk-parcel-), modified 2026-08-13 | Up to 1,000 items per upload; single- or multiple-sender-address templates; sender/receiver and parcel field groups; edit, process, checkout, pay, print AWBs. Text mentions XLS/CSV. No downloadable template bytes exposed in the fetched article. |
| E2 | [MY Next Gen bulk walkthrough](https://blog.easyparcel.com/my/send-bulk-parcels/), published 2026-01-07, modified 2026-08-18 | CSV or XLSX; download template in dashboard; courier optional at upload, selectable later; add-ons and notification options. Its examples are descriptive, not a complete header specification. |
| E3 | [MY international Bulk Upload](https://helpcentre-my.easyparcel.com/support/solutions/articles/9000188596-how-to-send-international-parcels-via-file-upload-bulk-parcel-), modified 2026-08-13 | Up to 1,000 international packages; sender/receiver, content, weight/dimensions, currency, price per item, quantity, reference; article labels Item HS code optional. Its summary emphasizes customs details. E2 instead calls HS code required internationally: resolve per destination/service, not globally. |
| E4 | [MY weight guidance](https://helpcentre-my.easyparcel.com/support/solutions/articles/9000224464-how-do-i-determine-the-weight-of-my-parcel-), modified 2026-09-04 | kg actual weight, cm dimensions, volumetric calculation L×W×H/5000; higher of actual and volumetric is chargeable. Carrier-specific rounding, limits and divisors are not established by this general guide. |
| E5 | [MY content guidance](https://helpcentre-my.easyparcel.com/support/solutions/articles/9000188697-what-is-item-category-and-parcel-content-), modified 2026-08-11 | Detailed item type/brand/material descriptions; category is a separate dropdown used for customs/insurance. Accurate value required; no universal value limits/decimal rules supplied. |
| E6 | [MY tracking retrieval](https://helpcentre-my.easyparcel.com/support/solutions/articles/9000223903-how-to-keep-track-my-parcels-), modified 2026-08-19 | Manage Parcel → All Parcels shows tracking numbers; EasyTrack accepts tracking or EasyParcel order numbers, up to 15 tracking inputs. This does not prove bulk tracking CSV export. |
| E7 | [MY “export parcel list to CSV”](https://helpcentre-my.easyparcel.com/support/solutions/articles/9000224114-how-to-export-my-parcel-list-to-csv-file-), modified 2024-06-12 | Only Excel File → Save As → CSV UTF-8/CSV instructions for preparing an upload. **Not** a result-download guide. |
| E8 | [SG domestic Bulk Upload](https://helpcentre-sg.easyparcel.com/support/solutions/articles/9000207657), modified 2026-09-17 | Up to 300 bookings, value of goods in SGD, primary/alternative courier, pickup/drop-off date, tracking add-ons, reference and optional HS code. Download current template from portal. Not a MY contract. |
| E9 | [Ninja Van SG bulk-order guide](https://www.ninjavan.co/en-sg/dashboard-guide/features/how-do-i-create-orders-in-bulk), publication/update date not displayed | CSV/Excel mapping templates and explicit header table. Fallback comparison only; not evidence of Ninja MY or EasyParcel headers. |
| E10 | [EasyParcel MY marketing page](https://easyparcel.com/my), search result retrieved 2026-10-20; publication date unavailable | Search excerpt still advertises 100 Bulk Upload / 300 Bulk Express. Conflicts with updated E1's 1,000. Use E1 as current documented MY guidance, but validate the account's actual upload limit. |

Searches covered EasyParcel bulk templates, parcel/tracking result exports and phone/postcode/state formatting, then Ninja Van as a fallback because EasyParcel's machine-readable schema remained unclear. No J&T/Flash contract is needed to infer EasyParcel behavior; neither was used as a substitute. No account login, paid booking or provider API was performed.

### 2.1 Researched EasyParcel template: semantic fields, not invented headers

The labels below are the article's field descriptions. **Exact CSV header spelling, order, required markers, per-cell lengths, blank conventions and dropdown values remain UNVERIFIED for all EasyParcel columns until the current template is obtained.** Do not use this table as a literal CSV header row.

| Documented field/group | Requirement supported by source | Rule / gap |
| --- | --- | --- |
| Sender name, phone, complete address, postcode, city, state, country | E1: enter for multiple sender addresses; single-address template uses one pickup address | Exact representation and single-sender location in file versus portal UNVERIFIED. |
| Sender company, email, alternative phone, Tax ID | E1 explicitly optional | Do not invent values. |
| Receiver name, phone, address, postcode, city, state, country | E1 says enter these details | Treat as export readiness requirements; exact template-required cells UNVERIFIED. |
| Receiver email, company, Tax ID | E1 optional | Buyer's email is not necessarily recipient's. |
| Parcel weight (kg) | E1/E4 instruct entering accurate weight | Positive decimal; exact precision, minimum, maximum and actual-versus-chargeable file semantics UNVERIFIED. |
| Parcel dimensions (cm): length, width, height | E1 instructs entering all three | Do not fabricate dimensions from quantity or weight. |
| Parcel content | E1/E5 require accurate, specific description | Product title is only a candidate; category and HS code are not interchangeable. |
| Price currency | E1, example MYR | Allowed values and conversion policy UNVERIFIED. |
| Price per item | E1 instructs accurate value | Not automatically order total; mixed-item representation UNVERIFIED. |
| Item quantity | E1 lists it | E2 separately describes Quantity as parcel count, usually 1. Do not conflate units with packages. |
| Reference | E1 lists it, E8 calls it internal order/reference number | Requiredness, length, uniqueness and retention in downloaded results UNVERIFIED. |
| Courier company | E2 says optional; can select later | Exact service identifiers UNVERIFIED. Aggregator name is not the carrier. |
| HS code | E2/E3 disagree on international requiredness | Exclude cross-border from the initial verified profile unless a separate customs contract is established. |
| Notifications, AWB branding, EasyCover | E2 options | Do not silently opt in or create extra charges. Exact flags UNVERIFIED. |

### 2.2 Malaysian states, postcode, phones and regional differences

E1 requires state/city/postcode/country but does not give accepted state tokens. Proposed internal MY selection vocabulary: Johor, Kedah, Kelantan, Melaka, Negeri Sembilan, Pahang, Perak, Perlis, Pulau Pinang, Sabah, Sarawak, Selangor, Terengganu, Kuala Lumpur, Labuan and Putrajaya. This is a **proposed local vocabulary, not a verified EasyParcel enumeration**. Melaka/Malacca, Pulau Pinang/Penang and federal-territory prefixes need an explicit adapter mapping verified against template dropdowns. Do not guess numeric state IDs, infer a state from a postcode alone, or overwrite the customer address snapshot.

Proposed local readiness checks: MY postcode exactly five ASCII digits, SG exactly six; keep as strings to preserve leading zeros. EasyParcel's own precise postcode acceptance rules are **UNVERIFIED** in the consulted articles. E9 independently confirms six-digit SG postcodes for Ninja Van only. Neither numeric spreadsheet conversion nor scientific notation is acceptable for identifiers.

Repo recipients already pass `normalizeContactPhone` for +60/+65; E1 only says phone number and does not establish whether the file wants `+601…`, `601…` or a local `01…`. All those EasyParcel phone-format assumptions are **UNVERIFIED**. Retain canonical phone strings; transform only inside a verified provider profile. Do not infer that a buyer's optional WhatsApp phone is the recipient phone. A + prefix also interacts with spreadsheet formula protection (section 6).

MY and SG are separate profiles/accounts/templates, not a currency toggle: updated documented upload limits are 1,000 MY (E1) versus 300 SG (E8); E8 explicitly uses SGD goods value and has alternative-courier/drop-off controls. An order in SGD shipped from MY is not an SG domestic shipment. Country, origin and service determine the profile. Cross-border needs its own template/customs validation. Local import limit remains 500 irrespective of provider capacity; an SG outbound batch must be split to at most 300 according to E8.

### 2.3 What comes back

Confirmed: after checkout/payment, AWBs can be printed/downloaded in bulk (E1/E3/E8); tracking numbers are visible in All Parcels (E6). **UNVERIFIED**: whether MY offers a results CSV/XLSX export, its exact columns and menu, delivery by email, whether courier name and shop Reference are included, asynchronous AWB availability timing, and one-to-many rows for multi-parcel bookings. Do not scrape PDFs or match by file row position.

Before advertising one-click provider round trip, obtain a redacted input template plus actual post-booking results example from the intended MY account, and verify that Reference survives unchanged and tracking is the carrier AWB, not an EasyParcel booking ID. This requires account-side evidence unavailable from the public documents, not another guessed header list. If no result CSV exists, state the manual spreadsheet conversion requirement plainly.

Fallback evidence: E9's actual Ninja SG headers include mandatory `Name`, `Address 1`, `Phone Number`, `Postcode`; international-only `State`, `Portation`, `Country`; optional `Shipper Order No.`, `Requested Tracking Number`, `Parcel Weight`, `Address 2`, `Email`, and others. It supports saved header mappings and review before confirmation. `Requested Tracking Number` is an input customization, not proof of an allocated tracking-results file. These headers must never be relabeled as EasyParcel or Ninja MY headers.

## 3. Repository findings

- `src/order-export.js:1-40`: accounting export, max 5,000 orders, shared `orderFilter`, counts items/destinations, buyer contact, carrier/tracking, UTF-8 BOM and CRLF. It does **not** export recipient address, parcel measurements or provider fields. Keep it unchanged; do not overload its accounting contract.
- `src/seller-orders.js:13-19,120-248`: `ship` only CONFIRMED → SHIPPED. Validation requires expectedRevision >=1, carrier bounded to 40, tracking optional up to 60. `decideSellerOrder` transaction reads status/revision, CAS-updates status and revision, writes SELLER `order_event` with `actorId` equal to authenticated username. `updated_at` and event `occurred_at` are server time. It does not accept shippedDate and has no separate shipped-date property in the reviewed order projection.
- Detail contains `deliveries[]`, each recipient/address and item snapshots; shop_order holds one `tracking_carrier`/`tracking_no`. Address region/city are optional. `src/checkout-input.js:42-56` accepts arbitrary two-letter country, postcode text up to 20 and optional region up to 80, not provider-specific MY states.
- `src/settings.js:76-81`: settings provide currency, seller WhatsApp phone and policy text, not a complete sender address. Seller WhatsApp contact is not necessarily a pickup contact.
- `src/product-import.js`: RFC-style CSV reader (BOM, quoted commas/newlines, doubled quotes); 4,000-char cells, 2,000 rows, 1,000,000 chars; SKU lookup in chunks of 400; preview plans; at most 300 changed/error rows shown. Commit replans inside a transaction, blocks all writes on errors and uses existing editor/history. It does not bind commit to the earlier preview's revisions.
- `src/csv.js`: `csvCell` prefixes apostrophe for initial `= + - @ TAB CR`, escapes CSV, `toCsv` supplies BOM/CRLF. Product importer reverses the known protection pattern; it must not be generalized into formula evaluation.
- `src/app.js:384-430`: existing GET export requires `data.export`, denies quickLogin, no-store attachment. Product POST uses JSON `{csv,commit}`, Origin/CSRF, catalog capability and a larger body bound, returns plan on 409. Manual ship uses `orders.fulfil` and account.username. New named CSV routes must precede UUID detail/action matching and retain tenant prefix resolution.
- `src/roles.js`: orders.fulfil permits OWNER/MANAGER/STAFF; data.export only OWNER. Giving shipping exports to Staff is a privilege-policy change, not automatically authorized by existing accounting export behavior.
- `public/seller/orders.js`: Sales Orders and Sales Order Confirmation scopes; latter filters CONFIRMED/SHIPPED/DELIVERED/CANCELLED; current export uses active filters, current ship dialog edits carrier/tracking. `mountOrders` has canExport/canDecide but needs an explicit capability-derived bulk control.
- `public/seller/product-import.js`: native dialog, file input, immediate preview, summary and row diffs/errors, disable commit while busy/errors, focus containment/restoration, unauthorized callback, textContent rendering. Reuse interaction pattern, not product-specific SKU/change labels.
- `docs/API.md:100-118` describes these contracts; its later no-batch-export statement at line 179 is broader than current accounting export and should be clarified when implementing shipping CSV. `docs/threat-model.md` requires session, Origin/CSRF, per-shop store, bounded input, CAS + order_event, no PII logs, no-store responses and no provider calls from order handlers.
- `src/store.js` and `src/postgres-store.js` support nested transaction callbacks by joining the outer transaction. Sequential `decideSellerOrder` calls can therefore share one outer batch transaction; do not catch and continue after a failed row.

## 4. Proposed OUTBOUND design

### 4.1 Selection and data capture

Use a separate “Export shipping CSV” action in Sales Order Confirmation. Explicitly select up to 500 eligible orders, including across list pages with a visible selection count; never export only the first 100 by accident. Default to CONFIRMED, but enforce eligibility server-side. Reject unknown, simulation, erased-contact, non-CONFIRMED and multi-destination orders with row-level readiness errors. Do not silently skip selected orders.

Smallest capture: a batch preparation dialog with a per-order editable grid and “apply to selected” controls. Sender pickup address is selected in EasyParcel using its single-address flow; this avoids adding an unnecessary sender-address schema. Capture actual packed weight, dimensions, content and state/city corrections as transient export inputs, not customer snapshot mutations. Require explicit review for defaults; never assume every parcel weighs 1kg. Changing data/file invalidates the prior preview. If durable reusable packing profiles are later needed, add them separately, not mandatory product-weight columns now (product weights alone do not include packaging).

| EasyParcel semantic destination (exact header UNVERIFIED) | Existing data / proposed value | Missing or safety handling |
| --- | --- | --- |
| Reference | `shop_order.order_no` | Exact string; prove result retention before round-trip release. No buyer bearer/access key. |
| Receiver name / phone | `delivery.recipient_name`, `recipient_phone` | Never buyer fallback. Provider phone transform only after verification. |
| Receiver address | `address_line1`, `address_line2` | Preserve separate lines when template allows; no destructive truncation. |
| City / state | `address_city`, `address_region` | Missing/ambiguous values block readiness; transient explicit correction, verified state mapping. |
| Postcode / country | `address_postcode`, `address_country` | String-based checks; MY domestic profile rejects non-MY; template country token unverified. |
| Receiver email/company/Tax ID | No assured recipient-specific fields | Leave optional cells blank; do not export buyer email automatically. |
| Sender details | EasyParcel saved single pickup address | Full sender data not present in current settings. Multiple-sender template deferred unless separately captured/verified. |
| Weight and dimensions | New per-parcel transient fields `weightKg`, `lengthCm`, `widthCm`, `heightCm` | Decimal strings with positive values; exact provider caps/precision pending template. Show chargeable-weight guidance; do not double-apply volumetric weight. |
| Content | Suggested `order_item.name_snapshot` descriptions and quantities | Seller approves specific physical-content description; avoid injecting internal notes. |
| Currency / price per item / item quantity | `order_item.currency`, `price_minor` formatted using `money`, `quantity` | Preserve line-level price and quantity; never divide order total into arbitrary per-item value. Mixed products need actual template item-group representation. |
| Courier / pickup date / paid add-ons | Chosen in EasyParcel | No guessed service codes; no notification/insurance opt-in by default. |

Mixed-product packing: E1 does not establish whether one parcel supports repeated item groups or repeated rows. Never emit one booking per item or average unequal unit prices. The verified profile must implement the actual multi-item template semantics, or block affected orders with `ITEM_LAYOUT_UNVERIFIED`. This is another explicit acceptance gate, not a pretend fully supported export.

### 4.2 Boundary and API

Suggested modules: generic `src/order-shipping-export.js` handles shop eligibility and source extraction; `src/integration-easyparcel-csv.js` owns the pinned MY template profile, field mapping, exact enumeration/format limits and CSV serialization. No HTTP transport. Reuse `orderFilter` only for a selection helper; final export uses exact order IDs/revisions. Existing accounting CSV remains unchanged.

Proposed `POST /api/v1/seller/orders/shipping-export`:

```json
{
  "profile": "easyparcel-my-domestic",
  "download": false,
  "orders": [
    {"orderNo":"EXAMPLE-0001","expectedRevision":2,
     "parcel":{"weightKg":"0.75","lengthCm":"20","widthCm":"15","heightCm":"10",
               "content":"Cotton T-shirts, 2 units"},
     "destinationOverride":{"city":"Shah Alam","region":"Selangor"}}
  ]
}
```

`destinationOverride` permits only city/region readiness correction in this proposal; no freeform recipient replacement. This is not a persistent order edit. Server reads canonical order data, verifies revision and eligibility, resolves all rows in a read transaction. `{download:false}` returns `{profile,summary:{ready,errors},rows:[{line,orderNo,errors}],templateVerified}`. `{download:true}` reruns all checks and returns CSV attachment only if every row is ready; any error returns 409 `EXPORT_HAS_ERRORS` and the full readiness report. Unverified profile returns 409 `TEMPLATE_UNVERIFIED`, never a plausible provider file.

Require session, Origin and CSRF on this POST even though it performs no state mutation. Require **both** `orders.fulfil` and existing `data.export` initially (Owner), deny quickLogin, use tenant-resolved store, no-store/nosniff, fixed safe filename. Keep import available to every orders.fulfil role. Opening shipping export to Manager/Staff requires an explicit role-policy decision because full recipient data leaves the system; do not silently widen data.export. Cap 500 orders, 1,000,000 JSON bytes, 413 on overflow; SG profile if later added caps/splits to 300. Do not implement an SG adapter as a copy of MY.

## 5. Proposed INBOUND contract

### 5.1 File format and normalization

Shop-owned headers, **not EasyParcel headers**:

```csv
Order number,Carrier,Tracking number
EXAMPLE-0001,J&T Express,001234567890
```

Optional fourth header: `Shipped date`. UTF-8 CSV only, optional BOM, comma delimiter, CRLF/LF, normal quoted cells. No XLS/XLSX parsing dependency. At most 500 data records, 1,000,000 characters, 4,000 characters per cell; stream-bound JSON request to 6,100,000 bytes to cover worst-case JSON escaping of those characters plus the small preview revision manifest. Client rejects files above 1,500,000 bytes as an early aid, not the security boundary. Quoted newlines count as one record; preview exposes CSV record number (`line`, header=1), not misleading physical text line number.

Match headers after trim and ASCII case-folding; these four names only. Reject duplicate/unknown headers rather than silently ignoring a misspelled tracking column. Require all three main columns, nonempty after trim. Reject inconsistent row widths and malformed quoting. Extract existing parser into a shared parameterized reader in `src/csv.js`, migrate the product importer import directly (no alias/re-export shim), preserve existing product limits/behaviors, and add strict parsing for tracking without inadvertently relaxing it. Existing reader is permissive about some trailing text after quotes; a new shipping importer must not assume its current parser proves strict RFC validation.

Apply `boundedText`-equivalent trim/NFC and control-character refusal to identity fields; no formula evaluation. Exact stored order-number match after surrounding whitespace removal and known export-protection decoding; **no** substring, fuzzy/name/phone match, numeric conversion, case guessing, suffix stripping or provider booking-ID substitution. Query only the resolved shop's store. Unknown number produces `ORDER_NOT_FOUND` with no cross-shop search.

Carrier is required, max 40; use the same small canonical display vocabulary as manual UI where possible and explicit known aliases (e.g. reviewed J&T naming), otherwise keep bounded literal carrier text. Never auto-detect from tracking digits or store “EasyParcel” when actual courier is unknown. Tracking number required, max 60, preserved as a string including leading zeros/case. Reject formulas, control characters, scientific-notation-looking values and whitespace within tracking identifiers; do not impose a courier-specific numeric-only regex. No automatic tracking correction, no automatic link construction from arbitrary URLs.

Optional Shipped date is a real `YYYY-MM-DD` calendar date in Asia/Kuala_Lumpur (UTC+8); reject invalid dates, future dates and dates before confirmation's UTC+8 date. Empty means not supplied. To avoid inventing a shipment timestamp schema, retain the supplied date as bounded audit reason text `tracking CSV; declared shipped date YYYY-MM-DD`; server `occurred_at` and `updated_at` remain commit time. Preview states this distinction. No separate queryable shipped-date field is promised. If business reporting needs it, use a later schema change rather than backdating audit events.

### 5.2 Row classification and idempotency

| Current state / condition | Plan result |
| --- | --- |
| CONFIRMED, one destination, valid new pair | `ship`, expectedRevision captured from current order |
| SHIPPED, same normalized carrier and exact tracking | `unchanged`; no revision, event, date rewrite or other effect |
| DELIVERED, same pair | `unchanged`; prevents an old file from failing merely because delivery advanced; never regress to SHIPPED |
| SHIPPED/DELIVERED, different pair or missing existing tracking | `TRACKING_CONFLICT`; no overwriting or filling by this import |
| SUBMITTED / REJECTED / CANCELLED | `INVALID_STATUS`; never implicitly confirm, restore/deduct stock or reopen |
| Unknown order | `ORDER_NOT_FOUND` |
| Multiple destinations | `MULTI_DESTINATION_UNSUPPORTED`, including already-shipped rows until delivery-level policy exists |
| Simulation or erased contact | `ORDER_NOT_ELIGIBLE`; no attempt to export/notify or restore erased data |
| Repeated order number in file | Mark **all** occurrences `DUPLICATE_ORDER`, even identical; no first/last wins |
| Same carrier/tracking assigned to two distinct rows or another shop-local order | `TRACKING_REUSED`; check existing SHIPPED/DELIVERED assignments, no cross-shop lookup |

Carrier/tracking reuse policy assumes one parcel per order. Shared consignment/group-shipping exceptions require a separate reviewed model; do not silently allow them. Since manual ship can currently accept repeated tracking, a global uniqueness guarantee would need manual-route validation/DB constraints too. In this phase the importer detects reuse visible in its transaction, but **concurrent manual reuse is a documented residual risk**, not a claimed unique constraint.

Reimport of the same valid file is all unchanged, even after a lost commit response; no batch-hash database table required. A byte-level hash alone would be insufficient (different quoting, row order or BOM can represent identical assignments). Declared date changes do not rewrite already-shipped events; show a warning on an unchanged row if a supplied date cannot be recorded. Corrections to previously shipped assignments are outside this operation and must never be disguised as idempotency.

### 5.3 Preview and commit API

`POST /api/v1/seller/orders/tracking-import`, session + `orders.fulfil`, exact Origin, CSRF, current per-request account permission and tenant store. Deny quickLogin for this bulk operation; do not infer sample permission from the manual per-order route. No `data.export` required for tracking import.

Preview request:

```json
{"csv":"Order number,Carrier,Tracking number\r\nEXAMPLE-0001,J&T Express,001234567890\r\n","commit":false}
```

200 response (illustrative fictional data):

```json
{
  "summary":{"ship":1,"unchanged":0,"errors":0},
  "rows":[{"line":2,"orderNo":"EXAMPLE-0001","action":"ship","expectedRevision":2,
    "changes":[{"field":"status","from":"CONFIRMED","to":"SHIPPED"},
               {"field":"carrier","from":null,"to":"J&T Express"},
               {"field":"trackingNo","from":null,"to":"001234567890"}],"errors":[],"warnings":[]}],
  "expectedRevisions":[{"orderNo":"EXAMPLE-0001","revision":2}],
  "hiddenRows":0
}
```

Return all <=500 row results, including unchanged and errors, so the seller can inspect and download a complete report. The dialog may page the rendering; do not copy product preview's 300-row truncation into the API accidentally. Error object: `{field,code,message}`. File-level invalid shape/header/CSV: 400 `INVALID_INPUT`; size/count overflow: 413 `TOO_MANY_ROWS` or `PAYLOAD_TOO_LARGE`. Row errors preview normally return 200 with errors and no writes.

Commit sends the **same csv** and boolean `commit:true`, plus `expectedRevisions` returned by preview, covering every matched row exactly once. Reject unknown request properties, missing/duplicate manifest entries and invalid revisions. Changed file forces a new preview in the UI. The manifest is a concurrency assertion, not an authorization credential; server never trusts client action/status/carrier validation results.

Within one outer store transaction:

1. Reparse/revalidate CSV, resolve orders in bounded IN queries (chunks <=400), detect all duplicates, state errors and tracking reuse. No network and no unbounded detail reads.
2. Compare preview revisions for `ship` candidates to current revisions. A row that became an identical SHIPPED/DELIVERED assignment is unchanged for idempotent recovery, even with a stale manifest. All other revision differences are `STALE_REVISION`. This improves preview concurrency safety compared with product import, which only replans at commit.
3. Any row error aborts the entire batch: 409 `IMPORT_HAS_ERRORS` with current plan; no partial commit and no “skip invalid” switch. A CAS failure after planning throws out of the outer transaction; return 409 `STALE_REVISION` and require preview again.
4. In deterministic order-ID order, apply each `ship` through the same shipping validation/CAS/event helper used by manual `decideSellerOrder`. Extract a small transaction-joining mutation helper from that code to avoid loading full products/images/notes for every batch row. Both manual and CSV callers use it; no second transition implementation. Each UPDATE has `WHERE id=? AND status='CONFIRMED' AND revision=?`, increments once, sets carrier/tracking and server updated time. Each event has event_type/status SHIPPED, previous_status CONFIRMED, actor_type SELLER, actor_id authenticated account.username, reason `tracking CSV` plus optional declared date, occurred_at server commit time. Event failure rolls back the order update and every other row.
5. Return the applied plan plus `applied:{shipped,unchanged}` only after transaction success. Do not call 500 separate HTTP endpoints or parallelize operations on one transaction connection.

The outer transaction and helper must work identically in SQLite and PostgreSQL. Do not catch per-row exceptions inside the transaction and continue. No stock mutations occur on ship; cancellation/confirmation behavior stays unchanged. Authentication/authorization fails before resource lookup. If a transport outcome is unknown, UI says “Outcome unknown; preview the same file again,” not “Nothing shipped.” Repreview recovers unchanged results without duplicate events.

### 5.4 Error report

“Download validation report” uses the returned complete plan in memory; no server file storage. Shop-owned report headers: `Record`, `Order number`, `Action`, `Field`, `Code`, `Message`. One error per report row; unchanged/valid rows may be included with blank error fields. Serialize all cells with the shared formula-safe writer. Do not include buyer contact/address, raw CSV payload, session/CSRF or guest access keys in errors, logs or audit reason. No upload retention or localStorage of CSV/plan; clear on dialog close/sign-out.

## 6. Security and UI behavior

- `csvCell` protection is necessary but its existing first-character check is not a complete arbitrary-whitespace spreadsheet defense. Export/report wrappers must handle dangerous prefixes after leading whitespace and LF as well as existing prefixes, with regression coverage; migrate all shared-writer consumers consistently if changing that helper. Preserve ordinary numbers and legitimate text. CSV quoting alone does not prevent formulas.
- General accounting/error reports stay apostrophe-protected. Never emit `="00123"` to preserve zeros. Document Excel's “import column as text” workflow for order/tracking/postcode/phone identifiers.
- For provider uploads, a protective apostrophe may become literal data (especially +60 phones). Do not strip it globally or disable safety. Verify whether the actual EasyParcel parser accepts protected strings; if not, use a verified digits-only phone representation where permitted and block formula-dangerous free text with a readiness error. Preserve the original order snapshot. This compatibility is a release gate.
- Inbound may reverse exactly one known protective apostrophe for identity values before bounded validation; reject formula-leading order/tracking values afterward. Never execute or evaluate anything. Render values and errors with textContent; never interpolate into innerHTML.
- Existing integration boundary remains offline; CSV is seller-supplied untrusted data, not authenticated provider evidence. Tenant scope comes from the resolved request, not a CSV shop ID. No new payment/fulfillment/shipment state machines are introduced accidentally.
- Place “Export shipping CSV”, “Download tracking template” and “Import tracking CSV” beside existing accounting export within Sales Order Confirmation, clearly distinct labels. Template/import available to orders.fulfil; shipping export initially Owner-only. Do not replace manual ship.
- Follow product import's native dialog, focus containment/restoration, file input, busy guard, status live region, summary and row diffs. Preview prominently: “Mark N orders SHIPPED. Import only after dispatch; booking/AWB creation alone is not shipment.” Hide/disable commit on any error or zero changes. Show unchanged count and warnings. Changing file resets manifest/preview; expiry/sign-out clears it.
- Show up to 500 rows via bounded client paging, including every error; full CSV error report available. Disable while offline and during pending commit; integrate existing updateguardchange so PWA updates do not interrupt an unresolved mutation. Refresh queue/detail and dispatch ordersdecided once after success. Handle 401 with existing unauthorized flow, 403 permission changes without stale controls, 409 with new preview; preserve exact file in dialog memory for unknown-outcome recovery.
- Do not add notifications as a side effect. Existing reviewed ship path writes order_event but does not enqueue an explicit courier/WhatsApp send there. Any worker that already observes these order events must retain its existing consent/deduplication behavior; verify that in implementation tests instead of assuming CSV is notification-free.

## 7. Test and acceptance plan (future implementation)

No new application behavior was implemented for this research task. These are acceptance scenarios, not claimed passes.

1. Parser: BOM/no BOM, CRLF/LF, embedded commas/quotes/newlines, Unicode, blank records, missing/duplicate/unknown headers, mismatched widths, broken quotes/trailing junk, 500 accepted/501 rejected, exact character/cell/body bounds and escaped JSON. Preserve product-import consumers during parser extraction.
2. Identifiers: leading-zero tracking, long numeric strings, + phone export protection, scientific notation rejected, exact order match not prefix/name/other-shop match, no formulas/HTML execution, safe report including leading whitespace/LF attacks.
3. Preview read-only: realistic 100-order fixture shows correct status/carrier/tracking diffs and revisions; database contents/events unchanged. Duplicate orders mark all occurrences. Every invalid state, unknown order, simulation, erased contact and multi-destination behavior covered.
4. Transaction: commit 100 valid rows changes exactly those orders once, expected revision increments and one actor-correct SHIPPED event each; stock/totals/delivery snapshots unchanged. One invalid row, mid-batch CAS failure or event insertion failure rolls back all rows/events. Repeat on SQLite and PostgreSQL.
5. Concurrency/replay: manual cancel/ship and two overlapping imports between preview and commit; differing assignment loses safely, identical assignment becomes unchanged; lost response then same-file preview/commit, changed quoting/BOM/row order, and delivered-since-import all cause no duplicate events. No date overwrite on replay.
6. Permissions: anonymous 401; all three roles allowed inbound via orders.fulfil; export Owner-only initially; Origin/CSRF failures, revoked session/role changes, quickLogin denial, prefixed-shop isolation, payload limits and no-store/nosniff responses.
7. Export: exact selected set across pagination, revision conflict, missing measurements/state, country/profile mismatch, no fabricated data, server-derived line values, no item/parcel duplication, no changed order state or provider request. Verified template golden fixtures must reflect actual bytes and enumerate state/phone/reference behavior, not inferred headers.
8. UI smoke in actual seller page: 100 fictional confirmed orders → select/export readiness → upload fictional tracking CSV → inspect errors → fix/repreview → commit → refresh/reload → SHIPPED carrier/tracking visible in seller and authorized buyer status; same file shows all unchanged. Exercise keyboard/mobile dialog, 500 rows, authorization expiry and unknown network outcome. Use no live courier calls/charges.
9. Provider contract acceptance is separate: inspect redacted actual MY template/result examples and validate allowed file handling with owner-authorized account evidence. A source-text test or locally generated mock cannot establish EasyParcel acceptance. Do not create a paid booking without explicit authorization.

Implementation verification should run relevant focused tests, `npm run check`, full suite using repository instructions and PostgreSQL coverage, plus the actual UI smoke. Update `docs/API.md`, `docs/threat-model.md` and relevant user documentation with implemented limits and privacy/role controls. Never report those future checks as run by this design task.

## 8. Small omp jobs, explicit dependencies

Each job must deliver its named slice end-to-end with its tests, exercised runtime path and docs; no placeholders or speculative provider success.

1. **Contract evidence job (no paid operation):** obtain authorized redacted current MY single-sender template and result-file example; record exact headers, required markers, enumeration/state/phone formats, reference round trip, multi-item layout and actual limit. If result export unavailable, deliver a firm product decision/manual-conversion specification instead of a fabricated adapter. Resolve multi-destination acceptance gate with owner. This gates the EasyParcel-compatible exporter, not generic import work.
2. **Tracking import service/API:** shared parser extraction with all existing product-import callers migrated, strict shipping parse, 500-row planner, error report data, revision manifest, transaction-joining shipping helper reused by manual ship, atomic import API and role/CSRF/tenant tests; document contract. No provider dependencies, no schema migration for optional declared date.
3. **Seller import UI:** complete accessible template/upload/preview/errors/commit/recovery flow on Sales Order Confirmation using job 2, capability gates, localization following current UI conventions, update guard and live browser smoke with 100 and 500 fictional rows. Generic tracking import is then usable, accurately described as shop format.
4. **Verified MY outbound export:** after job 1, implement exact integration-boundary CSV profile, source extraction, transient packing/readiness inputs and selected-set export API/UI. Block unverified mixed-item semantics; do not ship a fake compatible format. Exercise file export against evidence-backed fixtures and seller UI; preserve accounting export. If multi-destination exclusion is not approved, job 5 must precede this job and corresponding inbound support.
5. **Delivery-level shipment support, only if required:** separate design/implementation jobs for shipment-per-delivery schema (SQLite/Postgres migrations and compatibility tests), CAS/event semantics and aggregate order status, then CSV/UI cutover. One tracking field cannot represent multiple independently shipped parcels; this is not a small conditional in the importer. Split schema/domain and UI/CSV integration into separate omp jobs once the required model is approved.
6. **Provider result mapping:** only once actual results exist, add a fixed, versioned EasyParcel result-to-shop normalization profile behind the integration boundary and expose source choice in import UI. Verify reference/carrier/AWB retention; remove manual conversion instructions only after demonstrated round trip. No broad fuzzy-column mapper, API or extra provider adapters.

## 9. Risks, open questions and release gates

Top five:

1. **Unverified file contract and return channel.** Exact EasyParcel headers and tracking result CSV are unconfirmed; E7 is not a result-export guide. Gate “EasyParcel compatible/round trip” claims on real redacted examples.
2. **Order versus parcel cardinality.** Existing orders support multiple destinations and possibly mixed items but only one tracking pair. Owner must accept an explicit initial rejection policy or fund delivery-level shipment work first. A single destination can still require several packages; initial packing UI must explicitly assert one parcel, otherwise reject.
3. **Booked does not mean shipped.** An AWB allocated after payment can precede physical dispatch; bulk import advances order status irreversibly through today's manual state machine. Require dispatch attestation and preserve real audit time.
4. **PII and spreadsheet corruption/injection.** Exported recipient addresses leave the tenant boundary; phones/postcodes/tracking can lose prefixes/zeros, and protection may break the courier parser. Owner-only export, minimal fields, no retention/logging and tested provider-safe representation are required.
5. **Concurrent/manual assignment conflicts.** Preview alone does not lock orders; use revision assertions and transactional CAS/events. Current manual path has no global tracking uniqueness, so importer-only reuse checks cannot promise universal uniqueness.

Other open decisions: actual MY state vocabulary/aliases and phone token format; mixed-product item layout versus parcel count; HS-code requirements by service; value precision/insurance exclusions; result Reference length/normalization; should Managers/Staff export full shipping PII; whether a declared shipped date needs queryable storage rather than audit reason; definition of one package when an order needs split fulfillment; notification impact from existing event observers; no live portal sample available in public evidence. Keep MY domestic and SG/cross-border release criteria separate. Current marketing limits conflict with help-centre limits, so surface provider-profile limits rather than hardcode a universal 100/300/1,000 assumption.

## 10. Verification performed for this research

Read the requested repository source/UI/API/threat-model files and supporting checkout/settings/store contracts. Fetched primary public MY/SG documentation and Ninja SG comparison. No repo edits, git writes, installations, server launches, DB writes or non-research network calls.

Read-only local runtime smoke: invoked Node importing the existing `parseCsv`, `toCsv` and `can` functions, using fictional rows only. Observed a BOM/CRLF CSV round trip retaining `001234567890`, quoted comma field `a,b`, and protective apostrophes for `=BAD` / `+60123456789`; observed orders.fulfil true for OWNER/MANAGER/STAFF and data.export true only for OWNER. This proves helper behavior only, not a new importer, browser workflow or EasyParcel compatibility. No application test suite or paid/provider workflow was run.
