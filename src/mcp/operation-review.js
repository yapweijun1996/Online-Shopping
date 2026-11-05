'use strict';

// First-party seller UI. All proposal
// content is untrusted and is rendered only as text.
const statusNode = document.querySelector('#status');
const reviewSection = document.querySelector('#review');
const form = document.querySelector('#decision');
const password = document.querySelector('#password');
const path = /^\/(?:([a-z0-9]{3,30})\/)?oauth\/operation\/?$/.exec(location.pathname);
const base = path?.[1] ? `/${path[1]}` : '';
const id = new URL(location.href).searchParams.get('operationId');
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
document.querySelector('#seller-link').href = `${base}/seller/`;
let csrf = null;
let previewHash = null;
let challenge = null;
let currencyAcknowledgementRequired = false;
const currencyAck = document.querySelector('#currency-ack');
const visible = (value) => value.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
  (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);

async function load() {
  if (!path || [...new URL(location.href).searchParams.keys()].length !== 1 || !idPattern.test(id || '')) throw new Error('Invalid operation.');
  const sessionResponse = await fetch(`${base}/api/v1/seller/session`, { credentials: 'same-origin', cache: 'no-store' });
  if (!sessionResponse.ok) throw new Error('Sign in required.');
  const session = await sessionResponse.json();
  if (typeof session.csrfToken !== 'string' || !session.csrfToken) throw new Error('Invalid session.');
  const response = await fetch(`${base}/api/v1/seller/mcp/operations/${id}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('Proposal unavailable.');
  const value = await response.json();
  if (typeof value.currencyAcknowledgementRequired !== 'boolean' ||
      (value.currencyAcknowledgementRequired ? typeof value.currencyWarning !== 'string' || !value.currencyWarning : value.currencyWarning !== null) ||
      typeof value.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.challenge) || value.operationId !== id || typeof value.previewHash !== 'string' || !hashPattern.test(value.previewHash) ||
      typeof value.shopName !== 'string' || typeof value.accountName !== 'string' || typeof value.clientName !== 'string' ||
      typeof value.clientId !== 'string' ||
      typeof value.toolName !== 'string' || typeof value.resourceType !== 'string' ||
      !(value.resourceId === null || typeof value.resourceId === 'string') || !['LOW', 'MEDIUM', 'HIGH'].includes(value.risk) ||
      typeof value.expiresAt !== 'string' || !value.proposal || typeof value.proposal !== 'object' || Array.isArray(value.proposal)) {
    throw new Error('Invalid proposal.');
  }
  csrf = session.csrfToken;
  previewHash = value.previewHash;
  challenge = value.challenge;
  currencyAcknowledgementRequired = value.currencyAcknowledgementRequired;
  currencyAck.checked = false;
  document.querySelector('#currency-warning').hidden = !currencyAcknowledgementRequired;
  document.querySelector('#currency-warning-text').textContent = value.currencyWarning || '';
  document.querySelector('#shop').textContent = visible(value.shopName);
  document.querySelector('#account').textContent = visible(value.accountName);
  document.querySelector('#client').textContent = visible(value.clientName);
  document.querySelector('#client-id').textContent = visible(value.clientId);
  document.querySelector('#tool').textContent = visible(value.toolName);
  document.querySelector('#target').textContent = visible(`${value.resourceType}: ${value.resourceId || 'new resource'}`);
  document.querySelector('#risk').textContent = value.risk;
  document.querySelector('#expires').textContent = value.expiresAt;
  document.querySelector('#fingerprint').textContent = value.previewHash;
  document.querySelector('#proposal').textContent = visible(JSON.stringify(value.proposal, null, 2));
  reviewSection.hidden = false;
  statusNode.textContent = 'Review the complete proposal, then explicitly approve or reject it.';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const decision = event.submitter?.value;
  if (!csrf || !previewHash || !challenge || !['approve', 'reject'].includes(decision) || !password.value) return;
  if (decision === 'approve' && currencyAcknowledgementRequired && !currencyAck.checked) {
    statusNode.textContent = 'Read the currency warning and check the acknowledgment before approving.';
    currencyAck.focus(); return;
  }
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const response = await fetch(`${base}/api/v1/seller/mcp/operations/${id}/approval`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ operationId: id, previewHash, challenge, decision, password: password.value,
        ...(currencyAcknowledgementRequired && decision === 'approve' ? { currencyAcknowledged: true } : {}),
      }),
    });
    if (!response.ok) throw new Error('Approval failed.');
    const result = await response.json();
    if (result.operationId !== id || result.status !== (decision === 'approve' ? 'APPROVED' : 'REJECTED')) throw new Error('Invalid result.');
    csrf = null; previewHash = null; challenge = null; form.hidden = true;
    statusNode.textContent = decision === 'approve' ? 'Approved. The connected app must still commit this change.' : 'Rejected. The change was not applied.';
  } catch {
    statusNode.textContent = 'The decision could not be verified. Reload the proposal and try again.';
    buttons.forEach((button) => { button.disabled = false; });
  } finally {
    password.value = '';
  }
});

load().catch(() => {
  reviewSection.hidden = true;
  statusNode.textContent = 'The proposal is unavailable. Sign in to Seller Studio and reload this page.';
});
