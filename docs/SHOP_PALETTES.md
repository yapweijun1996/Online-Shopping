# Shop, Seller and Platform color palettes

Shop Account → Settings and Seller Company Settings offer ten color presets.
Selecting a radio option applies it immediately. The Preview button opens a
sample in the current light or dark mode. Use Apply palette to commit that
preview, or close it to keep the current choice.

| Preset | Palette ID |
| --- | --- |
| Evergreen Teal (default) | `evergreen-teal` |
| Warm Plum | `warm-plum` |
| Ocean Blue | `ocean-blue` |
| Navy + Orange | `navy-orange` |
| High Contrast Navy | `high-contrast` |
| Graphite | `graphite` |
| Indigo | `indigo` |
| Emerald | `emerald` |
| Rose | `rose` |
| Copper | `copper` |

Shop and Seller use independent, shop-scoped browser preferences. Reloading
restores the choice, and tabs sharing that scope receive changes. If browser
storage is unavailable, the selected palette applies to the current page and
the settings show that it has not been saved. Platform Account offers the same
presets for the current page and follows the operating system for light and
dark mode.

The shared palette registry owns preset IDs and translation keys.
`public/shared/theme.css` owns palette colors and the semantic color roles used
by controls and previews. Every palette has distinct accent roles for dark mode
and retains the neutral dark surfaces. Price, warning, error and success keep
their semantic colors within each mode. Status labels and icons still convey
meaning independently of color. The earlier three-palette comparison
[`shop-palette-preview.html`](shop-palette-preview.html) remains a historical
design reference.

## Verification

Test the actual text/background, action label/fill, selected label/fill,
control outline and keyboard focus pairs in both modes. The targets are
4.5:1 for ordinary text and 3:1 for required non-text control and focus
indicators. Check the picker, preview, apply, reload, tab synchronization,
blocked storage and tenant/surface preference boundaries. Verify the Topbar and
mobile product navigation against the same roles on desktop and mobile.
