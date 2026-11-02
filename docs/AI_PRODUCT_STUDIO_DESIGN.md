# AI Product Studio: per-seller OpenAI key, photo to draft product

Status: DESIGN, not implemented. Owner decisions (2026-11-02): provider OpenAI; key stored encrypted in the shop database; version 1 stops at drafts.

## Goal

A seller uploads one product photo. The server uses **that shop's own OpenAI API key** to (1) read the photo and suggest the product details, and (2) generate several styled product images. Everything is saved as an unpublished product (`product.active = 0`). The seller reviews, edits and publishes; nothing goes live automatically and the model never sets a price.

## Flow

1. Owner opens **Settings > AI Studio**, pastes an OpenAI key. The server validates it with one cheap read-only call, seals it, and returns only `{ configured, last4 }`. Owner can replace or delete it.
2. Seller chooses **New product from photo** and selects an image (PNG/JPEG/WebP).
3. `POST /api/v1/seller/ai-studio/analyze` (image, no key in the request) returns suggested `name`, `description`, `category` (one of the shop's active category codes) and `tags`. Price, stock and SKU stay blank for the seller.
4. Seller edits the suggestion and confirms. The server creates the product with `active = 0` and stores the original photo as its main image.
5. `POST /api/v1/seller/ai-studio/products/:id/images` with `styles[]` (studio, hero, lifestyle, flat_lay, macro, ugc, billboard; max 7). Each style is an **independent job**: its own call, its own result, its own failure. Results are added to the product gallery as draft images the seller can keep or delete.
6. Seller publishes the product through the existing product screen.

## Key custody

- New table `ai_studio_credential` (single row): `provider`, `sealed` BLOB, `key_id`, `last4`, `revision`, `updated_at`. Sealing uses `src/secret-box.js` (AES-256-GCM, master key from the `INTEGRATION_KEY_FILE` Docker secret) with context `AI_STUDIO:OPENAI:<shop>` so a sealed value cannot be moved to another shop.
- Only the Owner role can save, replace or delete. Manager and Staff can use the feature when a key exists but never see it.
- The key is decrypted only inside the backend for the duration of one outbound request. It never appears in responses, logs, audit rows, error messages or the browser after the first submit. Responses use `Cache-Control: no-store`.
- The key is restricted to `https://api.openai.com`; no redirects, fixed host, 60 s per call, bounded response size.

## Safety and honesty rules

- **Drafts only.** No automatic publish, price or stock changes. Description and category are suggestions; category must be an active existing code (re-validated server side).
- **Image text is untrusted.** The photo can contain instructions. The model output is parsed against a strict JSON schema and every field is length-limited and plain text; HTML is never rendered.
- **Brand fidelity is not guaranteed.** An image edit prompt cannot promise exact logos or label text. Generated images are marked AI-generated in the seller UI and must be reviewed; the original photo always stays as the first gallery image. This matches the open fidelity gap in the PWA-AI-Product-Image-Studio-BYOK project (BUG-007).
- **Cost control.** The seller pays through their own key. The UI shows how many billable calls a request will make before it runs. A per-shop daily call cap (default 20, Owner adjustable) is enforced server side; usage is stored in `ai_studio_usage` (day, actor, kind, outcome, counts). Estimates are not the provider invoice.
- **No automatic retry of an ambiguous (timeout) image call**, because it may already have been billed. The seller retries explicitly.
- Rate limits reuse the existing seller limiter. Audit rows record actor and action, never prompts, images or the key.

## Agent review (automatic QA of generated images)

Owner decision (2026-11-02): an agent should review the output itself before a person looks at it.

- After each generated image the server makes one more vision call with the **same seller key**: it receives the original photo and the generated image and returns a strict JSON verdict `{ verdict: pass | warn | fail, issues[] }` covering product shape, colour, logo and label text legibility, invented brand marks, extra or missing objects and obvious artefacts.
- The verdict is **advisory**. It never approves, publishes or deletes anything; a warn or fail only shows a badge and the reasons next to the image. A person still decides. A model checking a model cannot prove label fidelity (open gap BUG-007 in PWA-AI-Product-Image-Studio-BYOK), so the original photo stays first in the gallery.
- It counts as a billable call. The pre-run summary shows "N images + N reviews" and the daily cap counts both.
- A failed or ambiguous review leaves the image unreviewed; it does not block the image.
- Codex subscription OAuth, OMP and Pi are **not** used at runtime. A subscription login belongs to one person's account; using it on a server for many sellers mixes accounts, usage and billing. Runtime uses each seller's own API key. A later optional reviewer provider (for example a host-level key) can be added behind the same interface.
- During development the same idea applies to code: every step gets an independent read-only review by a second agent (Codex today; OMP/Pi once their OAuth login is done on the VM) and a person-visible result before merge.

## Data and limits

- Gallery and main images are limited to 512 KB each (`src/product-image.js`). Generated images must be requested as compressed WebP/JPEG at a size that fits; a result over the limit is rejected as a failed job, not silently truncated.
- Uploaded source photo: same 512 KB limit in version 1 (the browser downsizes before upload).

## Deployment impact (important)

The new tables raise the schema from 28 to 29. On the GCP deployment the automatic updater swaps images only; it does not run schema upgrades, and a release whose schema is newer than the database fails readiness. Release therefore needs the manual path used for platform activation: stop the timer, verified private cluster backup (default, platform and every tenant), restore-tested, coordinated upgrade including tenant schemas via `scripts/upgrade-platform.mjs`, readiness check, then save the new updater baseline. Failure restores from the backup. This must be rehearsed on a disposable copy first.

## Verification plan

- Unit tests with a local fake OpenAI server: success, refusal, timeout, oversize body, redirect, malformed JSON, prompt-injection text in the photo description, key never present in any response or log line.
- Authorization tests: Owner-only key management; Manager/Staff can run jobs but cannot read or change the key; tenant A cannot use tenant B's key.
- Browser test (Playwright, 375 px phone and desktop): upload, review suggestion, draft product, seven independent jobs with one forced failure, delete a generated image, publish.
- Real-provider acceptance is done by the owner with their own key on one fictional product; the agent never receives a real key.
- **REQUIRES VERIFICATION before coding:** current OpenAI endpoint names, model ids, image-edit parameters, output formats and limits (read the vendor docs on the implementation date).

## Out of scope for version 1

Auto-publish, bulk photo batches, price suggestions, Anthropic provider, WhatsApp-triggered generation, background queue worker.

## Task breakdown

1. Provider client + fake server tests (verify vendor docs first).
2. Schema 29 (`ai_studio_credential`, `ai_studio_usage`) for SQLite and PostgreSQL, import/readiness lists, tenant upgrade path.
3. Key custody API and Owner settings tab.
4. Analyze endpoint and draft product creation.
5. Seven-style image jobs and gallery integration.
6. Seller UI (phone first), translations for the seven seller languages, accessibility.
7. Manual release rehearsal and production release with backup and rollback.
