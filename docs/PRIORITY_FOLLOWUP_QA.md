# Bounded corrective QA checkpoint — 2026-10-03

This independent local branch starts at the frozen review commit
`46977c2670daad45369aefdd3aa68943e5ce595c`. The original worktree remains clean
at that commit. The candidate identifies itself as Shop v107 / Seller v84;
neither version has been published. No remote branch, PR, production migration,
credential, grant, real message, payment or shipment was created.

## Five reviewer findings corrected

1. **Legacy gallery overflow:** schema-11 uploads remain authoritative. At
   0/1/4 uploads the untouched preview collection contains 6/7/10 images; at
   5/9 uploads it contains main plus all stored uploads, 6/10 images. Five
   additional immutable reference images are offered separately for explicit
   selection. Existing upload IDs, bytes, positions and timestamps survive
   migration and metadata saving. No automatic image deletion or price/order
   conversion is introduced. Selecting more than ten images is rejected.
2. **Cover read amplification:** lists and variant covers resolve the chosen
   image using layout and upload metadata, with no image BLOB reads. Detail
   reads no gallery BLOBs. Public preview detail may read its one hero BLOB to
   verify provenance before offering immutable references, including after a
   product-name edit; this is not a zero-byte detail-read claim.
3. **Failed save baseline:** main removal and the desired gallery are validated
   and committed in the same transaction. Rejected saves preserve all draft
   fields, gallery order, pending image removal and the original baseline.
   Retry sends changed price and availability instead of treating them as
   already saved. Stale revision conflicts retain Stay/Discard protection.
4. **Legacy image-only PATCH:** restoring a hidden main makes that replacement
   visible. An existing chosen primary/order is retained and main is appended.
   A ten-image collection rejects overflow and rolls back the replacement.
5. **Late detail response:** a successful PATCH already returns a complete
   detail DTO, so the redundant GET was removed. Initial editor reads use a
   request generation and revision check; only gallery descriptors join their
   baseline, leaving metadata typed while loading dirty.

## Reproduction and verification

Node v24.19.0, one Node test worker, cached headless Chromium, fresh in-memory
SQLite and fictional data on loopback. Browser outbound requests are blocked.
Evidence is retained under ignored `output/qa/followup/` and in the review ZIP.

| Evidence | Frozen review base | Corrective candidate |
| --- | --- | --- |
| Four added API/model regressions | Four FAIL; original five PASS | Nine focused tests PASS within full suite |
| 400 image error / complete draft retry | FAIL: old gallery restored | PASS: all fields and empty gallery actually saved |
| 409 stale revision / Stay and Discard | PASS | PASS |
| Save, type new fields, delayed detail response | FAIL: later state overwritten | PASS: zero redundant GET; newer name/description/price/availability persist |
| Full repository test command | Previously recorded separately | 151/151 PASS, zero skipped |
| Syntax and whitespace | Frozen separately | JavaScript syntax and git diff checks PASS |

The first green browser harness incorrectly waited for a success message after
typing had cleared an already completed save. Its wait was corrected to depend
on an actually held legacy GET. The same draft and navigation postconditions
remain required; the final three-case run passes without weakening them.

Additional completed browser evidence comes from the intermediate follow-up
tree before the final version bump: 12 named cases, including gallery
primary/reorder/remove/cancel/retry/ten-image checks and seven actual locales at
320/390/430/768/1280 px. This is not a complete final-head all-route audit.
The JSON retains exact viewport rows and screenshots. Controlled visible copy
is neutral; technical DEMO identifiers and truthful preview limitations remain.

Configured Chat is an anchor with `href=https://wa.me/60123456789`, `_blank`,
`noopener` and its accessible availability label. Its actual click destination
was captured with navigation prevented before dispatch. Unconfigured Chat is
an enabled explanatory button, not a disabled native button: no href, an
unconfigured aria label, and a click notice. Both produced zero outbound
requests. Screenshots alone do not prove this state difference.

Two actual A4 PDFs (summary and packing, two pages each) and seven-locale HTML
fragments were saved. Self-contained HTML was reopened in Chromium. PDF bytes
were reopened using Poppler; extracted text and rendered pixels retain ALPHA
and BETA on separate pages, quantity two per destination, MYR 18.00 subtotals
and MYR 36.00 summary total. Preview/no-payment and manual-packing notices
remain. Headless saving does not verify a physical OS Save-as-PDF interaction.
The document source is unchanged by this corrective patch. Long-row pagination
and additional status combinations are deferred at the requested checkpoint.

## Full frozen source handoff

The exact 46977c2 source ZIP contains all 858 tracked files and every static
image asset, with no tracked-file exclusions. Packaging notes are outside the
source subtree. Untracked databases, credentials and Git history are excluded.
Its SHA-256 is
`e52e8f59fe9382ae902419bd2a0e96bf1f5bb6aef5e64de709e0aa14c0e65cca`.
All three parts and restore instructions are saved in Library:

| File | Library ID |
| --- | --- |
| `Online-Shopping-full-source-46977c2.zip.part01` | `libfile_14c9360bee7481918580aa5c778248a5` |
| `Online-Shopping-full-source-46977c2.zip.part02` | `libfile_20b71251c4448191ac691e9b31255a19` |
| `Online-Shopping-full-source-46977c2.zip.part03` | `libfile_2ae162e982048191aaa81b0469750ddc` |
| `Full-source-46977c2-restore.txt` | `libfile_698bba9180ac8191b1100b304db19e87` |

Concatenate part01, part02 and part03 in order, verify the SHA-256 and unzip.
The corrective ZIP contains the complete binary patch from that frozen source,
changed source files, scripts, this record, evidence and exact head manifest.
Applying that patch to the source subtree reconstructs the corrective tree.

## Open acceptance and release gates

The fixed 100-criterion inventory remains authoritative. The accompanying
`acceptance-scoped.json` attaches evidence without inferring 100/100 from test
counts or viewport rows. Prior intermediate evidence is explicitly labelled;
unverified criteria remain open. The original 18 MVP denominator is separate,
and payment/courier automation remains outside that existing MVP.

No exact deployed candidate verification, installed physical iOS PWA cycle,
live provider acceptance, production principal/tenant enforcement, production
backup restore or operational recovery has been performed. Submitted-order
cancellation remains an existing product/contract gap. The synthetic Admin
model is not production tenant authorization.

Schema 12 is not compatible with the schema-11 binary's startup guard. A
binary-only rollback after migration is unsafe. A reviewed release must provide
an authorized, quiesced pre-migration database backup (including any SQLite WAL
handling), proven restoration and old-binary startup, or a reviewed compatible
forward fix. No production migration or production restore is authorized here;
the local backup/restore drill is also deferred and cannot satisfy criterion 100.
No invitations or production-ready claim are issued.
