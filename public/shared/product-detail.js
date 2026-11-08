import { basePath } from './base-path.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const imagePath = new RegExp(`^(/(?:[a-z0-9]{3,30}/)?api/v1/(?:seller/)?products/${uuid}/detail/images/(${uuid}))$`, 'i');
const text = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum) : '';

// Both the storefront and seller preview use this renderer. Content never becomes HTML.
export function renderProductDetail(documentData, assets = [], { fallbackText = '', ownerDocument = globalThis.document } = {}) {
  const element = (tag, content) => {
    const result = ownerDocument.createElement(tag);
    if (content !== undefined) result.textContent = content;
    return result;
  };
  const root = element('div');
  root.className = 'rich-product-detail';
  const pathname = ownerDocument.location?.pathname || globalThis.location?.pathname || '/shop/';
  const prefix = `${basePath(pathname)}/api/v1/`;
  const available = new Map();
  for (const asset of Array.isArray(assets) ? assets.slice(0, 40) : []) {
    const match = typeof asset?.src === 'string' && imagePath.exec(asset.src);
    if (!match || !asset.src.startsWith(prefix) || typeof asset.id !== 'string' || match[2].toLowerCase() !== asset.id.toLowerCase() ||
        !Number.isInteger(asset.width) || !Number.isInteger(asset.height) ||
        asset.width < 1 || asset.height < 1 || asset.width > 32768 || asset.height > 32768 ||
        asset.width * asset.height > 40000000) continue;
    available.set(asset.id, asset);
  }
  const blocks = documentData?.version === 1 && Array.isArray(documentData.blocks) ? documentData.blocks.slice(0, 40) : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'heading' && text(block.text, 240).trim()) {
      root.append(element('h3', text(block.text, 240)));
    } else if (block.type === 'paragraph' && text(block.text, 5000).trim()) {
      const paragraph = element('p');
      if (block.bold === true) paragraph.append(element('strong', text(block.text, 5000)));
      else paragraph.textContent = text(block.text, 5000);
      root.append(paragraph);
    } else if (block.type === 'list' && Array.isArray(block.items)) {
      const list = element('ul');
      for (const item of block.items.slice(0, 30)) if (text(item, 500).trim()) list.append(element('li', text(item, 500)));
      if (list.children.length) root.append(list);
    } else if (block.type === 'specs' && Array.isArray(block.rows)) {
      const specs = element('dl');
      specs.className = 'rich-product-specs';
      for (const row of block.rows.slice(0, 30)) {
        if (text(row?.label, 120).trim() && text(row?.value, 500).trim()) {
          specs.append(element('dt', text(row.label, 120)), element('dd', text(row.value, 500)));
        }
      }
      if (specs.children.length) root.append(specs);
    } else if (block.type === 'image' && available.has(block.assetId)) {
      const asset = available.get(block.assetId);
      const figure = element('figure');
      const image = element('img');
      image.alt = text(block.alt, 500);
      image.width = asset.width;
      image.height = asset.height;
      image.loading = 'lazy';
      image.decoding = 'async';
      // Failed/protected assets never leave a broken-image icon in the detail page.
      image.addEventListener('error', () => figure.remove(), { once: true });
      image.src = asset.src;
      figure.append(image);
      if (text(block.caption, 1000).trim()) figure.append(element('figcaption', text(block.caption, 1000)));
      root.append(figure);
    }
  }
  if (!root.children.length && typeof fallbackText === 'string' && fallbackText) {
    const paragraph = element('p', fallbackText.slice(0, 2000));
    paragraph.className = 'detail-description';
    root.append(paragraph);
  }
  return root;
}
