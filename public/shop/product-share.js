// The shared address is /p/<id>: link-preview crawlers ignore #fragments, so it is served with preview
// tags and sends browsers on to /shop/#product/<id> (see src/share.js).
export function productShareURL(id, href) {
  return new URL(`/p/${id}`, href).href;
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
