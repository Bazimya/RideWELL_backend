import { rateLimit, type Options } from 'express-rate-limit';

/**
 * Per-IP limits on abuse-prone routes. Per-phone and per-account limits are
 * enforced separately in the database (OTP state, admin lockout), so they hold
 * across instances. The in-memory store here is per instance: move it to a shared
 * store before running more than one API instance.
 */
export interface RateLimitConfig {
  windowMs: number;
  otpRequest: number;
  otpVerify: number;
  adminLogin: number;
  passwordLogin: number;
  upload: number;
  booking: number;
  maps: number;
  tracking: number;
  general: number;
}

export const defaultRateLimits: RateLimitConfig = {
  windowMs: 15 * 60_000,
  otpRequest: 10,
  otpVerify: 30,
  adminLogin: 20,
  passwordLogin: 30,
  upload: 60,
  booking: 300,
  /** Place search calls a billed API: about 10 calls per address typed. */
  maps: 150,
  /** One location every 10 s is 90 per 15 min per driver. */
  tracking: 400,
  general: 1000,
};

function limiter(windowMs: number, limit: number) {
  const opts: Partial<Options> = {
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'too_many_requests', message: 'Too many requests. Try again later.' } });
    },
  };
  return rateLimit(opts);
}

export function buildRateLimiters(cfg: RateLimitConfig) {
  return {
    otpRequest: limiter(cfg.windowMs, cfg.otpRequest),
    otpVerify: limiter(cfg.windowMs, cfg.otpVerify),
    adminLogin: limiter(cfg.windowMs, cfg.adminLogin),
    passwordLogin: limiter(cfg.windowMs, cfg.passwordLogin),
    upload: limiter(cfg.windowMs, cfg.upload),
    booking: limiter(cfg.windowMs, cfg.booking),
    maps: limiter(cfg.windowMs, cfg.maps),
    tracking: limiter(cfg.windowMs, cfg.tracking),
    general: limiter(cfg.windowMs, cfg.general),
  };
}

export type RateLimiters = ReturnType<typeof buildRateLimiters>;
