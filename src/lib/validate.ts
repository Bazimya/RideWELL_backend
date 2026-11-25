import type { RequestHandler } from 'express';
import { z } from 'zod';
import { badRequest } from './errors.js';

type Schemas = {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
};

/**
 * Validate request parts with strict schemas. Results go on `req.valid`; handlers
 * read only from there, never from req.body directly. Schemas should be built with
 * z.strictObject so unknown fields (e.g. `role`, `status`) are rejected, not ignored.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const valid: Record<string, unknown> = {};
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        return next(
          badRequest(
            'validation_failed',
            'The request is invalid.',
            result.error.issues.map((i) => ({ path: [part, ...i.path].join('.'), message: i.message })),
          ),
        );
      }
      valid[part] = result.data;
    }
    req.valid = valid as NonNullable<typeof req.valid>;
    next();
  };
}

/** Typed accessor used inside handlers. */
export function valid<T>(req: { valid?: Record<string, unknown> }, part: 'body' | 'query' | 'params'): T {
  return (req.valid?.[part] ?? {}) as T;
}

export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
