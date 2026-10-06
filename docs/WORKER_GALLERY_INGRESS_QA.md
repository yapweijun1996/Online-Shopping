# Worker gallery ingress correction — 2026-10-03

Review base: `442fae39d046982122b52c6bee013244e9019184`, containing the
previous five corrective mechanisms. That commit and its review package are
preserved. This additional checkpoint changes only Worker/API request budgeting,
its regressions and this record; UI remains Shop107 / Seller84.

## Failure and repair

The Worker buffered every mutation at one MiB before forwarding to the shop
object. The real API accepts atomic Seller product/gallery PATCH JSON up to
7,500,000 bytes. Two legitimate 512 KiB PNGs encode to 1,398,248 bytes in the
tested request, so ingress returned 413 with zero object calls. Ten encode to
6,991,000 bytes and failed the same way. A passing direct API test could not
establish that the Worker path worked.

`src/request-limits.js` now owns the existing 7,500,000-byte product mutation
API budget. Both API parsing and Worker ingress use that constant. Only PATCH
to the exact `/api/v1/seller/products/<36-character lower-case id>` path gets
the larger Worker budget, matching the API route that carries atomic galleries.
Query strings do not change route identity. Product-create POST, individual
gallery POST, image subpaths, unrelated endpoints, other methods and malformed
paths keep the previous one-MiB ingress. The individual gallery API still has
its stricter 750,000-byte limit. The API's existing product-create parsing budget
is unchanged; its Worker ingress was not broadened.

The existing bounded reader is reused without modification. Declared lengths
over budget are rejected before reading. Missing or dishonest lengths cannot
bypass actual streamed-byte counting. Streaming overflow is cancelled; neither
overflow nor interrupted partial input reaches the object. Content-Length is
removed before forwarding the complete buffered body. API session, origin,
CSRF, JSON and image-ownership validation remain authoritative.

## Exact local verification

Node v24.19.0, one test worker. The regressions execute the actual exported
Worker `fetch` with a synthetic SHOP binding; its fetch delegates to the real
`createApi`, using fresh in-memory SQLite, fictional data and existing API
sessions. This verifies Worker-to-API forwarding and persistence, not a deployed
Cloudflare edge or the actual Durable Object storage engine. No live credentials
or provider calls are used.

| Scenario | Review base | Corrected source |
| --- | --- | --- |
| Two PNGs, each exactly 524,288 bytes; 1,398,248-byte JSON | 413, zero forwarded | 200, one forward; stored bytes exactly match |
| Ten maximum PNGs; 6,991,000-byte JSON | 413, zero forwarded | 200, ten saved; stored bytes exactly match |
| Declared 7,500,000-byte valid JSON | 413 | 200 and actual metadata persisted |
| Declared 7,500,001 bytes | Rejected by old lower limit | 413 before any read or forwarding |
| Exact streamed budget, absent or falsely low Content-Length | 413 | 200, exactly 7,500,000 bytes forwarded |
| Streamed overflow with absent/falsely low length | Old lower limit | 413, stream cancelled, zero additional forwards/writes |
| Thirteen unrelated path/method cases above one MiB | PASS | PASS, 413 before forwarding |
| Unrelated body exactly one MiB | PASS | Forwarded; real API's route response retained |
| Single-gallery body 750,001 bytes | PASS | Forwarded at ingress; real API rejects 413 |
| Missing session / CSRF / wrong origin / invalid JSON / content type / foreign image ID | Premature ingress 413 | Actual API 401/403/403/400/415/400, no product/image writes |
| Interrupted stream | PASS | PASS, no object call or writes |

The maximum PNG fixtures contain a valid ancillary text chunk before IEND with
a correct CRC, rather than arbitrary bytes appended after the PNG. SQLite
returns Uint8Array while fixtures use Buffer; the initial green run's two byte
assertions failed on this type distinction. They were corrected to compare the
same byte representation, preserving exact length and complete-content checks.
That initial harness failure is retained and is not reported as an app defect.

Final focused run: **7/7 PASS**. Before correction: **2 PASS / 5 FAIL**.
Full repository regression: **158/158 PASS**, zero skipped, one worker.
JavaScript syntax and whitespace checks pass. Wrangler 4.145.0 dry-run bundles
the exact Worker source successfully and exits with `--dry-run`; it does not
publish. Cloudflare credential environment variables were removed for this
local bundle check and telemetry was disabled.

Evidence resides in ignored `output/qa/worker-ingress/` and the new Library
review ZIP: raw red/green/full-suite/build/syntax logs, patch, changed source and
head/hash manifest. `npm test` now includes the Worker forwarding regressions.

## Remaining release gates

No push, PR, deploy, production migration, permission/grant change or external
message/payment/shipment was performed. The independent cloud test run was
reported blocked by automatic approval cancellation; these are our actual local
results, not an independent suite pass. Deployed edge behavior still needs an
exact approved-release check. Existing physical iOS, durable production tenant
authorization and backup/restore gates remain open; this fix does not close the
100-criterion inventory or change the separate 18-item MVP denominator.
