import 'dotenv/config';
import { z } from 'zod';

/**
 * All configuration comes from environment variables, validated once at startup.
 * Nothing in business logic reads process.env directly.
 */
const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1),

  /** HMAC secret for access tokens. At least 32 characters. */
  JWT_ACCESS_SECRET: z.string().min(32),
  /** Secret mixed into OTP and token hashes so a database leak alone cannot verify codes. */
  HASH_PEPPER: z.string().min(32),
  /** Base64-encoded 32-byte key (AES-256-GCM) for secrets stored in the database, e.g. TOTP seeds. */
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),

  /** Comma-separated list of allowed browser origins, e.g. https://ridewell.rw */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  /** Public URL of the web app, used in links sent to users (admin invites). */
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  /** Number of reverse-proxy hops in front of the API (Caddy = 1). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  /** Secure flag on cookies. Defaults to true outside development/test. */
  COOKIE_SECURE: boolish.optional(),

  /** SMS adapter. `outbox` writes messages to a local file and is refused in production. */
  SMS_PROVIDER: z.enum(['outbox', 'pindo']).default('outbox'),
  /** Pindo (pindo.io) API token, from the Pindo dashboard. Server only. */
  PINDO_API_TOKEN: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** Sender ID shown on RideWELL texts (registered with Pindo). */
  PINDO_SENDER_ID: z.string().max(11).default('RideWELL'),
  /** Email adapter. `outbox` writes messages to a local file and is refused in production. */
  EMAIL_PROVIDER: z.enum(['outbox', 'resend']).default('outbox'),
  /** Resend API key (re_…). Server only. */
  RESEND_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** From address on a domain verified in Resend, e.g. "RideWELL <no-reply@ridewell.rw>". */
  EMAIL_FROM: z.string().max(200).optional().or(z.literal('').transform(() => undefined)),
  /** Optional reply-to address for emails (the support inbox). */
  EMAIL_REPLY_TO: z.email().optional().or(z.literal('').transform(() => undefined)),
  OUTBOX_DIR: z.string().default('var/outbox'),

  /**
   * Private document storage. `local` keeps files AES-256-GCM encrypted under
   * STORAGE_LOCAL_DIR (development only); `s3` uses any S3-compatible bucket
   * (AWS S3, Cloudflare R2, Backblaze B2, MinIO). TBD: production provider.
   */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('var/private-storage'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  /**
   * TEMPORARY: email + password sign-up without email verification, while no email
   * provider is configured. Must be switched off (verification on) before launch.
   */
  EMAIL_SIGNUP_WITHOUT_VERIFICATION: boolish.default(true),

  /**
   * DEVELOPMENT ONLY: a fixed 6-digit code accepted wherever a verification code is
   * asked for (SMS codes, the staff sign-in code, step-up confirmations, staff
   * password reset), so testing works without an SMS provider or authenticator app.
   * SMS limits and lockouts still apply. Refused in production.
   */
  /**
   * DEVELOPMENT AND TEST ONLY: raise the per-IP admin sign-in limit (default 20 per
   * 15 min), so the browser test suite, which signs many staff in from one machine,
   * does not trip it. Refused in production.
   */
  DEV_RATE_LIMIT_ADMIN_LOGIN: z.coerce.number().int().min(1).max(1000).optional().or(z.literal('').transform(() => undefined)),

  DEV_VERIFICATION_CODE: z
    .string()
    .regex(/^\d{6}$/, 'must be exactly 6 digits')
    .optional()
    .or(z.literal('').transform(() => undefined)),

  /**
   * Payment provider. `dev` = DEVELOPMENT ONLY stand-in that confirms payments without
   * moving money, so bookings can be tested end to end; refused in production.
   * A real provider (Paypack) arrives when payments are taken up again.
   */
  PAYMENT_PROVIDER: z.enum(['dev']).default('dev'),

  /**
   * Maps (approved: Google Maps Platform). `dev` = DEVELOPMENT ONLY: no place search
   * results and no ETAs are invented; distance is a straight line, labelled as such.
   * Refused in production. `google` needs MAPS_SERVER_KEY (Places, Routes, Geocoding,
   * server-side only). MAPS_BROWSER_KEY (Maps JavaScript API) is sent to the browser
   * and must be restricted to RideWELL domains in Google Cloud.
   */
  MAPS_PROVIDER: z.enum(['dev', 'google']).default('dev'),
  MAPS_SERVER_KEY: z.string().min(10).optional().or(z.literal('').transform(() => undefined)),
  MAPS_BROWSER_KEY: z.string().min(10).optional().or(z.literal('').transform(() => undefined)),

  /** Background job runner on/off (off in tests; tests drive jobs directly). */
  JOBS_ENABLED: boolish.default(true),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof schema> & { COOKIE_SECURE: boolean };

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const cookieSecure = env.COOKIE_SECURE ?? env.NODE_ENV === 'production';

  if (env.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (env.SMS_PROVIDER === 'outbox') problems.push('SMS_PROVIDER=outbox is not allowed in production; configure a real SMS provider');
    if (env.EMAIL_PROVIDER === 'outbox') problems.push('EMAIL_PROVIDER=outbox is not allowed in production; configure a real email provider');
    if (!cookieSecure) problems.push('COOKIE_SECURE must be true in production');
    if (env.CORS_ORIGINS.some((o) => o.startsWith('http://'))) problems.push('CORS_ORIGINS must use https in production');
    if (env.STORAGE_DRIVER === 'local') problems.push('STORAGE_DRIVER=local is not allowed in production; configure a private S3-compatible bucket');
    if (env.PAYMENT_PROVIDER === 'dev') problems.push('PAYMENT_PROVIDER=dev is not allowed in production; configure a real payment provider');
    if (env.MAPS_PROVIDER === 'dev') problems.push('MAPS_PROVIDER=dev is not allowed in production; configure Google Maps keys');
    if (env.DEV_VERIFICATION_CODE) problems.push('DEV_VERIFICATION_CODE must not be set in production');
    if (env.DEV_RATE_LIMIT_ADMIN_LOGIN) problems.push('DEV_RATE_LIMIT_ADMIN_LOGIN must not be set in production');
    if (env.EMAIL_SIGNUP_WITHOUT_VERIFICATION) problems.push('EMAIL_SIGNUP_WITHOUT_VERIFICATION must be false in production');
    if (problems.length) throw new Error(`Refusing to start in production:\n  ${problems.join('\n  ')}`);
  }

  if (env.SMS_PROVIDER === 'pindo' && !env.PINDO_API_TOKEN) throw new Error('SMS_PROVIDER=pindo requires PINDO_API_TOKEN');
  if (env.EMAIL_PROVIDER === 'resend' && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM');

  if (env.MAPS_PROVIDER === 'google' && !env.MAPS_SERVER_KEY) {
    throw new Error('MAPS_PROVIDER=google requires MAPS_SERVER_KEY');
  }

  if (env.STORAGE_DRIVER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }

  return { ...env, COOKIE_SECURE: cookieSecure };
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test helper: drop the cached config so a test can change process.env. */
export function resetEnvCache(): void {
  cached = null;
}

export const isProduction = () => env().NODE_ENV === 'production';
