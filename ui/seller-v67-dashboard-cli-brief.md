# Seller dashboard visual anchor brief

Use the attached **real screenshots** from the isolated local Demo Seller PWA v66 at 1440 × 900, 820 × 900, and 390 × 844. Review `public/seller/app.js` (`renderDashboard`), `public/seller/style.css`, and the existing Orders/Products API shapes before proposing the replacement. The primary user is a seller starting a work session. The dashboard must tell them what needs attention and give them a direct next action. The current screen is one shop card with three duplicate navigation buttons and a large blank work area.

Produce **three separate, self-contained visual SVG proposals** in `ui/`:

- `seller-v67-dashboard-proposal-desktop.svg`
- `seller-v67-dashboard-proposal-tablet.svg`
- `seller-v67-dashboard-proposal-mobile.svg`

Also write `ui/seller-v67-dashboard-proposal.md` with a concise implementation spec, realistic data sources, loading/empty/error states, responsive and keyboard behavior, and a brief evidence-based design critique. Do not edit application code, tests, config, or existing artifacts. Do not generate one collage. Mark all visual content as an illustration using local synthetic Demo data.

Constraints:

- Keep the existing Seller portal visual language, sidebar/drawer, route names, seven-language support, and current shop Demo/Production truth. Never show fake live revenue, conversion, inventory, or order counts. The current API can fetch recent products and Submitted orders (`GET /api/v1/seller/products?limit=3`, `GET /api/v1/seller/orders?status=SUBMITTED&limit=3`); it does not return exact totals. A dashboard may show a short actionable order queue and recent product list, with honest empty states. Keep any new data display derived from these real endpoints.
- Make the primary action clear. Avoid repeating the sidebar as three large buttons. Use concise task-oriented content and preserve the configured/unconfigured shop behavior.
- At 390 px, make the order task and primary action visible without excessive vertical decoration; at 820 px, use the full work area under the drawer navigation; at 1440 px, use the main area beside the persistent sidebar. No horizontal overflow. Minimum practical control height 44 px.
- Distinguish Demo simulation from Production; no private buyer contact details in the mockups. Preserve semantic headings, visible focus, and actionable errors.
- Use these design references as pattern guidance, not copied branding: GOV.UK task grouping (https://design-system.service.gov.uk/patterns/complete-multiple-tasks/), Carbon status indicators (https://carbondesignsystem.com/patterns/status-indicator-pattern/), and NN/g dashboard overview principles (https://www.nngroup.com/articles/dashboards-preattentive/).
- Follow the KB-MCP `ui:visual-design-lifecycle` principle: separate anchors, self-review for user purpose, hierarchy, responsive behavior, accessibility, and truthful data. The user has directly authorized implementation based on suitable anchors.
