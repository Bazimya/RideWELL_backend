/**
 * DEVELOPMENT SEED. Saves the placeholder platform configuration, marked
 * isPlaceholder=true. Refuses to run in production. Creates no fake users,
 * drivers, vehicles, reviews or payments.
 */
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase, ensureIndexes } from '../db/connection.js';
import { withTransaction } from '../db/transaction.js';
import { DEV_PLACEHOLDER_CONFIG } from '../modules/platformConfig/platformConfig.schema.js';
import { getCurrentConfig, saveConfigVersion } from '../modules/platformConfig/platformConfig.service.js';
import { recordAudit } from '../modules/audit/audit.service.js';

async function main() {
  const e = env();
  if (e.NODE_ENV === 'production') {
    console.error('Refusing to seed development data in production.');
    process.exit(1);
  }
  await connectDatabase(e.MONGODB_URI);
  await ensureIndexes();
  const existing = await getCurrentConfig();
  const refresh = process.argv.includes('--refresh');
  // --refresh: replace an existing PLACEHOLDER config with the current placeholder values
  // (new settings added by later phases). Never touches real, Super Admin-saved values.
  if (existing && refresh && existing.isPlaceholder) {
    const cfg = await withTransaction(async (session) => {
      const saved = await saveConfigVersion(
        { values: DEV_PLACEHOLDER_CONFIG, isPlaceholder: true, note: 'DEV PLACEHOLDER refreshed', createdBySystem: 'seed-dev' },
        session,
      );
      await recordAudit({ actor: { type: 'system', name: 'seed-dev' }, action: 'config.seeded_placeholder', targetType: 'platformConfig', targetId: String(saved.version) }, session);
      return saved;
    });
    console.log(`Refreshed DEV PLACEHOLDER platform config, now version ${cfg.version}.`);
  } else if (existing) {
    console.log(`Platform config already exists (version ${existing.version}, placeholder=${existing.isPlaceholder}). Nothing to do.`);
  } else {
    const cfg = await withTransaction(async (session) => {
      const saved = await saveConfigVersion(
        { values: DEV_PLACEHOLDER_CONFIG, isPlaceholder: true, note: 'DEV PLACEHOLDER: commission not decided', createdBySystem: 'seed-dev' },
        session,
      );
      await recordAudit(
        { actor: { type: 'system', name: 'seed-dev' }, action: 'config.seeded_placeholder', targetType: 'platformConfig', targetId: String(saved.version) },
        session,
      );
      return saved;
    });
    console.log(`Saved DEV PLACEHOLDER platform config, version ${cfg.version}.`);
  }
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
