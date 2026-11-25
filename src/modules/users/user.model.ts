import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { ROLES } from './roles.js';
import { PERMISSIONS, effectivePermissions } from './permissions.js';

export const USER_STATUSES = ['pending_setup', 'active', 'suspended', 'anonymised'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

const twoFactorSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    /** TOTP seed, AES-256-GCM encrypted. Never returned by queries unless selected. */
    secretEnc: { type: String, select: false },
    /** Seed generated during setup, not yet confirmed with a code. */
    pendingSecretEnc: { type: String, select: false },
    enabledAt: Date,
    /** Highest TOTP time step accepted so far: a code can never be used twice. */
    lastUsedStep: { type: Number, default: 0 },
    recoveryCodeHashes: { type: [String], select: false, default: undefined },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    /** E.164. Main identity for SMS sign-in. Optional for accounts created with email. */
    phone: { type: String },
    phoneVerifiedAt: Date,
    email: { type: String, lowercase: true, trim: true },
    emailVerifiedAt: Date,
    firstName: { type: String, trim: true, maxlength: 80 },
    lastName: { type: String, trim: true, maxlength: 80 },
    roles: { type: [String], enum: ROLES, default: ['customer'] },
    /** Staff only: the permissions a Super Admin ticked. Super Admins hold all implicitly. */
    permissions: { type: [String], enum: PERMISSIONS, default: [] },
    status: { type: String, enum: USER_STATUSES, default: 'active' },

    // Password: required for admins; optional for customers and partners, who can
    // sign in by SMS code or by email + password.
    passwordHash: { type: String, select: false },
    passwordChangedAt: Date,
    twoFactor: { type: twoFactorSchema, default: () => ({}) },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: Date,
    /** Hashes of device ids an admin has signed in from; a new one is audit-logged. */
    knownDeviceHashes: { type: [String], select: false, default: undefined },

    lastLoginAt: Date,
    suspendedAt: Date,
    suspendedReason: String,
  },
  { timestamps: true },
);

userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } }, name: 'phone_unique' });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } }, name: 'email_unique' });
userSchema.index({ roles: 1, status: 1 });

export type User = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<User>;
export const UserModel = model('User', userSchema, 'users');

/** The fields a user may see about themselves. */
export function toSelfView(u: UserDoc) {
  return {
    id: u.id as string,
    phone: u.phone ?? null,
    email: u.email ?? null,
    emailVerified: Boolean(u.emailVerifiedAt),
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    roles: u.roles,
    permissions: effectivePermissions(u),
    status: u.status,
    twoFactorEnabled: Boolean(u.twoFactor?.enabled),
    hasPassword: Boolean(u.passwordChangedAt),
    createdAt: u.createdAt,
  };
}
