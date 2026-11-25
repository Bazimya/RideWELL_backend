import bcrypt from 'bcryptjs';
import { COMMON_PASSWORDS } from './commonPasswords.js';

const BCRYPT_COST = 12;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

/** Spec: minimum 10 characters, checked against a list of common passwords. */
export function passwordProblem(password: string, context: string[] = []): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  // bcrypt reads only the first 72 bytes; longer passphrases are still allowed but truncated.
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'This password is too common. Choose another.';
  if (/^(.)\1+$/.test(password)) return 'This password is too easy to guess.';
  for (const c of context) {
    if (c && c.length >= 4 && lower.includes(c.toLowerCase())) return 'Do not use your name, email or phone number in your password.';
  }
  return null;
}

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_COST);

/** A fixed hash used to spend the same time when an account does not exist. */
const DUMMY_HASH = bcrypt.hashSync('ridewell-dummy-password-for-timing', BCRYPT_COST);

export async function checkPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  return bcrypt.compare(password, hash ?? DUMMY_HASH).then((ok) => ok && Boolean(hash));
}
