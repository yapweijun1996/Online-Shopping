# AI Studio page replacement regression

## Failure

Entering AI Studio from Dashboard changed the URL, heading and active navigation item but retained the Dashboard above the AI Studio content. `mountAiStudio` appended its page to the shared workspace; the Dashboard is not represented by a disposable page controller and was therefore still present.

## Bounded fix

AI Studio now replaces the workspace children when mounting, matching its role as a complete page. Disposal still removes only its own page. No authentication, authorization, AI provider call, credential, billing, product mutation or database behavior changes. Seller APP_VERSION and worker cache version advance together from v153 to v154 so installed clients can receive the asset fix through the existing user-controlled update flow.

## Evidence

`test/ai-studio-navigation-browser.test.js` uses the real local Seller app and SQLite fixture with synthetic login. Only the AI Studio availability GET is stubbed, and external requests are blocked. At 375px and 1280px, the original code failed because one prior `.dashboard-home` remained. The same checks pass after the change, including Dashboard → AI Studio → Dashboard, repeated visits, direct authenticated deep links and reloads, single-page ownership, navigation state, uncaught JavaScript page errors and horizontal overflow.

The existing AI Studio browser test also passes its key handling, photo-to-draft, styled-image errors, language and layout checks using simulated provider responses. No real OpenAI key or paid provider call is involved. These are local fixture checks, not a live production account test or real-device iOS certification. Existing manifest, offline data scope, update prompt/loader, activation controls and system-chrome styling are unchanged.
