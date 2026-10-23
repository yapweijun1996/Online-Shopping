# AI assistant: human-reviewed suggestions

## Architecture and API

Autonomy is **level 1 only**. The assistant neither sends WhatsApp messages nor creates orders. A human reviews the suggested reply and draft; existing send and checkout controls remain independent.

`POST /api/v1/seller/chats/:id/suggestions` accepts an empty JSON object. It uses the existing seller session, exact Origin, CSRF and `chats.reply` capability (Owner, Manager and Staff), including tenant routing. Responses are not cacheable:

- 200: `{ reply, handoff, handoffReason, orderDraft }`.
- 404: host AI disabled or unavailable QR surface.
- 409: `AI_DISABLED` or ineligible suppressed/erased thread.
- 429: `AI_CAP` or `RATE_LIMITED`, with Retry-After.
- 502/504: generic `AI_UNAVAILABLE` / `AI_TIMEOUT`.

`provider.js` calls only Anthropic Messages over HTTPS, refuses redirects, uses a 20-second per-call timeout combined with the agent's 45-second overall deadline, and caps each response at 512 KiB. Requests default to 2000 output tokens and `output_config: { effort: 'low' }`, with strict tool schemas and no forced tool choice or sampling overrides. Text, tool_use, thinking and redacted_thinking blocks are accepted. Thinking blocks are opaque and preserved unchanged in subsequent assistant turns; max_tokens and refusal stop reasons reject partial output. `agent.js` makes at most four calls and validates terminal `submit_suggestion` structure. `createApi` accepts `aiProvider` or `aiFetchImpl` for deterministic testing; production uses the fixed Anthropic provider.

Tools are SELECT-only, parameterized and bounded: active catalog search (8), detail/variants (100), shop policies and notes, and phone-bound order status/item summaries. Stock is qualitative and accounts for pending reservations. Exact inventory and customer contact fields are never returned by tools. Shared QR phone matching checks buyer and recipient hashes and rejects erased contacts. Missing and unauthorized orders both return `{found:false}`.

Order drafts take product names, currencies and prices exclusively from the active catalog, not model output. Unavailable products and missing address/recipient name are listed in `missing`. A draft is not an inventory reservation or a checkout authorization.

## Data and guardrails

The newest 30 nonremoved chat bodies are sent oldest first, at most 1000 characters each, labelled CUSTOMER/SHOP inside a neutralized conversation delimiter. Known display names are reduced to a first name; recognizable phone/masked-number forms are redacted. This is data minimization, not a general-purpose PII detector: arbitrary chat prose can contain personal information. Operators must review provider privacy/retention terms and provide appropriate customer notice before activation.

Customer text and tool strings are untrusted. System instructions require customer-language, brief polite answers; tool-grounded factual claims; and handoff for complaints, refunds, anger, sensitive subjects or unknown answers. Delimiters and prompt instructions are not a security boundary. Server-side tool authorization and price reconstruction remain effective even when a model follows malicious instructions. Human review is required for every reply.

No prompt, tool transcript, model output or draft is stored by this feature. Existing chat storage is unchanged. `ai_usage` stores token counts, UTC day, actor, thread reference and outcome. `ai_suggestion_audit` records actor, thread reference, action and timestamp; settings updates use SETTINGS_UPDATED with an empty thread reference and never log notes or values. Upstream usage observed before a later loop failure is retained; failure before any observed response replaces the reservation with zero actual tokens. Provider-side processing/retention is outside this database guarantee.

Suggestion audit metadata is included in SQLite-to-PostgreSQL import. Readiness rejects an incomplete schema missing the audit table. Schema-28 upgrades grant every new table to the legacy application role; no AI table uses a sequence.

The first short QR seller transaction performs bounded retention (older than 90 days, at most 200 rows per table), settings/level/eligibility checks, SQL limits (6/minute/thread, 40/hour/shop), cap check, a snapshot of the newest 30 messages and a 4000-token ERROR reservation. Limiting precedes cap checks and persistent request accounting. Cap refusals append no metadata. The serialized cap check and reservation prevent concurrent requests from all claiming the remaining allowance; one reservation may cross the cap.

After commit, the provider loop and SELECT-only tools run outside any store transaction or QR session lock. SQLite's queue and PostgreSQL's transaction advisory lock therefore remain available to checkout, order decisions and workers while the provider is pending. A second short store transaction replaces reserved counts/outcome and inserts the accepted-request audit. A process crash leaves the conservative ERROR reservation charged until retention; there is no automatic provider retry.

## Host configuration and custody

`AI_ENABLED` gates host availability. `AI_API_KEY_FILE` points to a backend-readable secret file; `AI_MODEL` selects the Messages model. Never put the key in browser code, database settings, logs or error responses. Shop `ai_setting.enabled` is a separate default-off switch and level zero also disables suggestions. Use the complete unreleased schema 28 before activation, including the suggestion-audit action column. An intermediate development schema-28 database must be brought to the current DDL by an operator before this code is enabled; no released-schema migration is implied.

No deployment manifest is changed by this feature. Levels 2–4 (automatic answers, confirmed order capture, follow-ups) remain unimplemented and are not enabled by the level setting.

## Seller interface

Seller release v152 adds an Owner-only **AI** company-settings tab after the host's settings endpoint reports `available: true`. Missing or unavailable AI never creates a clickable tab. Enablement, tone, business notes and daily token cap save with the loaded revision; conflicts offer to reload and discard edits. AI edits and pending saves participate in the existing navigation guard.

The WhatsApp inbox shows **Suggest reply** only for enabled, available AI and a replyable, unsuppressed, connected thread. Generating a suggestion uses the session/CSRF request helper, not the message-send route. Existing composer text requires confirmation before replacement; text entered during generation requires another confirmation. A thread switch invalidates pending results and clears handoff/order-card state.

Replies remain editable drafts. Handoff reasons and read-only order summaries are localized in all seven seller languages. Order summaries show server catalog prices, totals, recipient/address/notes and missing or unavailable items, with a guarded plain-text clipboard action. No order creation or automatic send control is added. Provider output is rendered only through DOM text nodes; there is no HTML interpretation, inline styling or inline script.

`test/ai-ui.test.js` exercises settings conflicts, availability, overwrite decisions, handoffs, errors, clipboard failures and thread isolation without network access. `test/ai-ui-browser.test.js` is opt-in through `QA_PLAYWRIGHT_MODULE`; it uses the real seller app and local fixture server with stubbed AI responses and checks the 375-pixel inbox path.
