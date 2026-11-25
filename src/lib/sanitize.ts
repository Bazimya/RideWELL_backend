import type { RequestHandler } from 'express';
import { badRequest } from './errors.js';

/**
 * Reject any request whose body, query or params contain keys that MongoDB would
 * read as operators (`$gt`, `$where`) or paths (`a.b`). This is the Express 5
 * replacement for express-mongo-sanitize, which does not work with Express 5's
 * read-only req.query. Strict zod schemas are the second layer.
 */
function hasDangerousKey(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (Array.isArray(value)) return value.some((v) => hasDangerousKey(v, depth + 1));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype') return true;
      if (hasDangerousKey(v, depth + 1)) return true;
    }
  }
  return false;
}

export const rejectOperatorKeys: RequestHandler = (req, _res, next) => {
  if (hasDangerousKey(req.body) || hasDangerousKey(req.query) || hasDangerousKey(req.params)) {
    return next(badRequest('invalid_input', 'The request contains characters that are not allowed.'));
  }
  next();
};
