import { ApiError } from './http.js';
import { ninjaContractLocation } from './integration-contracts.js';

const prepared = new WeakSet();
const invalid = () => { throw new ApiError(400, 'INVALID_INPUT', 'Invalid bounded provider request.'); };
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function text(value, maximum = 255, minimum = 1) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || !value.trim() || /[\u0000-\u001f]/.test(value)) invalid();
  return value;
}
function matches(value, pattern, maximum = 80) { text(value, maximum); if (!pattern.test(value)) invalid(); return value; }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function bindingFor(value, provider) {
  fields(value, ['companyId','connectionId','accountId','provider','environment']);
  matches(value.companyId, /^synthetic-[a-z0-9-]+$/, 160); text(value.connectionId, 160);
  matches(value.accountId, /^synthetic-[a-z0-9-]+$/, 160);
  if (value.provider !== provider || value.environment !== 'SYNTHETIC') invalid();
  return structuredClone(value);
}
const phone = value => matches(value, /^\+[1-9]\d{7,14}$/, 16);
function contact(value, country) {
  fields(value, ['name','phone','email','address']);
  const address = value.address;
  fields(address, ['line1','line2','city','region','postcode','country']);
  if (address.country !== country) invalid();
  text(address.line1); text(address.city); text(address.region); text(address.postcode, 16);
  if (address.line2 !== undefined) text(address.line2);
  return {
    name: text(value.name, 255, 3), phone_number: phone(value.phone),
    email: matches(value.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 255),
    address: { address1: address.line1, ...(address.line2 === undefined ? {} : { address2: address.line2 }),
      city: address.city, state: address.region, postcode: address.postcode, country },
  };
}
function packet(binding, kind, input, request, policy = null) {
  const value = freeze(structuredClone({ binding, kind, input, request, policy })); prepared.add(value); return value;
}

// These descriptors contain no authorization header and can only enter a synthetic ledger.
export function buildNinjaParcelRequest(binding, input) {
  const bound = bindingFor(binding, 'NINJA_VAN');
  fields(input, ['country','orderRef','requestedTrackingNumber','sender','recipient','weightGrams','deliveryDate','deliverySlot']);
  if (!['MY','SG'].includes(input.country) || !Number.isSafeInteger(input.weightGrams) || input.weightGrams < 1 || input.weightGrams > 30000) invalid();
  text(input.orderRef, 255);
  matches(input.requestedTrackingNumber, /^([a-zA-Z0-9]+-)*[a-zA-Z0-9]+$/, 18);
  if (input.requestedTrackingNumber.length < 9) invalid();
  matches(input.deliveryDate, /^[12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 10);
  const date = new Date(`${input.deliveryDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.deliveryDate) invalid();
  fields(input.deliverySlot, ['start','end']);
  if (!['09:00/12:00','09:00/18:00','09:00/22:00','12:00/15:00','15:00/18:00','18:00/22:00'].includes(`${input.deliverySlot.start}/${input.deliverySlot.end}`)) invalid();
  const body = { service_type: 'Parcel', service_level: 'Standard',
    requested_tracking_number: input.requestedTrackingNumber, reference: { merchant_order_number: input.orderRef },
    from: contact(input.sender, input.country), to: contact(input.recipient, input.country),
    parcel_job: { is_pickup_required: false, dimensions: { weight: input.weightGrams / 1000 },
      delivery_start_date: input.deliveryDate, delivery_timeslot: { start_time: input.deliverySlot.start,
        end_time: input.deliverySlot.end, timezone: input.country === 'MY' ? 'Asia/Kuala_Lumpur' : 'Asia/Singapore' } } };
  return packet(bound, 'SHIPMENT', input, { method: 'POST', url: ninjaContractLocation('SANDBOX', input.country).createShipment,
    headers: { 'content-type': 'application/json' }, body });
}

export function buildWhatsAppMessageRequest(binding, input) {
  const bound = bindingFor(binding, 'WHATSAPP_CLOUD');
  fields(input, ['phoneNumberId','apiVersion','recipient','consent','kind',
    ...(input?.kind === 'TEMPLATE' ? ['template','templateApproved','language','parameters'] : ['body','lastInboundAt'])]);
  matches(input.phoneNumberId, /^\d{5,20}$/, 20);
  if (input.apiVersion !== 'v25.0') invalid();
  fields(input.consent, ['optIn','at','version']); text(input.consent.version, 80);
  if (typeof input.consent.optIn !== 'boolean' || !Number.isSafeInteger(input.consent.at) || input.consent.at < 0) invalid();
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone(input.recipient) };
  let policy;
  if (input.kind === 'TEXT') {
    text(input.body, 4000);
    if (!Number.isSafeInteger(input.lastInboundAt) || input.lastInboundAt < 0) invalid();
    Object.assign(body, { type: 'text', text: { preview_url: false, body: input.body } });
    policy = { kind: 'TEXT', consent: input.consent, lastInboundAt: input.lastInboundAt };
  } else if (input.kind === 'TEMPLATE') {
    matches(input.template, /^[a-z0-9_]+$/, 160); matches(input.language, /^[a-z]{2,3}(?:_[A-Z]{2})?$/, 10);
    if (typeof input.templateApproved !== 'boolean' || !Array.isArray(input.parameters) || input.parameters.length < 1 || input.parameters.length > 10) invalid();
    Object.assign(body, { type: 'template', template: { name: input.template, language: { code: input.language },
      components: [{ type: 'body', parameters: input.parameters.map(value => ({ type: 'text', text: text(value, 1000) })) }] } });
    policy = { kind: 'TEMPLATE', consent: input.consent, template: input.template, templateApproved: input.templateApproved };
  } else invalid();
  return packet(bound, 'MESSAGE', input, { method: 'POST', url: `https://graph.facebook.com/v25.0/${input.phoneNumberId}/messages`,
    headers: { 'content-type': 'application/json' }, body }, policy);
}

