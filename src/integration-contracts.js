import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './http.js';

// Contract helpers have no transport and never resolve a credential reference.
export function ninjaContractLocation(environment, country = 'MY') {
  if (!['SANDBOX', 'PRODUCTION'].includes(environment) || !['MY', 'SG'].includes(country)) {
    throw new ApiError(400, 'INVALID_INPUT', 'Choose an explicit provider environment and country.');
  }
  const origin = environment === 'SANDBOX' ? 'https://api-sandbox.ninjavan.co' : 'https://api.ninjavan.co';
  const path = environment === 'SANDBOX' ? 'sg' : country.toLowerCase();
  return { oauth: `${origin}/${path}/2.0/oauth/access_token`, createShipment: `${origin}/${path}/4.2/orders` };
}

export function verifyNinjaSignature(rawBody, signature, secret) {
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength > 64 * 1024 ||
      typeof secret !== 'string' || !secret || typeof signature !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signature, 'base64');
  return received.length === expected.length && timingSafeEqual(expected, received);
}

export function verifyMetaSignature(rawBody, signature, appSecret) {
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength > 1024 * 1024 || typeof appSecret !== 'string' || !appSecret ||
      typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(signature.slice(7), 'hex');
  return received.length === expected.length && timingSafeEqual(expected, received);
}

export function messagingPolicy(input, now) {
  const consent = input?.consent;
  if (consent?.optIn !== true || typeof consent.version !== 'string' || !consent.version.trim() ||
      !Number.isSafeInteger(consent.at) || consent.at < 0 || consent.at > now) {
    throw new ApiError(409, 'CONSENT_REQUIRED', 'Current explicit messaging consent is required.');
  }
  if (input.kind === 'TEMPLATE') {
    if (input.templateApproved !== true || typeof input.template !== 'string' || !input.template.trim()) {
      throw new ApiError(409, 'APPROVED_TEMPLATE_REQUIRED', 'An approved template is required.');
    }
  } else if (input.kind !== 'TEXT' || !Number.isSafeInteger(input.lastInboundAt) || input.lastInboundAt < 0 ||
             input.lastInboundAt > now || now - input.lastInboundAt >= 24 * 60 * 60 * 1000) {
    throw new ApiError(409, 'MESSAGE_WINDOW_CLOSED', 'Use an approved template outside the customer service window.');
  }
}
