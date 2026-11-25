import type { ClientSession } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { PlatformConfigModel } from './platformConfig.model.js';
import { platformConfigValuesSchema, type PlatformConfigValues } from './platformConfig.schema.js';

export interface CurrentConfig {
  version: number;
  values: PlatformConfigValues;
  isPlaceholder: boolean;
  createdAt: Date;
}

export async function getCurrentConfig(session?: ClientSession): Promise<CurrentConfig | null> {
  const doc = await PlatformConfigModel.findOne({}, null, session ? { session } : {}).sort({ version: -1 }).lean();
  if (!doc) return null;
  return {
    version: doc.version,
    values: platformConfigValuesSchema.parse(doc.values),
    isPlaceholder: doc.isPlaceholder,
    createdAt: doc.createdAt,
  };
}

/** Config for operational rules (deadlines, buffers). Fails if no config exists at all. */
export async function requireConfig(session?: ClientSession): Promise<CurrentConfig> {
  const cfg = await getCurrentConfig(session);
  if (!cfg) {
    throw new AppError(503, 'config_missing', 'Platform configuration has not been set up yet. A Super Admin must save it first.');
  }
  return cfg;
}

/**
 * Config for anything that sets a price or a split. In production, placeholder
 * values are refused: quotes cannot go out until a Super Admin saves real shares.
 */
export async function requireFinancialConfig(
  session?: ClientSession,
  opts: { production?: boolean } = {},
): Promise<CurrentConfig> {
  const production = opts.production ?? env().NODE_ENV === 'production';
  const cfg = await requireConfig(session);
  if (cfg.isPlaceholder && production) {
    throw new AppError(
      503,
      'config_placeholder',
      'Commission and partner shares are still placeholder values. A Super Admin must save real values before quotes can be sent.',
    );
  }
  return cfg;
}

export async function saveConfigVersion(
  input: { values: PlatformConfigValues; isPlaceholder: boolean; note?: string | null; createdBy?: string | null; createdBySystem?: string | null },
  session: ClientSession,
): Promise<CurrentConfig> {
  const values = platformConfigValuesSchema.parse(input.values);
  const latest = await PlatformConfigModel.findOne({}, { version: 1 }, { session }).sort({ version: -1 }).lean();
  const version = (latest?.version ?? 0) + 1;
  // Unique index on version: two concurrent saves cannot both claim the same version.
  const [doc] = await PlatformConfigModel.create(
    [
      {
        version,
        values,
        isPlaceholder: input.isPlaceholder,
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
        createdBySystem: input.createdBySystem ?? null,
      },
    ],
    { session },
  );
  return { version: doc!.version, values, isPlaceholder: doc!.isPlaceholder, createdAt: doc!.createdAt };
}
