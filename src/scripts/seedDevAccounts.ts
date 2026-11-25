/**
 * DEVELOPMENT ONLY. Creates (or resets) the development accounts whose
 * credentials are stored in .env, so .env is the single source of truth:
 *
 *   DEV_SUPER_ADMIN_*  DEV_OPS_ADMIN_*  (email, password, phone, TOTP secret)
 *   (DEV_OPS_ADMIN is a staff account with the Operations permission preset)
 *   DEV_CUSTOMER_*  DEV_DRIVER_*  DEV_OWNER_*  (email, password)
 *
 * Admins are created active with the TOTP secret from .env (add it to an
 * authenticator app). The partner accounts are plain accounts: they apply
 * through the app like a real driver or owner would.
 *
 * Refuses to run in production. Never put these variables in a production .env.
 *
 *   npm run seed:dev-accounts
 */
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase, ensureIndexes } from '../db/connection.js';
import { UserModel } from '../modules/users/user.model.js';
import { hashPassword, passwordProblem } from '../modules/auth/password.js';
import { encryptSecret } from '../lib/crypto.js';
import { normalizePhone } from '../lib/phone.js';
import { recordAudit } from '../modules/audit/audit.service.js';
import type { Role } from '../modules/users/roles.js';
import { PERMISSION_PRESETS } from '../modules/users/permissions.js';
import { runMigrations } from '../db/migrations.js';

interface Spec {
  prefix: string;
  label: string;
  role: Role;
  firstName: string;
  lastName: string;
  admin: boolean;
}

const SPECS: Spec[] = [
  { prefix: 'DEV_SUPER_ADMIN', label: 'Super admin', role: 'super_admin', firstName: 'Dev', lastName: 'Founder', admin: true },
  { prefix: 'DEV_OPS_ADMIN', label: 'Operations staff', role: 'staff', firstName: 'Dev', lastName: 'Operations', admin: true },
  { prefix: 'DEV_CUSTOMER', label: 'Customer', role: 'customer', firstName: 'Dev', lastName: 'Customer', admin: false },
  { prefix: 'DEV_DRIVER', label: 'Driver applicant', role: 'customer', firstName: 'Dev', lastName: 'Driver', admin: false },
  { prefix: 'DEV_OWNER', label: 'Vehicle owner applicant', role: 'customer', firstName: 'Dev', lastName: 'Owner', admin: false },
];

async function main() {
  const e = env();
  if (e.NODE_ENV === 'production') {
    console.error('Refusing to create development accounts in production.');
    process.exit(1);
  }
  await connectDatabase(e.MONGODB_URI);
  await ensureIndexes();
  await runMigrations();

  for (const spec of SPECS) {
    const email = process.env[`${spec.prefix}_EMAIL`]?.toLowerCase();
    const password = process.env[`${spec.prefix}_PASSWORD`];
    if (!email || !password) {
      console.log(`- ${spec.label}: skipped (${spec.prefix}_EMAIL / _PASSWORD not set)`);
      continue;
    }
    const problem = passwordProblem(password, [email, spec.firstName, spec.lastName]);
    if (problem) throw new Error(`${spec.prefix}_PASSWORD: ${problem}`);

    const set: Record<string, unknown> = {
      email,
      passwordHash: await hashPassword(password),
      passwordChangedAt: new Date(),
      status: 'active',
      failedLoginCount: 0,
      lockedUntil: null,
    };

    if (spec.admin) {
      const phone = normalizePhone(process.env[`${spec.prefix}_PHONE`] ?? '');
      const secret = process.env[`${spec.prefix}_TOTP_SECRET`];
      if (!phone || !secret) throw new Error(`${spec.prefix}_PHONE and ${spec.prefix}_TOTP_SECRET are required for admin accounts`);
      Object.assign(set, {
        phone,
        roles: [spec.role],
        permissions: spec.role === 'staff' ? PERMISSION_PRESETS.operations!.permissions : [],
        'twoFactor.enabled': true,
        'twoFactor.secretEnc': encryptSecret(secret),
        'twoFactor.enabledAt': new Date(),
        'twoFactor.lastUsedStep': 0,
      });
    }

    const existing = await UserModel.findOne({ email }).lean();
    if (existing) {
      await UserModel.updateOne({ _id: existing._id }, { $set: set });
      console.log(`- ${spec.label}: reset to the .env credentials (${email})`);
    } else {
      const created = await UserModel.create({
        ...Object.fromEntries(Object.entries(set).filter(([k]) => !k.startsWith('twoFactor.'))),
        firstName: spec.firstName,
        lastName: spec.lastName,
        roles: [spec.role],
        ...(spec.admin
          ? { twoFactor: { enabled: true, secretEnc: set['twoFactor.secretEnc'], enabledAt: new Date(), lastUsedStep: 0 } }
          : {}),
      });
      await recordAudit({
        actor: { type: 'system', name: 'seed-dev-accounts' },
        action: 'dev.account_seeded',
        targetType: 'user',
        targetId: created.id,
        after: { email, roles: [spec.role] },
      });
      console.log(`- ${spec.label}: created (${email})`);
    }
  }
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
