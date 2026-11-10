// Pure sender contract shared by storage validation and the Company settings UI.
export const senderLimits = Object.freeze({ senderName: 120, senderPhone: 15, senderAddressLine1: 240, senderAddressLine2: 240, senderCity: 120, senderState: 120, senderPostcode: 20, senderCountry: 2 });
// Phone storage is normalized digits; a formatted, complete phone input may use32 raw characters.
export const senderInputLimits = Object.freeze({ ...senderLimits, senderPhone: 32 });

const regions = new Map();
export function senderCountryOptions(locale = 'en') {
  if (regions.has(locale)) return regions.get(locale);
  const options = [];
  try {
    const names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
    for (let first = 65; first <= 90; first++) for (let last = 65; last <= 90; last++) {
      const code = String.fromCharCode(first, last), name = names.of(code);
      if (code !== 'ZZ' && name && name !== code) options.push({ code, name });
    }
    options.sort((a, b) => a.name.localeCompare(b.name, locale));
  } catch { /* Code fallback and manual two-letter input remain available without Intl.DisplayNames. */ }
  const value = Object.freeze(options.map(option => Object.freeze(option))); regions.set(locale, value); return value;
}
