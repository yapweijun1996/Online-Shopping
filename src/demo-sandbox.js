import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError, json, readJson, requireOrigin } from './http.js';
import { FieldError, boundedText } from './validation.js';
import { validateProductInput } from './product-input.js';
import galleries from './public-demo-gallery.json' with { type: 'json' };
import { integrationCatalog } from '../public/shared/integration-catalog.js';

const COOKIE = 'os_fictional_demo';
const TTL = 60 * 60 * 1000;
const MAX_SESSIONS = 32;
const MAX_ROWS = 100;
const missing = () => { throw new ApiError(404, 'NOT_FOUND', 'Not found.'); };
const forbidden = () => { throw new ApiError(403, 'FORBIDDEN', 'This preview role cannot perform that action.'); };
const digest = value => createHash('sha256').update(value).digest('hex');
const tokenFrom = request => request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

function fields(body, allowed, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(body, key))) {
    throw new FieldError('demo', 'Enter supported preview fields.');
  }
}
function revision(record, body) {
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) throw new FieldError('expectedRevision', 'Enter the current revision.');
  if (record.revision !== body.expectedRevision) throw new ApiError(409, 'STALE_REVISION', 'Reload the changed preview record.');
}
function currency(value) {
  if (!['MYR', 'SGD'].includes(value)) throw new FieldError('currency', 'Choose MYR or SGD.');
  return value;
}
function boolean(value) {
  if (typeof value !== 'boolean') throw new FieldError('active', 'Choose availability.');
  return value;
}

function freshWorkspace() {
  const companies = [
    { id: 'company-alpha', name: 'Fictional Alpha Store', currency: 'MYR', active: true, revision: 1 },
    { id: 'company-beta', name: 'Fictional Beta Store', currency: 'SGD', active: true, revision: 1 },
  ];
  const sellers = companies.map((company, index) => ({
    id: index ? 'seller-beta' : 'seller-alpha', companyId: company.id,
    name: index ? 'Preview Seller Beta' : 'Preview Seller Alpha', active: true, revision: 1,
  }));
  const products = companies.flatMap(company => Object.entries(galleries.products).map(([sku, gallery], index) => ({
    id: randomUUID(), companyId: company.id, sku, name: gallery.name,
    description: 'Fictional sandbox product. No payment, shipment or buyer contact occurs.',
    category: 'GENERAL', priceMinor: 990 + index * 100, currency: company.currency, active: true,
    images: gallery.media.map(item => item.src), revision: 1,
  })));
  const customers = companies.map(company => ({ id: randomUUID(), companyId: company.id, fullName: 'Fictional Customer', email: 'customer@example.invalid', revision: 1 }));
  const orders = companies.map(company => {
    const product = products.find(item => item.companyId === company.id);
    const customer = customers.find(item => item.companyId === company.id);
    return { id: randomUUID(), companyId: company.id, orderNo: `DEMO-${company.id}-001`, customerId: customer.id,
      buyer: { fullName: customer.fullName, email: customer.email },
      items: [{ productId: product.id, sku: product.sku, name: product.name, priceMinor: product.priceMinor, currency: product.currency, quantity: 1 }],
      totalMinor: product.priceMinor, currency: product.currency, status: 'SUBMITTED', revision: 1,
      events: [{ actor: 'synthetic-seed', from: null, to: 'SUBMITTED' }],
    };
  });
  return { companies, sellers, products, customers, orders, audit: [] };
}

