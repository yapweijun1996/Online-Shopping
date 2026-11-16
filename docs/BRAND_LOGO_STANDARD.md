# Brand logo standard

The editable logo source is `brand/`, synced byte-for-byte from Pomelo-STEM brand v2.1 at commit `871aee8`. Keep edits upstream; rebuild this repository's deployed SVG/PNG copies with `node scripts/build-brand.js`. Run `node scripts/check-brand.js` to verify checksums, deployment copies, manifest icons, and tiered references.

Use compact SVG for favicons and header marks, supplied square and maskable PNGs for PWA icons, and the matching animated or static light/dark placeholder according to theme and reduced-motion preference. Detailed and full-screen loader artwork is reserved for sizes of at least 128px.
