import { UserModel } from '../users/user.model.js';
import { hasAdminRole, type Role } from '../users/roles.js';
import { checkPassword, hashPassword, passwordProblem } from './password.js';
import { createSession, revokeAllSessions, type IssuedSession } from './token.service.js';
import { clearLoginFailures, isLocked, registerLoginFailure } from './lockout.js';
import { recordAudit } from '../audit/audit.service.js';
import { AppError, badRequest, conflict, forbidden } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import type { RequestMeta } from './customerAuth.service.js';

const INVALID = () =>
  new AppError(401, 'invalid_credentials', 'Email or password is incorrect. After 5 failed attempts, sign-in is paused for 15 minutes.');

const personal = (u: { email?: string | null; firstName?: string | null; lastName?: string | null; phone?: string | null }) => [
  u.email ?? '',
  (u.email ?? '').split('@')[0] ?? '',
  u.firstName ?? '',
  u.lastName ?? '',
  (u.phone ?? '').slice(-6),
];

/**
 * Create a customer account with email + password.
 *
 * TEMPORARY (EMAIL_SIGNUP_WITHOUT_VERIFICATION): while no email provider is
 * configured, the email is not verified before the account is usable. The account
 * is marked unverified, and production refuses to start in this mode.
 */
export async function registerWithEmail(
  input: { email: string; password: string; firstName: string; lastName: string },
  meta: RequestMeta,
): Promise<{ userId: string; session: IssuedSession }> {
  if (!env().EMAIL_SIGNUP_WITHOUT_VERIFICATION) {
    throw new AppError(503, 'email_signup_unavailable', 'Email sign-up needs email verification, which is not available yet. Sign up with your phone number.');
  }
  const problem = passwordProblem(input.password, personal(input));
  if (problem) throw badRequest('weak_password', problem);

  let user;
  try {
    user = await UserModel.create({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      passwordHash: await hashPassword(input.password),
      passwordChangedAt: new Date(),
      roles: ['customer'],
      status: 'active',
      lastLoginAt: new Date(),
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw conflict('email_taken', 'An account with this email already exists. Sign in instead.');
    }
    throw err;
  }
  await recordAudit({
    actor: { type: 'user', id: user.id, roles: ['customer'] },
    action: 'user.registered',
    targetType: 'user',
    targetId: user.id,
    after: { method: 'email_password', emailVerified: false },
    ...meta,
  });
  const session = await createSession({ userId: user.id, kind: 'user', ip: meta.ip, userAgent: meta.userAgent });
  await recordAudit({
    actor: { type: 'user', id: user.id, roles: user.roles },
    action: 'auth.login',
    targetType: 'session',
    targetId: session.sessionId,
    after: { method: 'email_password' },
    ...meta,
  });
  return { userId: user.id, session };
}

/**
 * Email + password sign-in for customers and partners. Admin accounts are refused
 * with the same generic error: they must use the admin sign-in (with 2FA).
 */
export async function signInWithEmail(email: string, password: string, meta: RequestMeta): Promise<{ userId: string; session: IssuedSession }> {
  const user = await UserModel.findOne({ email: email.toLowerCase() }).select('+passwordHash').lean();
  const ok = await checkPassword(password, user?.passwordHash); // always run bcrypt (timing)
  if (!user || hasAdminRole(user.roles as Role[]) || user.status === 'anonymised' || user.status === 'pending_setup') throw INVALID();
  if (isLocked(user)) throw INVALID();
  if (!ok) {
    await registerLoginFailure(String(user._id));
    throw INVALID();
  }
  if (user.status === 'suspended') throw new AppError(403, 'account_suspended', 'This account is suspended. Contact RideWELL support.');

  await clearLoginFailures(String(user._id));
  const session = await createSession({ userId: String(user._id), kind: 'user', ip: meta.ip, userAgent: meta.userAgent });
  await recordAudit({
    actor: { type: 'user', id: String(user._id), roles: user.roles },
    action: 'auth.login',
    targetType: 'session',
    targetId: session.sessionId,
    after: { method: 'email_password' },
    ...meta,
  });
  return { userId: String(user._id), session };
}

/**
 * Set or change the password of a customer/partner account. Changing an existing
 * password needs the current one. Every other session is signed out.
 */
export async function setOwnPassword(
  userId: string,
  sessionId: string,
  input: { currentPassword?: string; newPassword: string },
  meta: RequestMeta,
): Promise<void> {
  const user = await UserModel.findById(userId).select('+passwordHash');
  if (!user) throw INVALID();
  if (hasAdminRole(user.roles as Role[])) throw forbidden('Admins change their password through the admin password reset.');
  if (!user.email) throw badRequest('email_required', 'Add an email address to your account first. You will sign in with it.');
  if (user.passwordHash) {
    if (!input.currentPassword || !(await checkPassword(input.currentPassword, user.passwordHash))) {
      await registerLoginFailure(userId);
      throw new AppError(400, 'wrong_password', 'Your current password is incorrect.');
    }
  }
  const problem = passwordProblem(input.newPassword, personal(user));
  if (problem) throw badRequest('weak_password', problem);
  const hadPassword = Boolean(user.passwordHash);
  user.passwordHash = await hashPassword(input.newPassword);
  user.passwordChangedAt = new Date();
  await user.save();
  const revoked = await revokeAllSessions(userId, 'password_changed', sessionId);
  await recordAudit({
    actor: { type: 'user', id: userId, roles: user.roles },
    action: hadPassword ? 'auth.password_changed' : 'auth.password_set',
    targetType: 'user',
    targetId: userId,
    after: { otherSessionsRevoked: revoked },
    ...meta,
  });
}
