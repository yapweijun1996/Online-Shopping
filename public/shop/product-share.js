import { basePath } from '../shared/base-path.js';
// Share paths preserve the tenant prefix because crawlers ignore app hash fragments.
export function productShareURL(id, href) {
  return new URL(`${basePath(new URL(href).pathname)}/p/${id}`, href).href;
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
