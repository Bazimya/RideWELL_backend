import type { ClientSession } from 'mongoose';
import { UserModel } from '../users/user.model.js';
import { ADMIN_ROLES, MAX_SUPER_ADMINS, hasAdminRole, type Role } from '../users/roles.js';
import { PERMISSIONS, type Permission } from '../users/permissions.js';
import { checkPassword, hashPassword, passwordProblem } from './password.js';
import { checkTotp, newRecoveryCodes, newTotpSecret, otpauthUri } from './totp.service.js';
import { consumeRecovery, consumeTotp } from './twoFactor.js';
import { createSession, revokeAllSessions, signMfaChallenge, verifyMfaChallenge, type IssuedSession } from './token.service.js';
import { issueOtp, verifyOtp } from './otp.service.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { sendSms } from '../notifications/notification.service.js';
import { keyedHash } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { withTransaction } from '../../db/transaction.js';
import { logger } from '../../lib/logger.js';
import type { RequestMeta } from './customerAuth.service.js';
import { assertNotLocked, isLocked, registerLoginFailure } from './lockout.js';
import { devCode, isDevCode } from '../../lib/devCode.js';

const INVALID_CREDENTIALS = () =>
  new AppError(401, 'invalid_credentials', 'Email or password is incorrect. After 5 failed attempts, sign-in is paused for 15 minutes.');

const personal = (u: { email?: string | null; firstName?: string | null; lastName?: string | null; phone?: string | null }) => [
  u.email ?? '',
  (u.email ?? '').split('@')[0] ?? '',
  u.firstName ?? '',
  u.lastName ?? '',
  (u.phone ?? '').slice(-6),
];

function checkPermissions(list: string[]): Permission[] {
  const valid = new Set<string>(PERMISSIONS);
  const bad = list.filter((p) => !valid.has(p));
  if (bad.length) throw badRequest('invalid_permission', `Unknown permission: ${bad.join(', ')}`);
  return [...new Set(list)] as Permission[];
}

// ---------------------------------------------------------------------------
// Staff accounts: created by a Super Admin, who sets the password and ticks the
// permissions. The staff member sets up their authenticator on first sign-in.
// ---------------------------------------------------------------------------

export interface NewStaffInput {
  email: string;
  phone?: string | null;
  firstName: string;
  lastName: string;
  password: string;
  accountType: 'staff' | 'super_admin';
  permissions: string[];
}

export async function createStaffAccount(input: NewStaffInput, actor: AuditActor, meta: Partial<RequestMeta> = {}) {
  const problem = passwordProblem(input.password, personal(input));
  if (problem) throw badRequest('weak_password', problem);
  const permissions = input.accountType === 'super_admin' ? [] : checkPermissions(input.permissions);
  const passwordHash = await hashPassword(input.password);

  return withTransaction(async (session) => {
    if (input.accountType === 'super_admin') {
      const count = await UserModel.countDocuments({ roles: 'super_admin', status: 'active' }, { session });
      if (count >= MAX_SUPER_ADMINS) throw conflict('super_admin_limit', `There can be at most ${MAX_SUPER_ADMINS} super admins.`);
    }
    const or: Record<string, unknown>[] = [{ email: input.email }];
    if (input.phone) or.push({ phone: input.phone });
    const clash = await UserModel.findOne({ $or: or }, { _id: 1 }, { session }).lean();
    if (clash) {
      throw conflict('account_exists', 'Another RideWELL account already uses this email or phone number. Staff accounts need their own.');
    }
    const [user] = await UserModel.create(
      [
        {
          email: input.email,
          phone: input.phone || undefined,
          firstName: input.firstName,
          lastName: input.lastName,
          roles: [input.accountType],
          permissions,
          status: 'active',
          passwordHash,
          passwordChangedAt: new Date(),
        },
      ],
      { session },
    );
    await recordAudit(
      {
        actor,
        action: 'staff.created',
        targetType: 'user',
        targetId: user!.id,
        after: { accountType: input.accountType, email: input.email, permissions },
        ...meta,
      },
      session,
    );
    return { userId: user!.id as string };
  });
}

async function loadStaff(id: string, session?: ClientSession) {
  const user = await UserModel.findById(id, null, session ? { session } : {});
  if (!user || !hasAdminRole(user.roles as Role[])) throw notFound('Staff account not found.');
  return user;
}