// Deliberately receives no live store, privileged session or credential. The only
// state is bounded ephemeral fiction; each login owns an independent workspace.
export function createDemoSandbox({ enabled, production, now = Date.now } = {}) {
  const sessions = new Map();
  const starts = new Map();
  const cookie = (token, clear = false) => `${COOKIE}=${clear ? '' : token}; Path=/api/v1/demo/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : TTL / 1000}${production ? '; Secure' : ''}`;
  function prune() {
    for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
    for (const [key, times] of starts) if (!times.some(time => time > now() - 60_000)) starts.delete(key);
  }
  function requireSession(request) {
    const token = tokenFrom(request);
    const session = token && sessions.get(digest(token));
    if (!session || session.expiresAt <= now()) throw new ApiError(401, 'UNAUTHORIZED', 'Start a new fictional preview session.');
    if (session.role === 'SELLER') {
      const membership = session.data.sellers.find(seller => seller.id === session.principalId);
      if (!membership?.active) forbidden();
    }
    return session;
  }
  function companyFor(session, id) {
    const company = session.data.companies.find(company => company.id === id);
    if (!company) missing();
    if (session.role === 'SELLER') {
      const membership = session.data.sellers.find(seller => seller.id === session.principalId);
      if (membership?.companyId !== id) missing();
      if (!company.active) forbidden();
    }
    return company;
  }
  function admin(session) { if (session.role !== 'ADMIN') forbidden(); }
  function capacity(rows) { if (rows.length >= MAX_ROWS) throw new ApiError(409, 'DEMO_LIMIT', 'Reset this bounded preview workspace.'); }
  function audit(session, resource, action) {
    capacity(session.data.audit);
    session.data.audit.push({ id: randomUUID(), actor: session.principalId, role: session.role, resource, action, at: new Date(now()).toISOString() });
  }
  return async function demoRoute(request, expectedOrigin, clientAddress = 'unknown') {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/v1/demo/')) return null;
    if (!enabled) missing();
    prune();
    const path = url.pathname.slice('/api/v1/demo/'.length);
    const method = request.method;
    // Reverse proxies can check the mode gate before serving fictional assets.
    if (method === 'GET' && path === 'availability') return json(200, { available: true });
    if (method === 'POST' && path === 'session') {
      requireOrigin(request, expectedOrigin);
      const body = await readJson(request, 1024); fields(body, ['role'], ['role']);
      if (!['ADMIN', 'SELLER'].includes(body.role)) throw new FieldError('role', 'Choose a fictional preview role.');
      const times = (starts.get(clientAddress) || []).filter(time => time > now() - 60_000);
      if (times.length >= 10 || starts.size >= 128 && !starts.has(clientAddress)) throw new ApiError(429, 'RATE_LIMITED', 'Try again later.');
      times.push(now()); starts.set(clientAddress, times);
      const old = tokenFrom(request); if (old) sessions.delete(digest(old));
      if (sessions.size >= MAX_SESSIONS) throw new ApiError(429, 'DEMO_CAPACITY', 'Preview workspaces are busy. Try again later.');
      const token = randomBytes(32).toString('hex');
      const session = { role: body.role, principalId: body.role === 'ADMIN' ? 'demo-admin' : 'seller-alpha',
        csrfToken: randomBytes(32).toString('hex'), expiresAt: now() + TTL, data: freshWorkspace() };
      sessions.set(digest(token), session);
      return json(201, { role: session.role, csrfToken: session.csrfToken, expiresAt: session.expiresAt }, { 'Set-Cookie': cookie(token) });
    }
    const session = requireSession(request);
    if (method !== 'GET') {
      requireOrigin(request, expectedOrigin);
      if (request.headers.get('x-csrf-token') !== session.csrfToken) forbidden();
    }
    if (path === 'session') {
      if (method === 'GET') return json(200, { role: session.role, principalId: session.principalId, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
      if (method === 'DELETE') { sessions.delete(digest(tokenFrom(request))); return json(200, { ended: true }, { 'Set-Cookie': cookie('', true) }); }
    }
    if (path === 'reset' && method === 'POST') {
      const body = await readJson(request, 1024); fields(body, []);
      requireSession(request);
      if (request.headers.get('x-csrf-token') !== session.csrfToken) forbidden();
      session.data = freshWorkspace();
      // Custom memberships disappear on reset; keep a valid fictional Seller
      // identity without restoring the Admin privileges used to enter this view.
      if (session.role === 'SELLER' && !session.data.sellers.some(seller => seller.id === session.principalId)) {
        session.principalId = 'seller-alpha';
      }
      session.csrfToken = randomBytes(32).toString('hex');
      return json(200, { reset: true, role: session.role, principalId: session.principalId, csrfToken: session.csrfToken });
    }
    // Synchronous state changes below cannot interleave after body parsing. A
    // cloned workspace provides rollback if validation or audit insertion fails.
    const body = method === 'GET' ? null : await readJson(request, 16 * 1024);
    requireSession(request);
    if (method !== 'GET' && request.headers.get('x-csrf-token') !== session.csrfToken) forbidden();
    const before = session.data;
    if (method !== 'GET') session.data = structuredClone(before);
    try {
      if (path === 'assume-seller' && method === 'POST') {
        admin(session); fields(body, ['sellerId'], ['sellerId']);
        const seller = session.data.sellers.find(item => item.id === body.sellerId);
        if (!seller?.active || !session.data.companies.find(item => item.id === seller.companyId)?.active) missing();
        audit(session, seller.id, 'ASSUME_FICTIONAL_SELLER');
        session.role = 'SELLER'; session.principalId = seller.id; session.csrfToken = randomBytes(32).toString('hex');
        return json(200, { role: session.role, principalId: seller.id, csrfToken: session.csrfToken });
      }
      if (path === 'companies') {
        if (method === 'GET') return json(200, { items: session.data.companies.filter(company => session.role === 'ADMIN' || session.data.sellers.some(seller => seller.id === session.principalId && seller.companyId === company.id)) });
        admin(session);
        if (method === 'POST') {
          fields(body, ['name', 'currency'], ['name', 'currency']); capacity(session.data.companies);
          const company = { id: randomUUID(), name: boundedText(body.name, 'name', 80), currency: currency(body.currency), active: true, revision: 1 };
          session.data.companies.push(company); audit(session, company.id, 'CREATE_COMPANY'); return json(201, company);
        }
      }
      if (path === 'sellers') {
        admin(session);
        if (method === 'GET') return json(200, { items: session.data.sellers });
        if (method === 'POST') {
          fields(body, ['name', 'companyId'], ['name', 'companyId']); companyFor(session, body.companyId); capacity(session.data.sellers);
          const seller = { id: randomUUID(), companyId: body.companyId, name: boundedText(body.name, 'name', 80), active: true, revision: 1 };
          session.data.sellers.push(seller); audit(session, seller.id, 'CREATE_FICTIONAL_SELLER'); return json(201, seller);
        }
      }
      const sellerPath = /^sellers\/([^/]+)$/.exec(path);
      if (sellerPath && method === 'PATCH') {
        admin(session); const seller = session.data.sellers.find(item => item.id === sellerPath[1]); if (!seller) missing();
        fields(body, ['active', 'expectedRevision'], ['active', 'expectedRevision']); revision(seller, body);
        seller.active = boolean(body.active); seller.revision++; audit(session, seller.id, 'SET_FICTIONAL_ACCESS'); return json(200, seller);
      }
      const integrationPath = /^companies\/([^/]+)\/integrations$/.exec(path);
      if (integrationPath && method === 'GET') {
        const company = companyFor(session, integrationPath[1]);
        return json(200, { companyId: company.id, ...integrationCatalog() });
      }
      const match = /^companies\/([^/]+)(?:\/(products|orders|customers)(?:\/([^/]+)(?:\/(confirm|reject))?)?)?$/.exec(path);
      if (!match) missing();
      const company = companyFor(session, match[1]);
      const [, , collection, id, decision] = match;
      if (!collection) {
        if (method === 'GET') return json(200, company);
        if (method === 'PATCH') {
          admin(session); fields(body, ['name', 'currency', 'active', 'expectedRevision'], ['expectedRevision']); revision(company, body);
          if (Object.hasOwn(body, 'currency')) {
            currency(body.currency);
            if (session.data.products.some(product => product.companyId === company.id && product.currency !== body.currency)) throw new ApiError(409, 'COMPANY_CURRENCY_CONFLICT', 'Existing prices require explicit review.');
            company.currency = body.currency;
          }
          if (Object.hasOwn(body, 'name')) company.name = boundedText(body.name, 'name', 80);
          if (Object.hasOwn(body, 'active')) company.active = boolean(body.active);
          company.revision++; audit(session, company.id, 'UPDATE_COMPANY'); return json(200, company);
        }
        missing();
      }
      const rows = session.data[collection];
      const record = id && rows.find(item => item.id === id && item.companyId === company.id);
      if (id && !record) missing();
      if (method === 'GET' && !decision) return json(200, id ? record : { items: rows.filter(item => item.companyId === company.id) });
      if (collection === 'products' && !decision && ['POST', 'PATCH'].includes(method)) {
        if (method === 'POST' && id || method === 'PATCH' && !id) missing();
        fields(body, ['sku', 'name', 'description', 'category', 'priceMinor', 'currency', 'active', 'expectedRevision']);
        const { expectedRevision, ...input } = body;
        if (method === 'PATCH') revision(record, body);
        else if (Object.hasOwn(body, 'expectedRevision')) throw new FieldError('expectedRevision', 'This field is for edits.');
        const product = validateProductInput(method === 'POST' ? { currency: company.currency, ...input } : input, [company.currency], { partial: method === 'PATCH' });
        if (Object.hasOwn(product, 'image') || Object.hasOwn(product, 'variantGroup') || Object.hasOwn(product, 'variantLabel')) throw new FieldError('product', 'Preview editing supports product text, price, category and availability.');
        const sku = product.sku || record?.sku;
        if (rows.some(item => item.companyId === company.id && item.sku === sku && item.id !== id)) throw new ApiError(409, 'DUPLICATE_SKU', 'SKU already exists in this company.');
        if (record) { Object.assign(record, product); record.revision++; audit(session, record.id, 'UPDATE_PRODUCT'); return json(200, record); }
        capacity(rows); const created = { ...product, id: randomUUID(), companyId: company.id, images: [], revision: 1 };
        rows.push(created); audit(session, created.id, 'CREATE_PRODUCT'); return json(201, created);
      }
      if (collection === 'orders' && record && decision && method === 'POST') {
        fields(body, ['expectedRevision', ...(decision === 'reject' ? ['reason'] : [])], ['expectedRevision']); revision(record, body);
        if (record.status !== 'SUBMITTED') throw new ApiError(409, 'INVALID_STATE', 'Only submitted orders can be decided.');
        const reason = decision === 'reject' ? boundedText(body.reason, 'reason', 300) : null;
        const next = decision === 'confirm' ? 'CONFIRMED' : 'REJECTED';
        record.events.push({ actor: session.principalId, from: record.status, to: next, ...(reason ? { reason } : {}) });
        record.status = next; record.revision++; audit(session, record.id, next); return json(200, record);
      }
      missing();
    } catch (error) { if (method !== 'GET') session.data = before; throw error; }
  };
}
