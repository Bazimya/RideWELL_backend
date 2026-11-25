import crypto from 'node:crypto';
import { authenticator } from 'otplib';
import { decryptSecret, encryptSecret, keyedHash, safeEqual } from '../../lib/crypto.js';

/** Accept the previous and next 30-second window to allow for clock drift. */
authenticator.options = { window: 1, step: 30, digits: 6 };

export const RECOVERY_CODE_COUNT = 10;

export function newTotpSecret(): { secret: string; secretEnc: string } {
  const secret = authenticator.generateSecret(20);
  return { secret, secretEnc: encryptSecret(secret) };
}

export function otpauthUri(accountLabel: string, secret: string): string {
  return authenticator.keyuri(accountLabel, 'RideWELL', secret);
}

/**
 * Check a TOTP code and return the time step it belongs to, or null. The caller
 * stores the step and rejects any code at or below it, so a code cannot be replayed.
 */
export function checkTotp(code: string, secretEnc: string, lastUsedStep: number, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = decryptSecret(secretEnc);
  const delta = authenticator.checkDelta(code, secret);
  if (delta === null) return null;
  const step = Math.floor(now / 1000 / 30) + delta;
  if (step <= lastUsedStep) return null;
  return step;
}

/** Recovery codes: shown once, stored hashed, each usable once. Format: xxxx-xxxx-xxxx */
export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  // 12 characters from a 31-symbol alphabet (no 0/o/1/l/i) ≈ 59 bits each.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    let raw = '';
    for (let i = 0; i < 12; i++) raw += alphabet[crypto.randomInt(0, alphabet.length)];
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  });
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

export const hashRecoveryCode = (code: string) => keyedHash(code.trim().toLowerCase(), 'recovery');

/** Returns the remaining hashes with the used one removed, or null if no match. */
export function consumeRecoveryCode(code: string, hashes: string[]): string[] | null {
  const h = hashRecoveryCode(code);
  const idx = hashes.findIndex((x) => safeEqual(x, h));
  if (idx === -1) return null;
  return hashes.filter((_, i) => i !== idx);
}
