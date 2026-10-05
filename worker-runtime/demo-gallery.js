import { createHash } from 'node:crypto';
import manifest from './public-demo-gallery.json' with { type: 'json' };

// Fictional static galleries are an additive presentation layer. No database
// row, hero image, stored seller image, legacy namespace or customer record is changed.
export function withDemoGallery(product, hero, mode) {
  const entry = product && manifest.products[product.sku];
  if (mode !== 'public-demo' || !entry || product.name !== entry.name ||
      !hero?.data || (product.images?.length || 0) !== 1 ||
      createHash('sha256').update(hero.data).digest('hex') !== entry.heroSha256) return product;
  const media = entry.media.slice(0, 10);
  return { ...product, images: [product.imageUrl, ...media.slice(1).map(item => item.src)],
    imageMedia: media.map((item, index) => ({ ...item, src: index ? item.src : product.imageUrl })) };
}