/** Change a staff member's name, phone or permissions. Takes effect on their next request. */
export async function updateStaffAccount(
  id: string,
  input: { firstName?: string; lastName?: string; phone?: string | null; permissions?: string[] },
  actor: AuditActor & { type: 'user' },
  meta: Partial<RequestMeta> = {},
) {
  await withTransaction(async (session) => {
    const user = await loadStaff(id, session);
    const before = { firstName: user.firstName, lastName: user.lastName, phone: user.phone ?? null, permissions: [...user.permissions] };
    if (input.permissions !== undefined) {
      if (user.roles.includes('super_admin')) throw badRequest('super_admin_all_permissions', 'Super admins always hold every permission.');
      user.permissions = checkPermissions(input.permissions) as never;
    }
    if (input.firstName !== undefined) user.firstName = input.firstName;
    if (input.lastName !== undefined) user.lastName = input.lastName;
    if (input.phone !== undefined) user.phone = input.phone ?? undefined;
    try {
      await user.save({ session });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw conflict('account_exists', 'Another account already uses this phone number.');
      throw err;
    }
    await recordAudit(
      {
        actor,
        action: 'staff.updated',
        targetType: 'user',
        targetId: id,
        before,
        after: { firstName: user.firstName, lastName: user.lastName, phone: user.phone ?? null, permissions: [...user.permissions] },
        ...meta,
      },
      session,
    );
  });
}

