# Seller P1: product editing and AI Studio

## Product editor

- Unlimited stock is an explicit mode of the existing nullable stock contract. Zero is finite out-of-stock inventory. Finite blank, negative, fractional and over-limit quantities cannot be submitted. Changing mode preserves the last finite entry.
- The existing form snapshot remains the only dirty baseline. Its effective stock value and numeric-input mode distinguish unlimited from a finite blank; returning to baseline clears dirty state. Gallery/detail responses retain their existing route ownership and gallery-only baseline protection.
- One sticky action bar reports unchanged, unsaved, saving, saved, busy or error state. Saved is displayed only after a confirmed write; failures preserve edits. Duplicate submissions remain blocked. Back and Cancel use the existing discard/navigation guards. Safe-area padding and field scroll margins keep controls usable at narrow and reduced-height viewports.
- Group, option label and SKU have one explanation/example. The existing related-variant panel and guarded variant navigation remain authoritative. Category is separate. Information/pricing columns are balanced, description is taller, price shows its actual currency and the named read-only currency input remains intact. Collapsed history follows primary content.

## AI Studio

- Create Product and Generate Images are mounted, keyboard-operated task tabs. Arrow keys and Home/End use roving tab focus; only the active panel is exposed. Switching tasks preserves the photo, suggestions, search, selected product, styles and results.
- Each task has three guidance steps derived from its actual input/result state. At desktop widths its input and review/output panes share the available workspace; narrow widths stack them. The source photo is decoded and prepared by the existing shrinkPhoto validation, not a decorative placeholder.
- Choose is a native button. File selection and dropping use the same latest-intent preparation path. Replace and Remove confirm before discarding editable suggestions. Filenames, preview, format/size guidance and visible disabled reasons accompany the actions.
- Suggestions remain editable and save through the unchanged product API as unpublished drafts. Saving locks source/fields against competing submissions. A confirmed draft offers separate Edit and Create images actions; neither task switching nor saving automatically spends image calls.
- Image search is bounded and newest-response-owned. Selected identity includes SKU when available. Existing styles are explicit checkboxes. A running batch locks target/style changes, captures its product, retains successful results on errors and preserves existing stop-on-uncertain-outcome behavior.
- The service is authoritative for availability, key state and daily call usage. No remaining allowance is invented during loading. Analysis estimates one call; image estimates retain one generation plus one review per style. Even ignored stale analysis responses refresh server accounting. Server budget/security enforcement is unchanged.
- Key/cap controls are secondary native details with the existing Owner-only controls and secret clearing. No API, schema, provider, authentication, publication or accounting-policy changes.

## Localization and offline delivery

Changing language retains actual completed/error result states and translates result badges and preview labels. New copy has English, Malay, Simplified Chinese, Vietnamese, Thai, Japanese and Korean entries with equivalent placeholders. Seller APP_VERSION and cache version are v158. Seller-only p1.css avoids changing the styles symlinked into the Platform shell; p1.css and p1-copy.js are precached. Platform and Shop assets/versions remain unchanged. The single top-bar Update action and explicit, guarded activation remain unchanged.

## Verification and limits

New Chrome tests use a real local application and fictional SQLite products, with deterministic simulated AI responses and external origins blocked. Full regression also enables the existing PostgreSQL suite. Coverage includes inventory modes/zero/invalid/reversion, save errors and dirty state, actual sticky geometry/focus/overflow at 375/768/1440 and reduced height, real siblings/discard guards, delayed detail races, tabs/keyboard, choose/drop/preview/replace/remove, retained drafts, selection/search races, captured image targets, unavailable/key/budget reasons, stale-analysis accounting, locales and deterministic screenshots. Existing API, policy, security, image partial-failure, PWA and root-replacement assertions are retained.

Commands on the assigned Pomelo host use the owner-provided `.local/ux-task/run-command.py` wrapper, which supplies the verified runtime and test environment. Evidence, RED/GREEN/full logs, exact counts and the screenshot manifest are listed in `.local/ux-task/SUMMARY.md`.

These are browser-emulated viewport/keyboard checks, not physical-device virtual-keyboard or screen-reader certification. AI endpoints are simulated; no paid provider calls, production sign-in, GCP operations or deployment were performed. No WCAG compliance claim is made.
