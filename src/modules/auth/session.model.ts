import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * A sign-in session = one refresh-token family. The refresh token rotates on every
 * use; the previous hashes are kept so a replayed (stolen) token is detected and
 * the whole family is revoked.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['user', 'admin'], required: true },
    currentTokenHash: { type: String, required: true, select: false },
    usedTokenHashes: { type: [String], default: [], select: false },
    /** Absolute expiry: 30 days for users, 8 hours for admins. Not extended by refreshes. */
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: () => new Date() },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 400 },
    /** Deleted from the collection 30 days after expiry. */
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);

sessionSchema.index({ userId: 1, revokedAt: 1 });
sessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export type Session = InferSchemaType<typeof sessionSchema>;
export type SessionDoc = HydratedDocument<Session>;
export const SessionModel = model('Session', sessionSchema, 'sessions');
