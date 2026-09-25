import parsePhoneNumber from 'libphonenumber-js/max';

const supportedCountries = new Set(['MY', 'SG']);

export function normalizeContactPhone(value) {
  if (typeof value !== 'string' || value.length > 32 || !/^\+[0-9 ()-]{7,31}$/.test(value)) {
    throw new TypeError('Enter a valid +60 or +65 phone number.');
  }
  const parsed = parsePhoneNumber(value);
  if (!parsed || !supportedCountries.has(parsed.country) || !parsed.isValid() || parsed.ext) {
    throw new TypeError('Enter a valid +60 or +65 phone number.');
  }
  return parsed.number;
}