export const isPreparedIntegrationRequest = value => prepared.has(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function restoreIntegrationRequest(snapshot) {
  fields(snapshot, ['binding','kind','input','request','policy']);
  const value = snapshot.binding?.provider === 'NINJA_VAN' ? buildNinjaParcelRequest(snapshot.binding, snapshot.input) : buildWhatsAppMessageRequest(snapshot.binding, snapshot.input);
  // Rebuilding from validated inputs prevents a stored URL/header/body override.
  if (JSON.stringify(canonical(value)) !== JSON.stringify(canonical(snapshot))) invalid();
  return value;
}

export function normalizeProviderResponse(provider, response) {
  if (!['NINJA_VAN','WHATSAPP_CLOUD'].includes(provider)) invalid();
  const status = response?.status, body = response?.body;
  const unknown = category => ({ outcome: 'UNKNOWN', category, ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}) });
  if (!Number.isInteger(status) || status < 200 || status > 599 || !body || typeof body !== 'object' || Array.isArray(body)) return unknown('UNVERIFIED_RESPONSE');
  if (status < 300 && !body.error) {
    if (provider === 'NINJA_VAN' && status !== 200) return unknown('UNVERIFIED_RESPONSE');
    const entry = Array.isArray(body.messages) && body.messages.length === 1 ? body.messages[0] : null;
    const id = provider === 'NINJA_VAN' ? body.tracking_number : body.messaging_product === 'whatsapp' && entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.id : null;
    const pattern = provider === 'NINJA_VAN' ? /^([a-zA-Z0-9]+-)*[a-zA-Z0-9]+$/ : /^wamid\.[A-Za-z0-9+/=_-]+$/;
    if (typeof id === 'string' && id.length <= 160 && pattern.test(id)) return { outcome: 'ACKNOWLEDGED', category: 'ACCEPTED', providerId: id, httpStatus: status };
    return unknown('UNVERIFIED_RESPONSE');
  }
  const code = body.error?.code;
  const numericCode = Number.isSafeInteger(code) && code >= 0;
  const validCode = provider === 'WHATSAPP_CLOUD' ? numericCode : numericCode || typeof code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(code);
  if (!validCode) return unknown('UNVERIFIED_RESPONSE');
  if (provider === 'NINJA_VAN' && String(code) === '109201') return { ...unknown('PROVIDER_RECONCILE'), errorCode: String(code) };
  if ([400,422].includes(status)) return { outcome: 'REJECTED', category: 'INVALID_REQUEST', errorCode: String(code), httpStatus: status };
  if ([401,403,404].includes(status)) return { outcome: 'REJECTED', category: 'CONFIGURATION_REQUIRED', errorCode: String(code), httpStatus: status };
  // No verified provider idempotency guarantee: conflicts, throttling and server errors need reconciliation.
  return { ...unknown(status === 429 ? 'RATE_LIMIT_RECONCILE' : 'PROVIDER_RECONCILE'), errorCode: String(code) };
}

const ninjaStatuses = {
  'Pending Pickup': 'PENDING', 'Driver dispatched for Pickup': 'PENDING', 'Picked Up': 'IN_TRANSIT',
  'Arrived at Origin Hub': 'IN_TRANSIT', 'Arrived at Transit Hub': 'IN_TRANSIT', 'Arrived at Destination Hub': 'IN_TRANSIT',
  'In Transit to Next Sorting Hub': 'IN_TRANSIT', 'On Vehicle for Delivery': 'OUT_FOR_DELIVERY', 'At PUDO': 'AWAITING_COLLECTION',
  'Delivered': 'DELIVERED', 'Returned to Sender': 'RETURNED', 'Cancelled': 'CANCELLED',
  'Pickup Exception': 'EXCEPTION', 'Delivery Exception': 'EXCEPTION', 'Return to Shipper Exception': 'EXCEPTION',
  'International Transit': 'IN_TRANSIT',
};
export function normalizeProviderStatus(provider, status) {
  text(status, 80);
  if (!['NINJA_VAN','WHATSAPP_CLOUD'].includes(provider)) invalid();
  const statuses = provider === 'NINJA_VAN' ? ninjaStatuses : { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };
  const normalized = Object.hasOwn(statuses, status) ? statuses[status] : undefined;
  return { status: normalized || 'UNKNOWN', requiresReconciliation: !normalized };
}
