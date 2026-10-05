# Product image viewer gestures

The product page retains normal scrolling and browser pinch zoom. Opening the image viewer enables custom gestures only on its image stage:

- An unmodified vertical mouse wheel or trackpad scroll zooms between 100% fit and 400%, centered on the cursor. Pixel, line and page wheel deltas are normalized and capped per event.
- Two touch pointers zoom around their midpoint. Moving that midpoint pans the magnified image. A single pointer drags the magnified image; pan limits use the fitted image pixels, including landscape/portrait letterboxing.
- A horizontal single-pointer swipe changes photos only when the entire gesture starts and ends at fit scale. A pinch or pan cannot turn into photo navigation when fingers lift or scale returns to fit.
- Double-tap toggles fit/250%. The accessible Zoom in, Zoom out and Reset zoom buttons remain available. Unmodified `+`, `=`, `-`, `0` and `Home` zoom or fit; arrow keys pan when magnified and navigate photos at fit.
- Command/Ctrl/Alt-modified keyboard and wheel events remain available to the browser. Trackpad pinches delivered as Ctrl+wheel use browser zoom rather than image zoom. Shift+wheel is also left to the browser.

The gesture session ends on pointer cancellation, lost capture, image change/load/error, resize, blur, hidden document, Close/Escape/Back or product navigation. Reopening fits the current photo. Existing history, selected-photo restoration, focus return and failed-image recovery remain intact. Original gallery pixels, manifests, schema and business logic are unchanged. Shop cache v103 carries the frontend update; Seller cache is unchanged.

## Verification

The exact deployed predecessor `45f3eb53930ca57481e8bef9f5cfc10812b73c68` was reproduced in local Chrome: actual wheel input left the image at 100%; a synthetic Command-plus key event was prevented and magnified the image instead of passing through. It already contained a basic two-pointer pinch implementation; that code alone did not establish reliable physical-phone support.

The browser check at `scripts/gallery-gesture-browser-check.js` uses the isolated local preview on `http://127.0.0.1:3794`, a ten-image response fixture, Playwright mouse/keyboard input and Chrome DevTools Protocol touch input. Run it with an existing Chrome Playwright CLI session:

```sh
playwright-cli -s=gallery-gestures run-code --filename=scripts/gallery-gesture-browser-check.js
```

The fixture changes intercepted local responses only and intentionally includes an image failure. It makes no orders or seller writes. Coverage spans 1440×1000, 820×1180 and 390×844, wheel/pinch bounds and anchors, mouse/touch pan, fit swipe, browser input passthrough, keyboard/buttons/focus, interrupted gestures, repeated open/close, Back/product navigation, resize and error recovery. Automated touch is browser input simulation, not physical hardware. Physical Mac trackpad and iPhone/iPad Safari gestures remain unverified.

Browser event references: [wheel event](https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event), [pointer pinch gestures](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events/Pinch_zoom_gestures), [touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action), [lost pointer capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/lostpointercapture_event).
