/* Small previews of product images, so lists and cards need not download full-size photos. */

/* The preview URL of one of our own image URLs; the server answers with the full image when no preview exists. */
export function thumbUrl(url) {
  if (typeof url !== 'string' || !/^\/(?:[a-z0-9]{3,30}\/)?api\//.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'size=thumb';
}

/* Shrinks an image file (or blob) to a JPEG preview of at most 80 KB; resolves undefined when the browser cannot. */
export async function makeThumbnail(file, longSide = 320) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';   // JPEG has no transparency
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    for (const quality of [0.82, 0.7, 0.55]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length * 0.75 <= 78 * 1024) return dataUrl;
    }
  } catch { /* the full image is still used */ }
  return undefined;
}
