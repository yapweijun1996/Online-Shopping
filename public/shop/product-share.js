import { productHash } from './shop-route.js';

export function productShareURL(id, href) {
  const url = new URL('./', href);
  url.search = '';
  url.hash = productHash(id);
  return url.href;
}

// Call directly from the click handler: native sharing requires user activation.
export async function shareProduct(data, navigator, isCurrent = () => true) {
  if (typeof navigator.share === 'function') {
    try {
      if (typeof navigator.canShare !== 'function' || navigator.canShare(data)) {
        await navigator.share(data);
        return isCurrent() ? 'shareFinished' : null;
      }
    } catch (error) {
      if (!isCurrent()) return null;
      if (error?.name === 'AbortError') return 'shareCancelled';
    }
  }
  if (!isCurrent()) return null;
  try {
    await navigator.clipboard.writeText(data.url);
    return isCurrent() ? 'linkCopied' : null;
  } catch {
    return isCurrent() ? 'copyLinkHelp' : null;
  }
}
