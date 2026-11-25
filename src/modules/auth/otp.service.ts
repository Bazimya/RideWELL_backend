import { OtpStateModel, type OtpPurpose } from './otp.model.js';
import { keyedHash, randomDigits, safeEqual } from '../../lib/crypto.js';
import { AppError, tooMany } from '../../lib/errors.js';
import { devCode } from '../../lib/devCode.js';

export const OTP_RULES = {
  codeLength: 6,
  /** Spec: 10 minutes for sign-in. Spec: 30 minutes for a password reset. */
  ttlMs: { login: 10 * 60_000, admin_password_reset: 30 * 60_000 } satisfies Record<OtpPurpose, number>,
  maxFailedAttempts: 5,
  lockMs: 15 * 60_000,
  resendCooldownMs: 60_000,
  maxSendsPerHour: 5,
  purgeAfterMs: 24 * 60 * 60_000,
} as const;

const hashCode = (phone: string, purpose: OtpPurpose, code: string) => keyedHash(`${phone}:${code}`, `otp:${purpose}`);

/**
 * Issue a new code for (phone, purpose), applying the lock, cooldown and hourly cap.
 * Returns the plain code for the caller to send; it is never stored.
 */
export async function issueOtp(phone: string, purpose: OtpPurpose, now = new Date()): Promise<string> {
  const state = await OtpStateModel.findOne({ phone, purpose }).lean();

  if (state?.lockedUntil && state.lockedUntil > now) {
    throw tooMany('Too many attempts. Try again later.', Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 1000));
  }
  if (state?.lastSentAt && now.getTime() - state.lastSentAt.getTime() < OTP_RULES.resendCooldownMs) {
    const wait = Math.ceil((OTP_RULES.resendCooldownMs - (now.getTime() - state.lastSentAt.getTime())) / 1000);
    throw tooMany('Please wait before requesting another code.', wait);
  }
  const windowFresh = state?.sendWindowStart && now.getTime() - state.sendWindowStart.getTime() < 60 * 60_000;
  if (windowFresh && (state?.sendCount ?? 0) >= OTP_RULES.maxSendsPerHour) {
    const wait = Math.ceil((state!.sendWindowStart!.getTime() + 60 * 60_000 - now.getTime()) / 1000);
    throw tooMany('Too many codes requested. Try again later.', wait);
  }

  // Development only (refused in production): a fixed, known code instead of a random one.
  const code = devCode() ?? randomDigits(OTP_RULES.codeLength);
  const lockExpired = Boolean(state?.lockedUntil && state.lockedUntil <= now);
  await OtpStateModel.updateOne(
    { phone, purpose },
    {
      $set: {
        codeHash: hashCode(phone, purpose, code),
        codeExpiresAt: new Date(now.getTime() + OTP_RULES.ttlMs[purpose]),
        lastSentAt: now,
        sendWindowStart: windowFresh ? state!.sendWindowStart : now,
        sendCount: windowFresh ? (state!.sendCount ?? 0) + 1 : 1,
        purgeAt: new Date(now.getTime() + OTP_RULES.purgeAfterMs),
        // A lock that has run out starts the attempt count again.
        ...(lockExpired ? { lockedUntil: null, failedAttempts: 0 } : {}),
      },
    },
    { upsert: true },
  );
  return code;
}

export class OtpInvalidError extends AppError {
  constructor() {
    super(400, 'invalid_code', 'The code is incorrect or has expired.');
  }
}

/**
 * Check a code. Every attempt is counted atomically *before* the comparison, so
 * parallel guesses cannot exceed the limit. The 5th wrong attempt locks the phone
 * for 15 minutes and discards the code. A correct code is consumed (single use).
 */
export async function verifyOtp(phone: string, purpose: OtpPurpose, code: string, now = new Date()): Promise<void> {
  const claimed = await OtpStateModel.findOneAndUpdate(
    {
      phone,
      purpose,
      failedAttempts: { $lt: OTP_RULES.maxFailedAttempts },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    { $inc: { failedAttempts: 1 } },
    { new: true },
  ).lean();

  if (!claimed) {
    const state = await OtpStateModel.findOne({ phone, purpose }).lean();
    if (state?.lockedUntil && state.lockedUntil > now) {
      throw tooMany('Too many attempts. Try again later.', Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 1000));
    }
    throw new OtpInvalidError();
  }

  const ok =
    claimed.codeHash != null &&
    claimed.codeExpiresAt != null &&
    claimed.codeExpiresAt > now &&
    safeEqual(claimed.codeHash, hashCode(phone, purpose, code));

  if (ok) {
    // Consume only if this exact code is still current (a concurrent success cannot reuse it).
    const consumed = await OtpStateModel.updateOne(
      { phone, purpose, codeHash: claimed.codeHash },
      { $set: { codeHash: null, codeExpiresAt: null, failedAttempts: 0, lockedUntil: null } },
    );
    if (consumed.modifiedCount === 1) return;
    throw new OtpInvalidError();
  }

  if (claimed.failedAttempts >= OTP_RULES.maxFailedAttempts) {
    await OtpStateModel.updateOne(
      { phone, purpose },
      { $set: { lockedUntil: new Date(now.getTime() + OTP_RULES.lockMs), codeHash: null, codeExpiresAt: null } },
    );
    throw tooMany('Too many attempts. Try again later.', OTP_RULES.lockMs / 1000);
  }
  throw new OtpInvalidError();
}
