import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';

/**
 * Normalise a phone number to E.164. Numbers without a country code are read as
 * Rwandan (078…, 072…). International numbers are accepted so visitors can book.
 */
export function normalizePhone(input: string): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), 'RW');
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164, e.g. +250788123456
}

export const phoneSchema = z
  .string()
  .min(6)
  .max(20)
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number.' });
      return z.NEVER;
    }
    return n;
  });

/** For SMS/logs: +250788***456 */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return '***';
  return `${e164.slice(0, 7)}***${e164.slice(-3)}`;
}
