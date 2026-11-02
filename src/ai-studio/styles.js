// The seven product-photo styles. Wording of the style add-ons comes from the owner's PWA-AI-Product-Image-Studio-BYOK
// contract (contracts/style-presets.json, skill image:product-photography-brand-lock v1.0.1). Sizes are multiples of
// 16 within the image edit endpoint limits.
export const PRODUCT_LOCK = 'Product Lock: the reference photo shows the exact product. Keep its shape, proportions, colours, materials, logos, ' +
  'labels, printed text and packaging exactly as in the reference. Do not redraw, restyle, translate, add or remove any mark or text. ' +
  'Change only the surroundings, lighting and camera framing. Do not add watermarks or invented text.';

export const STYLES = Object.freeze({
  studio: { name: 'Studio Shot', size: '1024x1280', addon: 'Style: Studio Shot. Create a seamless professional studio backdrop whose tone contrasts appropriately with the product. Use controlled softbox lighting, crisp original product details, natural material highlights, realistic contact shadow, balanced framing and minimal props. Keep the reference view when that best preserves the original product. Suitable for product detail pages and catalogs.' },
  hero: { name: 'Hero Shot', size: '1024x1280', addon: 'Style: Hero Shot. Make the original product the dominant campaign focal point. Use refined directional light, depth, negative space, high-quality reflections and a dramatic yet believable category-appropriate set. Platforms or plinths may be used only where product size and physical support make sense. Enhance drama through surroundings, not product redesign.' },
  lifestyle: { name: 'Lifestyle / Pinterest', size: '1024x1280', addon: 'Style: Lifestyle Shot. Place the unchanged product in a believable use context for the product category and intended audience. Use natural window or daylight, tactile environmental details, contextually relevant props, layered depth and premium but authentic editorial styling. Do not imply specifications or use cases not supported by the reference.' },
  flat_lay: { name: 'Flat Lay', size: '1024x1024', addon: 'Style: Flat Lay. Arrange the original product with a harmonious, category-relevant selection of accessories on a clean background, with top-down lighting and realistic shadows. A true 90-degree overhead view needs a compatible original product view; otherwise produce a flat-lay-inspired scene at the source camera angle. Never fake invisible parts of the packaging.' },
  macro: { name: 'Macro Detail', size: '1024x1280', addon: 'Style: Macro Shot. Crop into original visible areas to emphasize authentic texture, stitching, material, lettering, printing or mechanical detail appropriate to the product. Use controlled close-up lighting and realistic depth of field. Do not regenerate small text or synthesize detail beyond what the source supports.' },
  ugc: { name: 'UGC Style', size: '1024x1280', addon: 'Style: UGC Style. Present the unchanged product in a believable informal consumer-style photograph under natural ambient light with gently imperfect framing. Optional hands or people may appear if appropriate but must not obscure branding or imply a real customer testimonial or verified experience. Avoid over-polished studio effects and artificial product changes.' },
  billboard: { name: 'Billboard Mockup', size: '1536x864', addon: 'Style: Billboard Mockup. Compose a category-appropriate advertisement using the unchanged original product artwork, then show the whole completed ad on a realistic billboard or display in a relevant environment with believable scale, perspective, mounting, reflections and lighting. Preserve the product graphic inside the ad. Do not invent promotional copy or approvals.' }
});

export const STYLE_IDS = Object.freeze(Object.keys(STYLES));

/* Only the product name and category label are sent besides the photo; never price, stock or customer data. */
export function buildPrompt(style, { name, categoryLabel }) {
  const entry = STYLES[style];
  if (!entry) throw new Error('Unknown style.');
  return `${PRODUCT_LOCK}\n\nProduct: ${String(name).slice(0, 120)}${categoryLabel ? ` (category: ${String(categoryLabel).slice(0, 80)})` : ''}.\n\n${entry.addon}`;
}
