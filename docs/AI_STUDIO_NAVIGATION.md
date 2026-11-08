# AI Studio task tabs

AI Studio defaults to Create Product, with Generate Images and Settings as separate accessible tab panels. The connection and daily usage summary stays visible. Tab switches retain mounted inputs, the photo, drafts, the chosen product and generated results, including during an outstanding request. Arrow keys and Home/End move between tabs. Routes `#aistudio/tab/create`, `#aistudio/tab/images` and `#aistudio/tab/settings` restore the selected panel after reload; no credentials or draft values enter the URL.

Settings keeps the saved-key editor collapsed and exposes add/replace, remove and daily cap editing only to the Owner. Missing or unavailable configuration has a visible settings entry and disables AI actions. Published products cannot start image generation. Existing backend permission checks and provider behavior are unchanged. Saving a draft moves to Generate Images; leaving the page with a photo or edited fields invokes the existing unsaved-change guard.

Validation uses isolated seller fixtures and intercepted synthetic provider responses. No production key or paid AI request is needed. `test/ai-studio-ui-browser.test.js` covers the photo/draft/image workflow, draft and in-flight preservation, language, keyboard navigation, deep-link reload, responsive overflow, setup states and non-Owner presentation.
