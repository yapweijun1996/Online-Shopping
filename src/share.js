/*
 * Link previews. Facebook, Messenger, WhatsApp and similar apps fetch the shared URL without running
 * JavaScript and ignore the #fragment, so the shop (a single-page app that routes with #product/<id>)
 * shows no preview. These pages carry the Open Graph tags those apps read: crawlers get them, browsers
 * are sent on to the shop.
 */

// Link-preview and search crawlers that read Open Graph tags.
const crawlerPattern = /facebookexternalhit|facebot|meta-externalagent|facebookcatalog|whatsapp|twitterbot|telegrambot|slackbot|discordbot|linkedinbot|pinterest|skypeuripreview|applebot|googlebot|bingbot|line-poker|viber/i;

export const isCrawler = (userAgent) => typeof userAgent === 'string' && crawlerPattern.test(userAgent);

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function summary(text, max = 200) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export const priceText = (minor, currency) => `${currency} ${(minor / 100).toFixed(2)}`;

const tag = (attribute, name, content) => content === undefined || content === null || content === ''
  ? '' : `  <meta ${attribute}="${name}" content="${escapeHtml(content)}">\n`;

/** A small page whose head carries the preview tags; `url` is the canonical address being shared. */
export function previewPage({ title, description, image, imageAlt, url, siteName, type = 'website', price, enter }) {
  const properties = [
    ['og:type', type], ['og:site_name', siteName], ['og:title', title], ['og:description', description], ['og:url', url],
    ['og:image', image], ['og:image:alt', imageAlt],
    ...(price ? [['product:price:amount', price.amount], ['product:price:currency', price.currency]] : []),
  ];
  const names = [['twitter:card', image ? 'summary_large_image' : 'summary'], ['twitter:title', title], ['twitter:description', description],
    ['twitter:image', image], ['description', description]];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="canonical" href="${escapeHtml(url)}">
${properties.map(([name, content]) => tag('property', name, content)).join('')}${names.map(([name, content]) => tag('name', name, content)).join('')}</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(description)}</p>
  <p><a href="${escapeHtml(enter)}">${escapeHtml(siteName)}</a></p>
</body>
</html>
`;
}
