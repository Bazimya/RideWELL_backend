import { UserModel } from '../modules/users/user.model.js';
import { PERMISSION_PRESETS } from '../modules/users/permissions.js';
import { recordAudit } from '../modules/audit/audit.service.js';
import { logger } from '../lib/logger.js';

/**
 * Idempotent data migrations, run at startup before the API serves requests.
 *
 * 2026-11-24: the fixed `ops_admin` role became `staff` with ticked permissions.
 * Existing operations admins keep what they could do, as the Operations preset.
 */
export async function runMigrations(): Promise<void> {
  const users = UserModel.collection;
  const legacy = await users.find({ roles: 'ops_admin' }, { projection: { _id: 1 } }).toArray();
  for (const u of legacy) {
    await users.updateOne(
      { _id: u._id, roles: 'ops_admin' },
      [
        {
          $set: {
            roles: { $concatArrays: [{ $filter: { input: '$roles', cond: { $ne: ['$$this', 'ops_admin'] } } }, ['staff']] },
            permissions: PERMISSION_PRESETS.operations!.permissions,
          },
        },
      ],
    );
    await recordAudit({
      actor: { type: 'system', name: 'migration' },
      action: 'staff.migrated_from_ops_admin',
      targetType: 'user',
      targetId: String(u._id),
      after: { roles: ['staff'], permissions: PERMISSION_PRESETS.operations!.permissions },
    });
  }
  if (legacy.length) logger.info({ count: legacy.length }, 'migrated ops_admin accounts to staff');
}
