// Shop codes appear in URLs (`/<code>/`), so they are restricted to what cannot collide with a path, a file or a
// database identifier: 3 to 30 lower-case letters and digits, not on the reserved list.
import { FieldError } from '../validation.js';

export const RESERVED_CODES = new Set(['admin', 'api', 'shop', 'seller', 'demo', 'www', 'health', 'ready', 'static', 'assets', 'shared', 'platform',
  'default', 'login', 'logout', 'public', 'root', 'support', 'system', 'test', 'tenant', 'tenants', 'webhook', 'webhooks', 'sw', 'manifest', 'favicon', 'icons', 'p', 's']);

export function normalizeTenantCode(value, field = 'code') {
  if (typeof value !== 'string') throw new FieldError(field, 'Enter a shop code.');
  const code = value.trim().toLowerCase();
  if (!/^[a-z0-9]{3,30}$/.test(code)) throw new FieldError(field, 'Use 3 to 30 letters and digits.');
  if (RESERVED_CODES.has(code)) throw new FieldError(field, 'This shop code is reserved.');
  return code;
}
