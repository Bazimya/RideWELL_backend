import type { Request, RequestHandler, Response } from 'express';
import { env } from '../../config/env.js';
import { randomToken } from '../../lib/crypto.js';
import { forbidden } from '../../lib/errors.js';

export const API_PREFIX = '/api/v1';
export const REFRESH_COOKIE = 'rw_rt';
export const DEVICE_COOKIE = 'rw_did';
const REFRESH_PATH = `${API_PREFIX}/auth`;
const DEVICE_PATH = `${API_PREFIX}/auth/admin`;

/** Refresh token: httpOnly, Secure, SameSite=Strict, scoped to the auth routes only. */
export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env().COOKIE_SECURE,
    sameSite: 'strict',
    path: REFRESH_PATH,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: env().COOKIE_SECURE, sameSite: 'strict', path: REFRESH_PATH });
}

/** Long-lived random id for this browser, used only to notice admin logins from a new device. */
export function ensureDeviceId(req: Request, res: Response): string {
  const existing = req.cookies?.[DEVICE_COOKIE];
  if (typeof existing === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(existing)) return existing;
  const id = randomToken(24);
  res.cookie(DEVICE_COOKIE, id, {
    httpOnly: true,
    secure: env().COOKIE_SECURE,
    sameSite: 'strict',
    path: DEVICE_PATH,
    maxAge: 365 * 24 * 60 * 60_000,
  });
  return id;
}

/**
 * Routes authenticated by cookie (refresh, logout) also require a custom header.
 * A cross-site form or image cannot set it, and a cross-site fetch that sets it
 * triggers a CORS preflight that our origin allowlist rejects.
 */
export const requireClientHeader: RequestHandler = (req, _res, next) => {
  if (req.get('x-ridewell-client') !== 'web') return next(forbidden('Missing client header.'));
  next();
};
