import { FieldError } from './validation.js';

const MAX_BODY = 64 * 1024;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export async function readJson(request, maxBytes = MAX_BODY) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'INVALID_INPUT', 'JSON content type is required.');
  }
  const bytes = await readBody(request, maxBytes);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch {
    throw new ApiError(400, 'INVALID_INPUT', 'Invalid JSON object.');
  }
}

/* Reads a request body into memory, rejecting it as soon as it exceeds maxBytes. */
export async function readBody(request, maxBytes) {
  const tooLarge = () => new ApiError(413, 'INVALID_INPUT', 'Request body is too large.');
  if (Number(request.headers.get('content-length')) > maxBytes) throw tooLarge();
  const chunks = [];
  let length = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function requireOrigin(request, expectedOrigin) {
  if (request.headers.get('origin') !== expectedOrigin) {
    throw new ApiError(403, 'FORBIDDEN', 'Origin is not allowed.');
  }
}

export function errorResponse(error) {
  const invalidField = error instanceof FieldError;
  const known = error instanceof ApiError || invalidField;
  if (!known) console.error('Request failed:', error?.code || error?.name || 'ERROR');
  return json(invalidField ? 400 : known ? error.status : 500, {
    error: {
      code: invalidField ? 'INVALID_INPUT' : known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'An unexpected error occurred.',
      ...(error?.field ? { field: error.field } : {}),
    },
  });
}
