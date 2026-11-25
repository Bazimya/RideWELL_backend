/**
 * Bootstrap a super admin (spec: founders, max 2, "created at setup").
 *
 *   npm run create-super-admin -- --email you@example.com --first Jane --last Doe [--phone 0788123456] [--password '...']
 *
 * Without --password a strong random one is generated and printed once. The
 * founder sets up their authenticator app at first sign-in (/admin/sign-in).
 * There is no HTTP route that creates the first super admin.
 */
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase, ensureIndexes } from '../db/connection.js';
import { createStaffAccount } from '../modules/auth/adminAuth.service.js';
import { normalizePhone } from '../lib/phone.js';

function generatePassword(): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 18; i++) s += a[crypto.randomInt(a.length)];
  return `${s.slice(0, 6)}-${s.slice(6, 12)}-${s.slice(12)}`;
}

async function main() {
  const { values } = parseArgs({
    options: { phone: { type: 'string' }, email: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' }, password: { type: 'string' } },
  });
  const phone = values.phone ? normalizePhone(values.phone) : null;
  if (!values.email || !values.first || !values.last || (values.phone && !phone)) {
    console.error('Usage: npm run create-super-admin -- --email <email> --first <first name> --last <last name> [--phone <phone>] [--password <password>]');
    process.exit(2);
  }
  const password = values.password ?? generatePassword();
  await connectDatabase(env().MONGODB_URI);
  await ensureIndexes();
  await createStaffAccount(
    { email: values.email.toLowerCase(), phone, firstName: values.first, lastName: values.last, password, accountType: 'super_admin', permissions: [] },
    { type: 'system', name: 'create-super-admin-script' },
  );
  console.log(`Super admin created: ${values.email.toLowerCase()}`);
  if (!values.password) console.log(`Generated password (shown once, store it safely): ${password}`);
  console.log('Sign in at /admin/sign-in and set up your authenticator app.');
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
