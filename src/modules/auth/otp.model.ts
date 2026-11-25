import { Schema, model, type InferSchemaType } from 'mongoose';

export const OTP_PURPOSES = ['login', 'admin_password_reset'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/**
 * One document per (phone, purpose). Holds the current code (hashed) and the
 * counters that enforce: 10-minute expiry, 5 wrong attempts → 15-minute lock,
 * a resend cooldown, and an hourly send cap. Counters live on the phone, not on
 * the code, so requesting a new code does not reset the attempt count.
 */
const otpStateSchema = new Schema(
  {
    phone: { type: String, required: true },
    purpose: { type: String, enum: OTP_PURPOSES, required: true },
    codeHash: { type: String, default: null },
    codeExpiresAt: { type: Date, default: null },
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastSentAt: { type: Date, default: null },
    sendWindowStart: { type: Date, default: null },
    sendCount: { type: Number, default: 0 },
    /** Removed automatically a day after last activity. */
    purgeAt: { type: Date, required: true },
  },
  { versionKey: false },
);

otpStateSchema.index({ phone: 1, purpose: 1 }, { unique: true });
otpStateSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export type OtpState = InferSchemaType<typeof otpStateSchema>;
export const OtpStateModel = model('OtpState', otpStateSchema, 'otpStates');
