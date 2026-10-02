# Seller and Customer color palettes

Seller Company Settings and Customer Account → Settings offer Evergreen Teal, Warm Plum, Ocean Blue, High Contrast Navy and Graphite. Each choice has a scoped Preview and an explicit Apply palette action; preview alone does not persist. Evergreen Teal is the default. The choice is saved in this browser under `online-shopping-shop-palette-v1` and synchronized across tabs. If browser storage is unavailable, the choice applies until the page closes and the UI says it was not saved. Seller preference uses `online-shopping-seller-palette-v1`, independently from Customer. The older [three-palette design comparison](shop-palette-preview.html) is a historical reference; runtime Settings includes all five.

## Decision

**Evergreen Teal remains the default Shop palette.** It preserves the existing brand recognition while strengthening control borders and focus. Warm Plum offers a boutique direction; Ocean Blue offers a more conventional storefront. These are appearance presets, not status themes.

| Preset | Brand / focus | Canvas | Control border | Character |
| --- | --- | --- | --- | --- |
| Evergreen Teal | `#087f83` | `#f5f8fa` | `#8095a0` | Familiar and steady |
| Warm Plum | `#7c426a` | `#fcf8fa` | `#97858e` | Warm and boutique |
| Ocean Blue | `#235e91` | `#f5f8fb` | `#8296a5` | Calm and conventional |
| High Contrast Navy | `#143d70` | `#f4f6f8` | `#52616b` | Strong visual boundaries |
| Graphite | `#364152` | `#f5f5f5` | `#68737e` | Neutral and restrained |

All five keep price and order total at `#a54428`, error at `#aa3946`, success at `#216943`, and the same warning colors. A customer changing a palette must not change what a price, error, or warning means. Text and icons remain alongside status colors.

## Contrast check

The preview computes contrast from the token values. Text pairs use a **4.5:1** target; control borders and focus rings use **3:1** against their sampled surface. The following are the lowest measured ratios among the three presets for each role:

| Pair | Lowest ratio | Target |
| --- | ---: | ---: |
| White on primary button | 4.80:1 | 4.5:1 |
| White on accent button | 4.84:1 | 4.5:1 |
| Body text on surface | 12.75:1 | 4.5:1 |
| Secondary text on surface | 5.16:1 | 4.5:1 |
| Price on surface | 6.07:1 | 4.5:1 |
| Selected label on selected surface | 6.74:1 | 4.5:1 |
| Warning text on warning surface | 6.67:1 | 4.5:1 |
| Error text on surface | 6.21:1 | 4.5:1 |
| Control border on surface | 3.06:1 | 3:1 |
| Focus ring on surface | 4.80:1 | 3:1 |

The automated regression covers all five runtime palettes and text, selected, price, warning, error, control border, and focus pairs. This is a bounded color-pair audit, not a complete accessibility certification. Text baked into product photos cannot be controlled by the palette.

Before Evergreen Teal was applied, the input border `#c9d9df` measured about **1.45:1** against white and the focus color `#42b9b5` measured about **2.38:1**. The selected Shop tokens now give interactive control borders at least 3:1 and focus colors at least 4.8:1 on the sampled surface.

## Ownership and implementation boundary

`public/shop/tokens.css` is the runtime Shop color source of truth. `public/shop/palette.js` owns only the customer-local preference and applies its palette before the stylesheet loads. Interactive Shop borders and focus rings read the tokens. Price and status roles are invariant across presets and retain text labels.

Seller and Customer browser appearance preferences are independent. Seller appearance does not change company branding or data. The customer palette never edits seller settings or order data.

## Regression checks

- Check representative catalog, product detail, cart, checkout, Profile, Settings, dialogs, and update banner in both desktop and mobile layouts.
- Check normal, hover, selected, disabled, error, and keyboard-focus states on their actual backgrounds.
- Recalculate contrast after any token adjustment; retain at least 4.5:1 for ordinary text and 3:1 for required control boundaries and focus indicators.
- Keep explicit error/success/warning words or icons, and do not convey state by color alone.
- Confirm that changing the palette affects presentation only and preserves cart, Profile, addresses, and order flow.
