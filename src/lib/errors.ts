import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger.js';

/**
 * An error that is safe to show to the caller. Anything that is not an AppError
 * becomes a generic 500 and its details go to the server log only.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do this.') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooMany = (message: string, retryAfterSeconds?: number) =>
  new AppError(
    429,
    'too_many_requests',
    message,
    retryAfterSeconds ? { retryAfterSeconds } : undefined,
    retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined,
  );

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('Route not found.'));

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = String(req.id ?? '');

  if (err instanceof AppError) {
    if (err.headers) res.set(err.headers);
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_failed',
        message: 'The request is invalid.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId,
      },
    });
    return;
  }
  // Malformed JSON body from express.json()
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'The request body is not valid JSON.', requestId } });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'The request body is too large.', requestId } });
    return;
  }

  logger.error({ err, requestId, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong.', requestId } });
};
