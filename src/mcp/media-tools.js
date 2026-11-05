import { createMediaRuntime } from './media-runtime.js';
import { isMediaCoordinator } from './media-coordinator.js';
import { listMedia } from './media-list.js';
import { mediaLayoutAdapter } from './media-layout-adapter.js';
import { mediaListInput, mediaListOutput, mediaStageInput, mediaStageOutput, mediaLayoutInput, mediaReceiptSchema } from './media-contracts.js';

// Default registration stays closed until actual native MCP/browser acceptance.
export const MEDIA_TOOLS_ACCEPTED = false;

export const mediaListTool = () => Object.freeze({ kind: 'read', name: 'media.list', scope: 'media.read', capability: 'catalog.write',
  inputSchema: mediaListInput, outputSchema: mediaListOutput, read: listMedia });
export function mediaUploadTool(runtime) {
  if (!isMediaCoordinator(runtime?.coordinator)) throw new TypeError('A server-owned media coordinator is required.');
  return Object.freeze({ kind: 'stage', name: 'media.prepare_upload', commitName: 'media.commit_upload', scope: 'media.write', capability: 'catalog.write',
    inputSchema: mediaStageInput, outputSchema: mediaStageOutput, receiptSchema: mediaReceiptSchema, coordinator: runtime.coordinator });
}
export const mediaLayoutTool = runtime => Object.freeze({ previewName: 'media.preview_layout', commitName: 'media.commit_layout',
  scope: 'media.write', capability: 'catalog.write', inputSchema: mediaLayoutInput, receiptSchema: mediaReceiptSchema, adapter: mediaLayoutAdapter(runtime) });
export function mediaTools(options) {
  const runtime = createMediaRuntime(options);
  return Object.freeze([mediaListTool(),mediaUploadTool(runtime),mediaLayoutTool(runtime)]);
}
