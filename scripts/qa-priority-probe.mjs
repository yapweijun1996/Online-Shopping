import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { openDatabase } from '../src/db.js';
import { initializeShop } from '../src/shop-setup.js';
import { createApi } from '../src/app.js';
import { createSession } from '../src/auth.js';
import { getCompanySettings, updateCompanySettings } from '../src/settings.js';
import { addGalleryImage, listProducts } from '../src/products.js';
import { sellerChatURL } from '../public/shop/product-detail.js';

// Before-fix diagnostic only. All stores and contacts are fictional and isolated.
const store = openDatabase(':memory:');
const config = { shopMode: 'public-demo', demoRevision: 'qa-priority-isolated', production: false, publicOrigin: null };
initializeShop(store, config);
const api = createApi({ store, config }), session = createSession(store);
const get = path => api(new Request('http://127.0.0.1' + path, { headers: { cookie: 'seller_session=' + session.token } }));
const evidence = { source: '5966ca8626c6c75e8e0ec4e34488a7c47fa29376', isolation: 'fresh in-memory SQLite', externalCalls: 0, observations: [] };
try {
  const product = listProducts(store, new URLSearchParams('limit=100')).items.find(x => x.sku === 'DEMO-020');
  const beforePublic = await (await get('/api/v1/products/' + product.id)).json();
  const beforeSeller = await (await get('/api/v1/seller/products/' + product.id)).json();
  assert.equal(beforePublic.images.length, 6); assert.equal(beforeSeller.images.length, 6);
  const image = 'data:image/png;base64,' + readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url)).toString('base64');
  addGalleryImage(store, product.id, image);
  const after = await (await get('/api/v1/products/' + product.id)).json();
  assert.equal(after.images.length, 2);
  assert.equal(beforePublic.images.slice(1).filter(url => after.images.includes(url)).length, 0);
  evidence.observations.push({ case: 'Gallery', beforePublicImages: 6, beforeSellerImages: 6, afterOneAdditionalImage: 2,
    storedAdditionalImages: store.get('SELECT count(*) n FROM product_gallery_image WHERE product_id=?', product.id).n,
    originalStaticAssetsDeleted: false, cause: 'Static gallery overlay applies only while canonical product images length is one. First persisted gallery image suppresses all five existing static references. Existing static thumbnails are read-only; no reorder/set-primary endpoint exists.' });
  updateCompanySettings(store, { sellerWhatsAppPhone: '+60 12-345 6789' });
  const saved = getCompanySettings(store), response = await get('/api/v1/shop'), publicShop = await response.json();
  assert.equal(saved.sellerWhatsAppPhone, '60123456789'); assert.equal(publicShop.sellerWhatsAppPhone, null);
  assert.equal(sellerChatURL(publicShop.sellerWhatsAppPhone), null);
  evidence.observations.push({ case: 'Chat', settingsPersisted: true, canonicalFictionalPhone: saved.sellerWhatsAppPhone,
    publicPhone: null, link: null, cacheControl: response.headers.get('cache-control'),
    cause: 'Public shop DTO explicitly masks sellerWhatsAppPhone for public-demo mode after successful normalization/persistence. Chat consumes that null DTO; this is not a lost setting or Meta/Baileys connection requirement.' });
  mkdirSync('output/qa/local', { recursive: true });
  writeFileSync('output/qa/local/priority-before.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { store.close(); }
