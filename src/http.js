import { createServer as createHttpServer } from 'node:http';
import { FieldError } from './validation.js';

const MAX_BODY = 64 * 1024;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

export async function readJson(request, maxBytes = MAX_BODY) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'INVALID_INPUT', 'JSON content type is required.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) throw new ApiError(413, 'INVALID_INPUT', 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch {
    throw new ApiError(400, 'INVALID_INPUT', 'Invalid JSON object.');
  }
}

export function requireOrigin(request, expectedOrigin) {
  if (request.headers.origin !== expectedOrigin) {
    throw new ApiError(403, 'FORBIDDEN', 'Origin is not allowed.');
  }
}

export function handleErrors(handler) {
  return createHttpServer(async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      const invalidField = error instanceof FieldError;
      const known = error instanceof ApiError || invalidField;
      if (!known) console.error('Request failed:', error?.code || error?.name || 'ERROR');
      json(response, invalidField ? 400 : known ? error.status : 500, {
        error: {
          code: invalidField ? 'INVALID_INPUT' : known ? error.code : 'INTERNAL_ERROR',
          message: known ? error.message : 'An unexpected error occurred.',
          ...(error.field ? { field: error.field } : {}),
        },
      });
    }
  });
}
