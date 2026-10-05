import { FieldError, boundedText } from './validation.js';
import { decodeProductImage } from './product-image.js';

const requiredFields = ['sku', 'name', 'description', 'category', 'priceMinor', 'currency', 'active'];
const fields = [...requiredFields, 'imageDataUrl', 'variantGroup', 'variantLabel', 'stockQuantity'];

export function validateProductInput(input, allowedCurrencies, { partial = false } = {}) {
  if (!Array.isArray(allowedCurrencies) || allowedCurrencies.length === 0 ||
      !allowedCurrencies.every((currency) => typeof currency === 'string' && /^[A-Z]{3}$/.test(currency))) {
    throw new TypeError('A currency policy is required.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FieldError('product', 'Enter product details.');
  }
  const keys = Object.keys(input);
  if ((partial && keys.length === 0) || (!partial && requiredFields.some((field) => !keys.includes(field)))) {
    throw new FieldError('product', 'Complete the product details.');
  }
  for (const key of keys) {
    if (!fields.includes(key)) throw new FieldError(key, 'This product field is not supported.');
  }
  const result = {};
  if (keys.includes('sku')) {
    const sku = boundedText(input.sku, 'sku', 40).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(sku)) throw new FieldError('sku', 'Enter a valid SKU.');
    result.sku = sku;
  }
  if (keys.includes('name')) result.name = boundedText(input.name, 'name', 120);
  if (keys.includes('description')) result.description = boundedText(input.description, 'description', 2000);
  if (keys.includes('category')) result.category = boundedText(input.category, 'category', 80);
  if (keys.includes('priceMinor')) {
    if (!Number.isSafeInteger(input.priceMinor) || input.priceMinor < 1 || input.priceMinor > 1_000_000_000) {
      throw new FieldError('priceMinor', 'Enter a valid minor-unit price.');
    }
    result.priceMinor = input.priceMinor;
  }
  if (keys.includes('currency')) {
    if (!allowedCurrencies.includes(input.currency)) throw new FieldError('currency', 'Choose the shop currency.');
    result.currency = input.currency;
  }
  if (keys.includes('active')) {
    if (typeof input.active !== 'boolean') throw new FieldError('active', 'Choose product availability.');
    result.active = input.active;
  }
  if (keys.includes('stockQuantity')) {
    // null means unlimited; a number turns on stock tracking for this product.
    if (input.stockQuantity !== null && (!Number.isSafeInteger(input.stockQuantity) || input.stockQuantity < 0 || input.stockQuantity > 1_000_000)) {
      throw new FieldError('stockQuantity', 'Enter a whole stock quantity from 0 to 1,000,000, or leave it blank for unlimited.');
    }
    result.stockQuantity = input.stockQuantity;
  }
  if (keys.includes('imageDataUrl')) result.image = decodeProductImage(input.imageDataUrl);
  if (keys.includes('variantGroup')) {
    const group = boundedText(input.variantGroup, 'variantGroup', 40, false).toUpperCase();
    if (group && !/^[A-Z0-9][A-Z0-9._-]*$/.test(group)) throw new FieldError('variantGroup', 'Enter a valid variant group code.');
    result.variantGroup = group || null;
  }
  if (keys.includes('variantLabel')) result.variantLabel = boundedText(input.variantLabel, 'variantLabel', 80, false) || null;
  return result;
}
