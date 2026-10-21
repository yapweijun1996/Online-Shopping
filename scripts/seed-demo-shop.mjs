import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { boundedText } from '../src/validation.js';
import { validateProductInput } from '../src/product-input.js';
import { decodeProductImage, decodeThumbnail } from '../src/product-image.js';
import { createProduct, addGalleryImage } from '../src/products.js';
import { trackCreate } from '../src/product-history.js';
import { getCompanySettings, listCategories, createCategory } from '../src/settings.js';

export async function seedDemoShop(store, { data, images, shopName, dryRun = false }, report = console.log) {
  const source = JSON.parse(await readFile(data, 'utf8'));
  if (!Array.isArray(source.products)) throw new Error('Data must contain a products array.');
  const name = shopName === undefined ? undefined : boundedText(shopName, 'shopName', 80);
  const currency = (await getCompanySettings(store)).defaultCurrency;
  const categories = await listCategories(store);
  const planned = new Map(categories.map((item) => [item.code, item]));
  const seen = new Set();
  const products = [];
  for (const item of source.products) {
    const sku = boundedText(item.sku, 'sku', 40).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(sku)) throw new Error('Invalid SKU.');
    if (seen.has(sku)) throw new Error(`Duplicate input SKU: ${sku}`);
    seen.add(sku);
    const label = boundedText(item.category, 'category', 80);
    const code = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!/^[A-Z][A-Z0-9-]{0,79}$/.test(code)) throw new Error(`Invalid category slug for ${sku}.`);
    const existing = planned.get(code) || categories.find((category) => category.label.toLowerCase() === label.toLowerCase());
    if (existing && (existing.code !== code || existing.label !== label || !existing.active)) throw new Error(`Category conflict for ${sku}.`);
    planned.set(code, { code, label, active: true });
    const photos = [];
    for (let view = 1; view <= 3; view++) {
      const load = async (suffix, optional) => {
        let bytes;
        try { bytes = await readFile(resolve(images, sku, `view-${view}${suffix}.jpg`)); }
        catch (error) { if (optional && error.code === 'ENOENT') return null; throw new Error(`${sku} view-${view}${suffix}: image cannot be read.`); }
        const url = `data:image/jpeg;base64,${bytes.toString('base64')}`;
        try { (optional ? decodeThumbnail : decodeProductImage)(url); }
        catch { throw new Error(`${sku} view-${view}${suffix}: invalid JPEG or image exceeds size limit.`); }
        return url;
      };
      photos.push({ imageDataUrl: await load('', false), thumbDataUrl: await load('.thumb', true) });
    }
    if (!Number.isSafeInteger(item.stock)) throw new Error(`${sku}: stock must be an integer.`);
    const input = { sku, name: item.name, description: item.description, category: code, priceMinor: item.priceMinor,
      currency: item.currency, stockQuantity: item.stock, active: true, ...photos[0] };
    try { validateProductInput(input, [currency]); }
    catch (error) { throw new Error(`${sku}: ${error.message}`); }
    products.push({ input, photos });
  }
  const oldName = (await store.get('SELECT shop_name FROM shop_setup WHERE id = 1')).shop_name;
  const summary = { created: 0, skipped: 0, categoriesCreated: 0, shopName: name ?? oldName, imagesAdded: 0 };
  const available = new Set(categories.map((item) => item.code));
  for (const { input, photos } of products) {
    if (await store.get('SELECT id FROM product WHERE sku = ?', input.sku)) {
      summary.skipped++;
      report(`Skipped ${input.sku}`);
      continue;
    }
    const needsCategory = !available.has(input.category);
    if (!dryRun) await trackCreate(store, 'seed-demo-shop', async () => {
      if (needsCategory) {
        const { code, label } = planned.get(input.category);
        await createCategory(store, { code, label });
      }
      let product = await createProduct(store, input);
      for (const photo of photos.slice(1)) product = await addGalleryImage(store, product.id, photo.imageDataUrl, 'manual', photo.thumbDataUrl);
      return product;
    });
    if (needsCategory) { available.add(input.category); summary.categoriesCreated++; }
    summary.created++;
    summary.imagesAdded += photos.length;
    report(`${dryRun ? 'Would create' : 'Created'} ${input.sku}`);
  }
  if (name !== undefined) {
    if (!dryRun) await store.run('UPDATE shop_setup SET shop_name = ? WHERE id = 1', name);
    report(`${dryRun ? 'Would rename' : 'Shop name'}: ${JSON.stringify(oldName)} -> ${JSON.stringify(name)}`);
  }
  return summary;
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--dry-run') options.dryRun = true;
    else if (['--data', '--images', '--shop-name'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--')) {
      options[{ '--data': 'data', '--images': 'images', '--shop-name': 'shopName' }[flag]] = args[++i];
    } else throw new Error('Usage: --data <json> --images <dir> [--shop-name <name>] [--dry-run]');
  }
  if (!options.data || !options.images) throw new Error('--data and --images are required.');
  const config = readConfig();
  let store;
  try {
    store = config.databaseUrl ? await openPostgresDatabase(config.databaseUrl) : await openDatabase(config.dbPath);
    console.log(JSON.stringify(await seedDemoShop(store, options)));
  } finally { if (store) await store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Database/driver errors may contain connection details; only application validation is printable.
    const validation = /^(?:[A-Z0-9][A-Z0-9._-]* view-[123](?:\.thumb)?: |[A-Z0-9][A-Z0-9._-]*: |Data must |Invalid SKU|Duplicate input SKU:|Invalid category slug |Category conflict |Usage: |--data and --images)/;
    console.error(validation.test(error.message) || error.name === 'FieldError' ? error.message : 'Seeding failed: check database/configuration and input files privately.');
    process.exitCode = 1;
  });
}
