import { createHash } from 'node:crypto';
import { canonicalOperationJson } from './operation-envelope.js';

// One authoritative fingerprint for atomic parent commit and first read-back.
// This is evidence of the resulting projection, never approval authority.
export function catalogCreateParentResultRevision({catalogRevision,mediaRevision,manifestRoot}) {
  if(![catalogRevision,mediaRevision,manifestRoot].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw new TypeError('Invalid parent result revision.');
  return createHash('sha256').update(canonicalOperationJson({version:1,kind:'catalog-create-parent-result',catalogRevision,mediaRevision,manifestRoot})).digest('hex');
}
