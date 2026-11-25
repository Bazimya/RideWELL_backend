import { UserModel } from '../users/user.model.js';
import { hasAdminRole, type Role } from '../users/roles.js';
import { issueOtp, verifyOtp, OtpInvalidError } from './otp.service.js';
import { createSession, type IssuedSession } from './token.service.js';
import { sendSms } from '../notifications/notification.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * Send a sign-in code. The response to the caller is the same whether or not the
 * phone has an account. Admin accounts cannot sign in by SMS: no code is sent to
 * them (they use password + authenticator), and nothing in the response says so.
 */
export async function requestLoginCode(phone: string): Promise<void> {
  const user = await UserModel.findOne({ phone }).select('roles status').lean();
  if (user && (hasAdminRole(user.roles as Role[]) || user.status === 'anonymised')) {
    logger.info({ reason: user.status === 'anonymised' ? 'anonymised' : 'admin_account' }, 'login code not sent');
    return;
  }
  const code = await issueOtp(phone, 'login');
  await sendSms(phone, 'otp.login.sms', { code });
}

/**
 * Check the code; create the customer account on first sign-in (phone verified
 * by the code itself); open a session.
 */
export async function verifyLoginCode(
  phone: string,
  code: string,
  meta: RequestMeta,
): Promise<{ userId: string; isNewUser: boolean; session: IssuedSession }> {
  await verifyOtp(phone, 'login', code);

  let user = await UserModel.findOne({ phone });
  let isNewUser = false;
  if (user && (hasAdminRole(user.roles as Role[]) || user.status === 'anonymised')) throw new OtpInvalidError();

  if (!user) {
    try {
      user = await UserModel.create({ phone, phoneVerifiedAt: new Date(), roles: ['customer'], status: 'active' });
      isNewUser = true;
      await recordAudit({
        actor: { type: 'user', id: user.id, roles: ['customer'] },
        action: 'user.registered',
        targetType: 'user',
        targetId: user.id,
        after: { roles: ['customer'] },
        ...meta,
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      user = await UserModel.findOne({ phone }); // created by a concurrent request
      if (!user) throw err;
    }
  }

  if (user.status === 'suspended') {
    throw new AppError(403, 'account_suspended', 'This account is suspended. Contact RideWELL support.');
  }

  user.lastLoginAt = new Date();
  if (!user.phoneVerifiedAt) user.phoneVerifiedAt = new Date();
  await user.save();

  const session = await createSession({ userId: user.id, kind: 'user', ip: meta.ip, userAgent: meta.userAgent });
  await recordAudit({
    actor: { type: 'user', id: user.id, roles: user.roles },
    action: 'auth.login',
    targetType: 'session',
    targetId: session.sessionId,
    after: { method: 'sms_otp' },
    ...meta,
  });
  return { userId: user.id, isNewUser, session };
}
