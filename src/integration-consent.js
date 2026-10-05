import { ApiError } from './http.js';

const authorities = new WeakSet(), proofs = new WeakSet();
const proofSources = new WeakMap();
const authorityStores = new WeakMap();
const fail = (code, message, status = 409) => { throw new ApiError(status, code, message); };
const missing = () => fail('NOT_FOUND', 'Not found.', 404);
const bounded = (value, pattern, max = 160) => {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) fail('INVALID_INPUT', 'Invalid synthetic binding.', 400);
  return value;
};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const isMessagingAuthority = value => authorities.has(value);
export const isConsentProof = value => proofs.has(value);
export const authorityUsesStore = (authority, store) => authorityStores.get(authority) === store && authorities.has(authority);
export function assertConsentProofReference(value, store) {
  const source = proofSources.get(value);
  if (!source || !authorityUsesStore(source.authority, store)) fail('TRUSTED_CONSENT_REQUIRED', 'Use a consent proof from this Store.');
  source.authority.assertReference(source.binding, { ...source.input, phoneNumberId: value.phoneNumberId });
}
export function refreshConsentProof(value, store) {
  assertConsentProofReference(value, store);
  const source = proofSources.get(value);
  return source.authority.resolve(source.binding, source.input);
}

// Only opted-in fixture Stores may map an existing server-owned order to synthetic scope.
// Nothing here creates a real identity/grant or modifies historical order consent.
export function createSyntheticMessagingAuthority(store, { mode, now = Date.now } = {}) {
  if (mode !== 'SYNTHETIC') fail('SYNTHETIC_ONLY', 'An isolated synthetic authority is required.');
  store.transaction(() => store.exec(`
    CREATE TABLE IF NOT EXISTS integration_demo_phone_binding (
      company_id TEXT NOT NULL, connection_id TEXT NOT NULL, account_id TEXT NOT NULL,
      app_id TEXT NOT NULL, waba_id TEXT NOT NULL, phone_id TEXT NOT NULL,
      PRIMARY KEY(company_id,connection_id), UNIQUE(app_id,waba_id,phone_id), UNIQUE(app_id,phone_id),
      FOREIGN KEY(company_id,connection_id) REFERENCES integration_demo_connection(company_id,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_order_contact (
      company_id TEXT NOT NULL, connection_id TEXT NOT NULL, order_id TEXT NOT NULL UNIQUE REFERENCES shop_order(id),
      account_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose='ORDER_CONTACT'),
      PRIMARY KEY(company_id,connection_id,order_id),
      FOREIGN KEY(company_id,connection_id) REFERENCES integration_demo_phone_binding(company_id,connection_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_consent_revocation (
      company_id TEXT NOT NULL, connection_id TEXT NOT NULL, order_id TEXT NOT NULL, revoked_at INTEGER NOT NULL,
      PRIMARY KEY(company_id,connection_id,order_id),
      FOREIGN KEY(company_id,connection_id,order_id) REFERENCES integration_demo_order_contact(company_id,connection_id,order_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_template_approval (
      company_id TEXT NOT NULL, connection_id TEXT NOT NULL, name TEXT NOT NULL, language TEXT NOT NULL,
      parameter_count INTEGER NOT NULL CHECK(parameter_count BETWEEN 1 AND 10), approved INTEGER NOT NULL CHECK(approved IN (0,1)),
      PRIMARY KEY(company_id,connection_id,name,language),
      FOREIGN KEY(company_id,connection_id) REFERENCES integration_demo_phone_binding(company_id,connection_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_inbound_clock (
      company_id TEXT NOT NULL, connection_id TEXT NOT NULL, recipient TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      PRIMARY KEY(company_id,connection_id,recipient),
      FOREIGN KEY(company_id,connection_id) REFERENCES integration_demo_phone_binding(company_id,connection_id)
    ) STRICT;
  `));
  const clock = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_CLOCK', 'Invalid clock.'); return value; };
  function current(binding) {
    if (!binding || binding.provider !== 'WHATSAPP_CLOUD' || binding.environment !== 'SYNTHETIC') missing();
    bounded(binding.companyId, /^synthetic-[a-z0-9-]+$/); bounded(binding.accountId, /^synthetic-[a-z0-9-]+$/);
    bounded(binding.connectionId, /^[A-Za-z0-9_-]+$/);
    const row = store.get("SELECT * FROM integration_demo_connection WHERE company_id=? AND id=? AND account_id=? AND provider='WHATSAPP_CLOUD' AND environment='SYNTHETIC'", binding.companyId, binding.connectionId, binding.accountId);
    if (!row) missing(); return row;
  }
  function phoneBinding(binding) {
    current(binding);
    const row = store.get('SELECT * FROM integration_demo_phone_binding WHERE company_id=? AND connection_id=? AND account_id=?', binding.companyId, binding.connectionId, binding.accountId);
    if (!row) missing(); return row;
  }
  function reference(binding, { orderId, recipient, purpose, phoneNumberId }) {
    const phone = phoneBinding(binding);
    if (phoneNumberId !== undefined && phoneNumberId !== phone.phone_id) fail('MESSAGE_BINDING_CHANGED', 'The message phone binding has changed.');
    bounded(orderId, /^[A-Za-z0-9_-]+$/); bounded(recipient, /^\+[1-9]\d{7,14}$/, 16);
    if (purpose !== 'ORDER_CONTACT') fail('PURPOSE_DISABLED', 'Only the existing order-contact purpose is supported.');
    const row = store.get(`SELECT o.buyer_phone,o.whatsapp_opt_in,o.whatsapp_consent_at,o.whatsapp_consent_version
      FROM integration_demo_order_contact m JOIN shop_order o ON o.id=m.order_id
      WHERE m.company_id=? AND m.connection_id=? AND m.account_id=? AND m.order_id=? AND m.purpose=?`,
    binding.companyId, binding.connectionId, binding.accountId, orderId, purpose);
    if (!row || row.buyer_phone !== recipient) missing(); return row;
  }
  const authority = Object.freeze({
    registerPhone(binding, { appId, wabaId, phoneNumberId }) {
      current(binding); bounded(appId, /^synthetic-[a-z0-9-]+$/);
      // Zero-prefixed IDs are deliberately fictional, never production onboarding metadata.
      bounded(wabaId, /^0\d{4,19}$/); bounded(phoneNumberId, /^0\d{4,19}$/);
      store.run('INSERT INTO integration_demo_phone_binding(company_id,connection_id,account_id,app_id,waba_id,phone_id) VALUES (?,?,?,?,?,?)',
        binding.companyId, binding.connectionId, binding.accountId, appId, wabaId, phoneNumberId);
    },
    registerOrder(binding, orderId) {
      phoneBinding(binding); bounded(orderId, /^[A-Za-z0-9_-]+$/);
      if (!store.get('SELECT id FROM shop_order WHERE id=?', orderId)) missing();
      store.run("INSERT INTO integration_demo_order_contact(company_id,connection_id,order_id,account_id,purpose) VALUES (?,?,?,?,'ORDER_CONTACT')", binding.companyId, binding.connectionId, orderId, binding.accountId);
    },
    revoke(binding, orderId) {
      phoneBinding(binding);
      if (!store.get('SELECT order_id FROM integration_demo_order_contact WHERE company_id=? AND connection_id=? AND order_id=? AND account_id=?', binding.companyId, binding.connectionId, orderId, binding.accountId)) missing();
      store.run('INSERT INTO integration_demo_consent_revocation(company_id,connection_id,order_id,revoked_at) VALUES (?,?,?,?) ON CONFLICT(company_id,connection_id,order_id) DO NOTHING', binding.companyId, binding.connectionId, orderId, clock());
    },
    setTemplateApproval(binding, { name, language, parameterCount, approved }) {
      phoneBinding(binding); bounded(name, /^[a-z0-9_]+$/); bounded(language, /^[a-z]{2,3}(?:_[A-Z]{2})?$/, 10);
      if (!Number.isSafeInteger(parameterCount) || parameterCount < 1 || parameterCount > 10 || typeof approved !== 'boolean') fail('INVALID_INPUT', 'Invalid fixture template record.', 400);
      store.run('INSERT INTO integration_demo_template_approval(company_id,connection_id,name,language,parameter_count,approved) VALUES (?,?,?,?,?,?) ON CONFLICT(company_id,connection_id,name,language) DO UPDATE SET parameter_count=excluded.parameter_count,approved=excluded.approved',
        binding.companyId, binding.connectionId, name, language, parameterCount, Number(approved));
    },
    assertReference: reference,
    resolve(binding, input) {
      const row = reference(binding, input), time = clock(), consentAt = Date.parse(row.whatsapp_consent_at);
      if (row.whatsapp_opt_in !== 1 || row.whatsapp_consent_version !== 'order-contact-v2' || !Number.isSafeInteger(consentAt) || consentAt < 0 || consentAt > time ||
          store.get('SELECT order_id FROM integration_demo_consent_revocation WHERE company_id=? AND connection_id=? AND order_id=?', binding.companyId, binding.connectionId, input.orderId)) fail('CONSENT_REQUIRED', 'Current server order-contact consent is required.');
      const phone = phoneBinding(binding);
      let policy;
      if (input.kind === 'TEXT') {
        const inbound = store.get('SELECT occurred_at FROM integration_demo_inbound_clock WHERE company_id=? AND connection_id=? AND recipient=?', binding.companyId, binding.connectionId, input.recipient);
        if (!inbound || inbound.occurred_at > time || time - inbound.occurred_at >= 86400000) fail('MESSAGE_WINDOW_CLOSED', 'A verified inbound service window is required.');
        policy = { kind: 'TEXT', consent: { optIn: true, at: consentAt, version: row.whatsapp_consent_version }, lastInboundAt: inbound.occurred_at };
      } else if (input.kind === 'TEMPLATE') {
        const template = store.get('SELECT approved,parameter_count FROM integration_demo_template_approval WHERE company_id=? AND connection_id=? AND name=? AND language=?', binding.companyId, binding.connectionId, input.template, input.language);
        if (!template?.approved || template.parameter_count !== input.parameterCount) fail('APPROVED_TEMPLATE_REQUIRED', 'A current account-bound template record is required.');
        policy = { kind: 'TEMPLATE', consent: { optIn: true, at: consentAt, version: row.whatsapp_consent_version }, template: input.template, templateApproved: true };
      } else fail('INVALID_INPUT', 'Unsupported message kind.', 400);
      const proof = freeze(structuredClone({ binding, authorizationRef: { orderId: input.orderId, purpose: input.purpose }, recipient: input.recipient,
        phoneNumberId: phone.phone_id, apiVersion: 'v25.0', language: input.language ?? null, parameterCount: input.parameterCount ?? null, policy }));
      proofs.add(proof); proofSources.set(proof, { authority, binding: structuredClone(binding), input: structuredClone(input) }); return proof;
    },
    resolvePhone(appId, wabaId, phoneNumberId) {
      const row = store.get('SELECT * FROM integration_demo_phone_binding WHERE app_id=? AND waba_id=? AND phone_id=?', appId, wabaId, phoneNumberId);
      if (!row) missing();
      const binding = { companyId: row.company_id, connectionId: row.connection_id, accountId: row.account_id, provider: 'WHATSAPP_CLOUD', environment: 'SYNTHETIC' };
      current(binding); return Object.freeze(binding);
    },
  });
  authorities.add(authority); authorityStores.set(authority, store); return authority;
}
