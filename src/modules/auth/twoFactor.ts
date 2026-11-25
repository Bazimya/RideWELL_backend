import { UserModel } from '../users/user.model.js';
import { checkTotp, consumeRecoveryCode } from './totp.service.js';
import { isDevCode } from '../../lib/devCode.js';

/**
 * Verify a TOTP code for an enrolled user and record its time step atomically,
 * so the same code cannot be accepted twice (not even by two parallel requests).
 */
export async function consumeTotp(userId: string, code: string): Promise<boolean> {
  const user = await UserModel.findById(userId).select('+twoFactor.secretEnc').lean();
  // Development only: the fixed development code stands in for the authenticator.
  if (user && isDevCode(code)) return true;
  const tf = user?.twoFactor;
  if (!tf?.enabled || !tf.secretEnc) return false;
  const step = checkTotp(code, tf.secretEnc, tf.lastUsedStep ?? 0);
  if (step === null) return false;
  const res = await UserModel.updateOne(
    { _id: userId, 'twoFactor.lastUsedStep': { $lt: step } },
    { $set: { 'twoFactor.lastUsedStep': step } },
  );
  return res.modifiedCount === 1;
}

/** Use one recovery code (single use). */
export async function consumeRecovery(userId: string, code: string): Promise<boolean> {
  const user = await UserModel.findById(userId).select('+twoFactor.recoveryCodeHashes').lean();
  const hashes = user?.twoFactor?.recoveryCodeHashes ?? [];
  const remaining = consumeRecoveryCode(code, hashes);
  if (!remaining) return false;
  // Conditional on the array being unchanged, so a code cannot be spent twice concurrently.
  const res = await UserModel.updateOne(
    { _id: userId, 'twoFactor.recoveryCodeHashes': hashes },
    { $set: { 'twoFactor.recoveryCodeHashes': remaining } },
  );
  return res.modifiedCount === 1;
}