/** Super Admin sets a new password for a staff member; all their sessions end. */
export async function setStaffPassword(id: string, password: string, actor: AuditActor & { type: 'user' }, meta: Partial<RequestMeta> = {}) {
  const user = await loadStaff(id);
  if (id === actor.id) throw forbidden('Change your own password with the password reset.');
  const problem = passwordProblem(password, personal(user));
  if (problem) throw badRequest('weak_password', problem);
  await UserModel.updateOne({ _id: id }, { $set: { passwordHash: await hashPassword(password), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
  const revoked = await revokeAllSessions(id, 'password_set_by_super_admin');
  await recordAudit({ actor, action: 'staff.password_set', targetType: 'user', targetId: id, after: { sessionsRevoked: revoked }, ...meta });
}

/** Clear a staff member's authenticator (lost phone): they set it up again at next sign-in. */
export async function resetStaffTwoFactor(id: string, actor: AuditActor & { type: 'user' }, meta: Partial<RequestMeta> = {}) {
  await loadStaff(id);
  if (id === actor.id) throw forbidden('Ask the other super admin to reset your authenticator.');
  await UserModel.updateOne(
    { _id: id },
    { $set: { 'twoFactor.enabled': false, 'twoFactor.lastUsedStep': 0 }, $unset: { 'twoFactor.secretEnc': 1, 'twoFactor.pendingSecretEnc': 1, 'twoFactor.recoveryCodeHashes': 1, 'twoFactor.enabledAt': 1 } },
  );
  const revoked = await revokeAllSessions(id, 'two_factor_reset');
  await recordAudit({ actor, action: 'staff.two_factor_reset', targetType: 'user', targetId: id, after: { sessionsRevoked: revoked }, ...meta });
}

// ---------------------------------------------------------------------------
// Staff sign-in: password, then authenticator code (set up on first sign-in)
// ---------------------------------------------------------------------------

export async function adminPasswordStep(email: string, password: string): Promise<{ mfaToken: string; setupRequired: boolean }> {
  const user = await UserModel.findOne({ email: email.toLowerCase() }).select('+passwordHash').lean();
  // Always run bcrypt, so a missing account takes as long as a wrong password.
  const ok = await checkPassword(password, user?.passwordHash);
  if (!user || !hasAdminRole(user.roles as Role[])) throw INVALID_CREDENTIALS();
  // A locked account gets the same answer as a wrong password, so the response
  // never reveals which emails belong to staff.
  if (isLocked(user)) throw INVALID_CREDENTIALS();
  if (!ok || user.status !== 'active') {
    await registerLoginFailure(String(user._id));
    throw INVALID_CREDENTIALS();
  }
  // Development: with a development code configured, authenticator setup is skipped
  // and the code step accepts that code.
  return { mfaToken: signMfaChallenge(String(user._id)), setupRequired: !user.twoFactor?.enabled && !devCode() };
}

async function mfaUser(mfaToken: string) {
  const userId = verifyMfaChallenge(mfaToken);
  if (!userId) throw new AppError(401, 'mfa_expired', 'Your sign-in took too long. Enter your email and password again.');
  const user = await UserModel.findById(userId).select('+knownDeviceHashes +twoFactor.pendingSecretEnc').lean();
  if (!user || user.status !== 'active' || !hasAdminRole(user.roles as Role[])) throw INVALID_CREDENTIALS();
  assertNotLocked(user);
  return { userId, user };
}

/** Open an admin session after the second factor, logging new devices. */
async function openAdminSession(
  userId: string,
  roles: string[],
  knownDeviceHashes: string[],
  deviceId: string,
  meta: RequestMeta,
  loginDetails: Record<string, unknown>,
): Promise<IssuedSession> {
  const deviceHash = keyedHash(deviceId, 'admin-device');
  const isNewDevice = !knownDeviceHashes.includes(deviceHash);
  await UserModel.updateOne(
    { _id: userId },
    {
      $set: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      ...(isNewDevice ? { $push: { knownDeviceHashes: { $each: [deviceHash], $slice: -20 } } } : {}),
    },
  );
  const session = await createSession({ userId, kind: 'admin', ip: meta.ip, userAgent: meta.userAgent });
  const actor: AuditActor = { type: 'user', id: userId, roles };
  if (isNewDevice) await recordAudit({ actor, action: 'auth.admin_new_device', targetType: 'session', targetId: session.sessionId, ...meta });
  await recordAudit({ actor, action: 'auth.admin_login', targetType: 'session', targetId: session.sessionId, after: loginDetails, ...meta });
  return session;
}

/** First sign-in, step 1: generate the authenticator secret to scan. */
export async function startTwoFactorSetup(mfaToken: string) {
  const { userId, user } = await mfaUser(mfaToken);
  if (user.twoFactor?.enabled) throw conflict('two_factor_enabled', 'Two-step verification is already set up. Enter your authenticator code.');
  const { secret, secretEnc } = newTotpSecret();
  await UserModel.updateOne({ _id: userId }, { $set: { 'twoFactor.pendingSecretEnc': secretEnc } });
  return { otpauthUri: otpauthUri(user.email ?? 'staff', secret), secret };
}

/** First sign-in, step 2: confirm a code, enable 2FA, receive recovery codes, signed in. */
export async function confirmTwoFactorSetup(mfaToken: string, code: string, deviceId: string, meta: RequestMeta) {
  const { userId, user } = await mfaUser(mfaToken);
  const pending = user.twoFactor?.pendingSecretEnc;
  if (user.twoFactor?.enabled || !pending) throw conflict('setup_not_started', 'Start the authenticator setup first.');
  const step = checkTotp(code, pending, 0);
  if (step === null) {
    await registerLoginFailure(userId);
    throw badRequest('invalid_code', 'The authenticator code is incorrect. Check the time on your phone and try again.');
  }
  const { codes, hashes } = newRecoveryCodes();
  const res = await UserModel.updateOne(
    { _id: userId, 'twoFactor.enabled': { $ne: true } },
    {
      $set: {
        'twoFactor.enabled': true,
        'twoFactor.secretEnc': pending,
        'twoFactor.enabledAt': new Date(),
        'twoFactor.lastUsedStep': step,
        'twoFactor.recoveryCodeHashes': hashes,
      },
      $unset: { 'twoFactor.pendingSecretEnc': 1 },
    },
  );
  if (res.modifiedCount !== 1) throw conflict('two_factor_enabled', 'Two-step verification is already set up.');
  await recordAudit({ actor: { type: 'user', id: userId, roles: user.roles }, action: 'auth.two_factor_enabled', targetType: 'user', targetId: userId, ...meta });
  const session = await openAdminSession(userId, user.roles, user.knownDeviceHashes ?? [], deviceId, meta, { firstSetup: true });
  return { userId, session, recoveryCodes: codes };
}

export async function adminMfaStep(
  mfaToken: string,
  factor: { code?: string; recoveryCode?: string },
  deviceId: string,
  meta: RequestMeta,
): Promise<{ userId: string; session: IssuedSession }> {
  const { userId, user } = await mfaUser(mfaToken);
  if (!user.twoFactor?.enabled && !devCode()) throw new AppError(409, 'two_factor_setup_required', 'Set up your authenticator app first.');

  const ok = factor.code ? await consumeTotp(userId, factor.code) : factor.recoveryCode ? await consumeRecovery(userId, factor.recoveryCode) : false;
  if (!ok) {
    await registerLoginFailure(userId);
    throw new AppError(401, 'invalid_code', 'The code is incorrect or was already used.');
  }
  const session = await openAdminSession(userId, user.roles, user.knownDeviceHashes ?? [], deviceId, meta, {
    usedRecoveryCode: Boolean(factor.recoveryCode),
    ...(isDevCode(factor.code) ? { usedDevelopmentCode: true } : {}),
  });
  return { userId, session };
}

// ---------------------------------------------------------------------------
// Admin password reset: SMS code (30 min) + authenticator code
// ---------------------------------------------------------------------------

export async function requestAdminPasswordReset(email: string): Promise<void> {
  const user = await UserModel.findOne({ email: email.toLowerCase() }).lean();
  // Admin accounts are always created with a phone; without one there is nowhere to send the code.
  if (!user || user.status !== 'active' || !hasAdminRole(user.roles as Role[]) || !user.phone) return;
  try {
    const code = await issueOtp(user.phone, 'admin_password_reset');
    await sendSms(user.phone, 'otp.admin_password_reset.sms', { code });
  } catch (err) {
    // Same response either way; a throttled request is only logged.
    logger.warn({ err: (err as Error).message }, 'admin password reset code not sent');
  }
}

export async function confirmAdminPasswordReset(
  input: { email: string; code: string; totpCode: string; newPassword: string },
  meta: RequestMeta,
): Promise<void> {
  const user = await UserModel.findOne({ email: input.email.toLowerCase() }).lean();
  if (!user || user.status !== 'active' || !hasAdminRole(user.roles as Role[]) || !user.phone) {
    throw new AppError(400, 'invalid_code', 'The code is incorrect or has expired.');
  }
  const problem = passwordProblem(input.newPassword, [user.email ?? '', user.firstName ?? '', user.lastName ?? '', (user.phone ?? '').slice(-6)]);
  if (problem) throw badRequest('weak_password', problem);
  await verifyOtp(user.phone, 'admin_password_reset', input.code);
  if (!(await consumeTotp(String(user._id), input.totpCode))) {
    throw new AppError(400, 'invalid_totp', 'The authenticator code is incorrect or was already used.');
  }
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { passwordHash: await hashPassword(input.newPassword), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null } },
  );
  const revoked = await revokeAllSessions(String(user._id), 'password_reset');
  await recordAudit({
    actor: { type: 'user', id: String(user._id), roles: user.roles },
    action: 'auth.admin_password_reset',
    targetType: 'user',
    targetId: String(user._id),
    after: { sessionsRevoked: revoked },
    ...meta,
  });
}

// ---------------------------------------------------------------------------
// Removing admins and suspending users (Super Admin only, enforced at the route)
// ---------------------------------------------------------------------------

export async function removeAdmin(targetId: string, actor: AuditActor & { type: 'user' }, reason: string, meta: Partial<RequestMeta> = {}) {
  if (targetId === actor.id) throw forbidden('You cannot remove your own admin account.');
  await withTransaction(async (session) => {
    const target = await UserModel.findById(targetId, null, { session }).lean();
    if (!target || !hasAdminRole(target.roles as Role[])) throw notFound('Admin not found.');
    if (target.roles.includes('super_admin')) {
      const others = await UserModel.countDocuments({ _id: { $ne: targetId }, roles: 'super_admin', status: 'active' }, { session });
      if (others < 1) throw conflict('last_super_admin', 'The last active super admin cannot be removed.');
    }
    const remaining = target.roles.filter((r) => !ADMIN_ROLES.includes(r as Role));
    await UserModel.updateOne(
      { _id: targetId },
      { $set: { roles: remaining, status: 'suspended', suspendedAt: new Date(), suspendedReason: 'admin_removed' } },
      { session },
    );
    await recordAudit(
      { actor, action: 'admin.removed', targetType: 'user', targetId, before: { roles: target.roles, status: target.status }, after: { roles: remaining, status: 'suspended' }, reason, ...meta },
      session,
    );
  });
  await revokeAllSessions(targetId, 'admin_removed');
}

export async function setUserSuspended(
  targetId: string,
  suspended: boolean,
  actor: AuditActor & { type: 'user' },
  reason: string,
  meta: Partial<RequestMeta> = {},
) {
  if (targetId === actor.id) throw forbidden('You cannot suspend your own account.');
  await withTransaction(async (session) => {
    const target = await UserModel.findById(targetId, null, { session }).lean();
    if (!target || target.status === 'anonymised' || target.status === 'pending_setup') throw notFound('User not found.');
    if (hasAdminRole(target.roles as Role[])) throw forbidden('Use admin management to remove an admin.');
    const next = suspended ? 'suspended' : 'active';
    if (target.status === next) return;
    await UserModel.updateOne(
      { _id: targetId },
      suspended
        ? { $set: { status: 'suspended', suspendedAt: new Date(), suspendedReason: reason } }
        : { $set: { status: 'active' }, $unset: { suspendedAt: 1, suspendedReason: 1 } },
      { session },
    );
    await recordAudit(
      { actor, action: suspended ? 'user.suspended' : 'user.reactivated', targetType: 'user', targetId, before: { status: target.status }, after: { status: next }, reason, ...meta },
      session,
    );
  });
  if (suspended) await revokeAllSessions(targetId, 'suspended');
}
