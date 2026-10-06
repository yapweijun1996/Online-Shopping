/* Parsing of the seller's price and stock inputs, shared by the product form and the variant generator. */
export function inputFailure(field) { return Object.assign(new Error(field), { field }); }

export function priceToMinor(value) {
  const match = /^(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw inputFailure('price');
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  if (minor < 1n || minor > 1_000_000_000n) throw inputFailure('price');
  return Number(minor);
}

export function stockFromInput(value) {
  const text = value.trim();
  if (text === '') return null;
  if (!/^\d{1,7}$/.test(text) || Number(text) > 1_000_000) throw inputFailure('stockQuantity');
  return Number(text);
}
