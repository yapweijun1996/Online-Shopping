export function productMedia(product) {
  const sources = (product.images?.length ? product.images : [product.imageUrl]).filter(Boolean).slice(0, 10);
  return sources.map((src, index) => {
    const meta = product.imageMedia?.[index];
    return { src, thumbnail: meta?.thumbnail || src, full: meta?.full || src,
      srcset: meta?.srcset || '', width: meta?.width || 0, height: meta?.height || 0,
      alt: meta?.alt || `${product.name} — ${index + 1} / ${sources.length}`,
      caption: meta?.caption || '' };
  });
}

export function setProductMedia(image, media, kind = 'main') {
  image.alt = media.alt;
  image.decoding = 'async';
  image.loading = kind === 'thumbnail' ? 'lazy' : 'eager';
  image.fetchPriority = kind === 'main' ? 'high' : 'low';
  image.removeAttribute('srcset'); image.removeAttribute('sizes');
  if (kind === 'main' && media.srcset) {
    image.srcset = media.srcset;
    image.sizes = '(max-width: 760px) 100vw, (max-width: 1000px) 38vw, 500px';
  }
  if (media.width && media.height) { image.width = media.width; image.height = media.height; }
  image.src = kind === 'thumbnail' ? media.thumbnail : kind === 'full' ? media.full : media.src;
}
