# Seller category codes: implementation handoff

## Proposal

Three standalone viewport illustrations are provided for 1440×900 desktop, 820×900 tablet, and 390×844 phone. They retain the 248 px desktop navigation rail, the responsive drawer shell, teal palette, page heading, and categories card.

- Desktop: keep each category in one aligned row. Reserve readable width for the immutable code, then show the editable display name, availability checkbox, and row Save in a stable left-to-right sequence.
- Tablet: place the immutable code on its own first line. Put the editable name below it and group availability with Save on the same action line. This prevents long codes such as `ODOR_CONTROL` and `UI_QA_CATEGORY` from splitting mid-token while avoiding competition with the actions.
- Phone: use a vertical card per category: code, full-width name field, then availability and Save. Stack the create form as Code, Display name, Add category.

All labels and sample values are synthetic examples already present in the supplied screenshots. The illustrations show several existing categories, including both long codes, and retain the per-row Save interaction.

## Behavior and states

Keep the creation form's required Code and Display name fields and Add category action. Codes stay immutable after creation. Each existing row edits only its display name and whether it is available for new products. Save applies that row's changes. Deactivating a category only removes it from new product choices; it does not delete associated products. Do not add delete, bulk edit, counts, analytics, or new data.

Keep controls at least 44 px high/wide, with a visible keyboard focus ring and explicit labels. Use `min-width: 0`, wrapping for translated text and long code tokens, and responsive row stacking so all seven supported locales can wrap without horizontal overflow. The code should remain readable (allow a line break at underscores if needed, rather than arbitrary mid-token splitting).

The current categories mount flow loads asynchronously. While loading, expose a concise loading status in the existing live status area. For a successful empty response, show a clear empty message while keeping category creation available; do not fabricate sample records. On load or save failure, retain the existing error feedback and allow recovery/retry according to the established page pattern. On successful create or row save, keep the existing saved feedback, then refresh the list. Keep the status region announced with `role="status"` and preserve error styling.

## Self-review

- [x] Creation inputs and Add category remain visible at all three widths.
- [x] Existing category rows show fixed codes, editable names, availability, and individual Save actions.
- [x] Long codes are included in tablet and phone proposals with dedicated code space.
- [x] Desktop 248 px rail and tablet/phone topbar drawer shell are represented.
- [x] Touch targets are drawn at 44 px or larger; status messaging and focus treatment are called out for implementation.
- [x] No delete, bulk operation, analytics, counts, APIs, or invented category data are proposed.
- [ ] These files are visual handoff artifacts only; application implementation and browser verification remain outside this task.
