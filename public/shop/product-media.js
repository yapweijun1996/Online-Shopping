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

const saveData = () => Boolean(navigator.connection?.saveData);
const safePreview = (value) => typeof value === 'string' && /^\/[^"'()\\\s]+$/.test(value);

export function setProductMedia(image, media, kind = 'main') {
  image.alt = media.alt;
  image.decoding = 'async';
  image.loading = kind === 'thumbnail' ? 'lazy' : 'eager';
  image.fetchPriority = kind === 'main' ? 'high' : 'low';
  image.removeAttribute('srcset'); image.removeAttribute('sizes');
  // Data Saver keeps the medium size; the large file is only fetched for the zoom view.
  if (kind === 'main' && media.srcset && !saveData()) {
    image.srcset = media.srcset;
    image.sizes = '(max-width: 760px) 100vw, (max-width: 1000px) 38vw, 500px';
  }
  if (media.width && media.height) { image.width = media.width; image.height = media.height; }
  const source = kind === 'thumbnail' ? media.thumbnail : kind === 'full' ? media.full : media.src;
  image.src = source;
  // Blurred placeholder: the tiny thumbnail while the main image loads, and the already cached
  // medium size while the large zoom image loads.
  const preview = kind === 'main' ? media.thumbnail : kind === 'full' ? media.src : '';
  revealImage(image, preview && preview !== source ? preview : '');
}

const wired = new WeakSet();
/*
 * Shows a placeholder (a blurred low-resolution preview when given, otherwise a shimmer) and
 * fades the image in from blurred to sharp once it has loaded. Safe to call again when the
 * source changes.
 */
export function revealImage(image, preview = '') {
  image.classList.add('img-reveal');
  image.classList.remove('is-loaded');
  image.classList.toggle('has-lqip', safePreview(preview));
  if (safePreview(preview)) image.style.setProperty('--lqip', `url("${preview}")`);
  else image.style.removeProperty('--lqip');
  if (!wired.has(image)) {
    wired.add(image);
    const done = () => image.classList.add('is-loaded');
    image.addEventListener('load', done); image.addEventListener('error', done);
  }
  if (image.complete && image.naturalWidth) image.classList.add('is-loaded');
  return image;
}
