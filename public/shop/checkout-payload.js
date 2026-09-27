// Keep the single-address storefront contract separate from the multi-delivery API.
export function checkoutPayload({ profile, address, items, locale, consent, demo }) {
  if (!profile) throw new Error('profileRequired');
  if (!address) throw new Error('addressRequired');
  if (!items.length) throw new Error('emptyCart');
  if (items.some(({ product }) => !product)) throw new Error('cartUnavailable');
  if (new Set(items.map(({ product }) => product.currency)).size !== 1) throw new Error('mixedCurrencies');
  return {
    buyer: demo ? { fullName: 'Demo Customer', whatsappPhone: 'DEMO-NO-CONTACT', email: null }
      : { fullName: profile.fullName, whatsappPhone: profile.phone, email: profile.email || null },
    whatsappOrderContactOptIn: !demo && consent,
    locale,
    deliveries: [{
      recipient: demo ? { fullName: 'Demo Recipient 1', phone: 'DEMO-NO-CONTACT' }
        : { fullName: address.fullName, phone: address.phone },
      address: demo ? { line1: 'Demo address 1 - no delivery', postcode: '00000', country: 'MY' }
        : Object.fromEntries(['line1', 'line2', 'city', 'region', 'postcode', 'country'].map(key => [key, address[key]])),
      items: items.map(({ productId, quantity, product }) => ({ productId, quantity, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency })),
    }],
  };
}
