import { Schema, model, type InferSchemaType } from 'mongoose';
import { appendOnly } from '../../db/appendOnly.js';

/**
 * Versioned platform configuration. Every save is a new version (append-only), so
 * the value in force at any past moment can always be reconstructed. Bookings also
 * snapshot the values they use at quote time.
 */
const platformConfigSchema = new Schema(
  {
    version: { type: Number, required: true },
    values: { type: Schema.Types.Mixed, required: true },
    /** True when the values are development placeholders, not real business decisions. */
    isPlaceholder: { type: Boolean, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBySystem: { type: String, default: null },
    note: { type: String, maxlength: 500, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false, minimize: false },
);

platformConfigSchema.index({ version: -1 }, { unique: true });
appendOnly(platformConfigSchema, 'platformConfigs');

export type PlatformConfigDoc = InferSchemaType<typeof platformConfigSchema>;
export const PlatformConfigModel = model('PlatformConfig', platformConfigSchema, 'platformConfigs');
