/*
 * Keeps the browser tab icon in the page's palette colour. The icon is the same /favicon.svg used for the
 * logo; its `color` attribute is the fallback colour, so it is rewritten with the palette's brand colour and
 * set as a data: URL (the CSP allows data: images). Browsers cache the icon, so it updates on the next
 * palette change or load; the installed-app icon is a static image and does not change.
 */
const colorAttribute = /\scolor="#[0-9a-fA-F]{6}"/;
const hexColor = /^#[0-9a-fA-F]{6}$/;

/** The icon SVG with its colour replaced, as a data: URL; null when the inputs are not usable. */
export function tabIconHref(template, color) {
  if (typeof template !== 'string' || !colorAttribute.test(template) || !hexColor.test(color)) return null;
  return `data:image/svg+xml,${encodeURIComponent(template.replace(colorAttribute, ` color="${color}"`))}`;
}

export async function mountTabIcon(palette) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link || !palette?.subscribe) return;
  let template;
  try { template = await (await fetch('/favicon.svg')).text(); } catch { return; }  // icon stays as it is
  palette.subscribe(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--ui-primary').trim();
    const href = tabIconHref(template, color);
    if (href) link.href = href;
  });
}
