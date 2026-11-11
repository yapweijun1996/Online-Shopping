# Seller layout conventions

Shared layout values live in `public/shop/tokens.css`. Seller page gutters, top/bottom clearance and card padding consume these tokens; `commerce.css` must not redefine main-page padding.

Settings surfaces and Company settings tabs align with the available content area. Forms can use `--ui-form-max` independently of their containing surface. List filters can use the full surface and wrap on smaller screens. Card corners use `--ui-radius-md`; card padding uses `--ui-card-padding` with a compact-screen override.

AI Studio has one root layout definition. Budget settings and analytics appear side by side above 1200px and stack below that width. Metric text uses explicit margins and gaps. Unknown-only usage is displayed as unknown in both summary and metric cards; estimated amounts are not invoices.

Verification uses synthetic local seller data. Check Dashboard, Products, AI Studio, Orders, Confirmations, Audit log, Category codes, Product options, Team and Company settings at 390, 1440 and 1920px. Also run the opt-in Playwright budget tests for saving, palette switching, draft retention and unknown-cost rendering. These checks do not establish production authenticated-state behavior or every populated workflow.
