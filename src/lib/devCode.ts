import { env } from '../config/env.js';
import { safeEqual } from './crypto.js';

/**
 * DEVELOPMENT ONLY. While no SMS provider is set up and authenticator apps are not
 * in use for testing, DEV_VERIFICATION_CODE is accepted wherever a verification
 * code is asked for: SMS codes, the staff sign-in code, step-up confirmations and
 * the staff password reset. Never active in production: env.ts refuses to start
 * with the variable set, and this function checks NODE_ENV again.
 */
export function devCode(): string | undefined {
  const e = env();
  return e.NODE_ENV === 'production' ? undefined : e.DEV_VERIFICATION_CODE;
}

export function isDevCode(code: string | undefined | null): boolean {
  const dc = devCode();
  return Boolean(dc && code && safeEqual(code, dc));
}
