import { UserModel } from '../users/user.model.js';
import { recordAudit } from '../audit/audit.service.js';
import { tooMany } from '../../lib/errors.js';

/** Spec: 5 failed attempts → 15-minute lock, for every password sign-in. */
export const LOCK_RULES = { maxFailures: 5, lockMs: 15 * 60_000 } as const;

export async function registerLoginFailure(userId: string): Promise<void> {
  const user = await UserModel.findOneAndUpdate({ _id: userId }, { $inc: { failedLoginCount: 1 } }, { new: true }).lean();
  if (user && user.failedLoginCount >= LOCK_RULES.maxFailures) {
    await UserModel.updateOne({ _id: userId }, { $set: { lockedUntil: new Date(Date.now() + LOCK_RULES.lockMs), failedLoginCount: 0 } });
    await recordAudit({ actor: { type: 'system', name: 'auth' }, action: 'auth.account_locked', targetType: 'user', targetId: userId });
  }
}

export const isLocked = (user: { lockedUntil?: Date | null }) => Boolean(user.lockedUntil && user.lockedUntil > new Date());

export function assertNotLocked(user: { lockedUntil?: Date | null }): void {
  if (isLocked(user)) {
    throw tooMany('Too many attempts. Try again later.', Math.ceil((user.lockedUntil!.getTime() - Date.now()) / 1000));
  }
}

export async function clearLoginFailures(userId: string): Promise<void> {
  await UserModel.updateOne({ _id: userId }, { $set: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
}
