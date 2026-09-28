# Seller dashboard proposal (v67)

The three standalone SVGs in this folder show desktop (1440 × 900), tablet (820 × 900), and mobile (390 × 844) anchors. They are illustrations using local synthetic Demo data, not screenshots of a running build. The existing Seller portal colors, type, cards, header, sidebar/drawer, shop name, mode labels, and route names remain the visual and interaction baseline.

## User and job

The primary user is a seller beginning a work session. Their first question is what needs attention; their next step is to review a submitted order. Keep the dashboard focused on that task, with recent products as secondary context. Success means a seller can identify a submitted order and reach the existing Sales Order Confirmation view without scanning redundant navigation buttons.

## Proposed structure

- Keep the existing page heading and shop identity. Show the shop mode as a text label: Demo is explicitly marked as simulated; Production is labeled Production.
- Make “Submitted orders” the primary panel. Show a short list of order number, submitted status, individual total, and submission time. Use one prominent “Review orders” action to open the existing #review route.
- Show a compact “Recent products” panel with product name and SKU, plus a “View products” action to #products.
- Keep the current sidebar/drawer as the only persistent navigation. Do not repeat it as large dashboard buttons.
- Do not show aggregate order counts, revenue summaries, conversion, inventory totals, charts, or buyer names/contact data.

## Data contract and behavior

Use the authenticated Seller endpoints already present:

- GET /api/v1/seller/setup returns { mode, shopName }. If mode is empty, preserve the unconfigured shop flow and show the existing setup action to #company; do not request order or product previews.
- For a configured shop, request GET /api/v1/seller/orders?status=SUBMITTED&limit=3 and GET /api/v1/seller/products?limit=3. The list APIs return items and nextOffset, not exact totals. The order summary exposes fields such as id, orderNo, status, currency, totalMinor, submittedAt, updatedAt, and simulation; product items include identity/name/SKU and catalog fields. Render only the returned rows.
- Format individual order amounts and dates with the shared formatMoney and formatDate helpers. Keep order status as text beside its color/icon cue. In Demo, retain the simulated label and the existing warning that demo orders do not contact buyers, take payment, or arrange delivery. In Production, do not show a simulation label.
- Keep the existing route names: dashboard, products, orders, review, categories, and company. The preview CTA targets the existing review view; the full order list remains available from the existing navigation.
- Add all new interface strings to all seven supported locales: English, Malay, Simplified Chinese, Vietnamese, Thai, Japanese, and Korean.

## Loading, empty, and error states

- While setup loads, show a short skeleton or “Loading shop…” status without treating missing data as an empty queue.
- After setup, load orders and products independently so one panel can still render if the other request fails.
- Empty orders: “No submitted orders to review” with a low-emphasis link to Sales Orders. Do not display a zero as if it were a complete total.
- Empty products: “No products yet” with an “Add a product” action to the existing Products view.
- A failed panel shows a concise cause and a “Try again” button that retries only that endpoint. Keep successful content visible if its sibling request fails.
- A 401 follows the current session-expired path back to sign-in. A setup failure has its own retry action.
- Keep error and loading messages visible in normal reading order and expose asynchronous status changes through a polite live region.

## Responsive and keyboard behavior

- At 1440 px, keep the 248 px persistent sidebar and place the order panel beside the narrower product panel in the remaining workspace.
- At 820 px, use the existing top bar and drawer navigation, then use the full-width work area. Stack the order and product panels when two columns would make rows cramped.
- At 390 px, keep the shop/mode line compact, put the order task and full-width primary action near the top, and let long names/order IDs wrap. The task and action fit in the initial viewport without large decorative charts or metric cards.
- At every width, prevent horizontal overflow and keep interactive controls at least 44 px high. Preserve visible focus, the existing drawer close/escape behavior, and a logical focus sequence from page title to order action, product action, then the persistent navigation.
- Use one h1 for Dashboard, h2 headings for the two panels, semantic lists for rows, and descriptive accessible names for actions. Do not use color alone to communicate Demo, Submitted, loading, or errors.

## Self-review and evidence-based critique

The before anchors show one shop card with three competing navigation buttons and a large blank work area. The current renderDashboard fetches setup only, while the existing API can provide bounded recent orders and products. The proposal uses that space for one high-priority task and one secondary preview; it avoids dashboard metrics because neither list endpoint supplies exact totals.

The GOV.UK task-list guidance recommends grouping related work and making status visible, while reserving a full multi-task checklist for longer transactions. This design applies the grouping and clear-status ideas to a short order queue rather than adding a separate checklist. Carbon recommends pairing status cues with text and limiting unnecessary indicators; the order rows therefore keep a readable “Submitted” label beside a restrained cue. NN/g explains that dashboards should communicate important information quickly and that position/length work well for quantitative comparisons. Since this API exposes no aggregate series or totals, the proposal gives the order task visual priority and omits invented charts.

References:

- [GOV.UK: Complete multiple tasks](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/)
- [Carbon: Status indicator pattern](https://carbondesignsystem.com/patterns/status-indicator-pattern/)
- [NN/g: Dashboards and preattentive processing](https://www.nngroup.com/articles/dashboards-preattentive/)

## Lifecycle and review

The three before screenshots remain separate anchors; each proposal is a separate responsive artifact. The self-review checked user purpose, priority order, use of the existing shell, 820 px drawer behavior, 390 px first-screen task/action visibility, minimum control height, text labels for status, and data truthfulness. KB-MCP retrieval was attempted for the named ui:visual-design-lifecycle record, but the environment rejected the read because its approval policy is set to never; this handoff follows the lifecycle checks stated in the request.
