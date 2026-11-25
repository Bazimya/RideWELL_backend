import { Schema, model, type InferSchemaType } from 'mongoose';
import { appendOnly } from '../../db/appendOnly.js';

/**
 * Write-once audit trail. There are no update or delete routes, the model refuses
 * updates and deletes, and in production the DB user cannot modify this collection.
 * Kept at least 2 years (spec, Data protection).
 */
const auditLogSchema = new Schema(
  {
    at: { type: Date, required: true, default: () => new Date() },
    /** null for system actions (scheduled jobs, webhooks, setup scripts). */
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorRoles: { type: [String], default: [] },
    actorType: { type: String, enum: ['user', 'system'], required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    reason: { type: String, default: null, maxlength: 1000 },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 400 },
    requestId: { type: String, default: null },
  },
  { versionKey: false },
);

auditLogSchema.index({ targetType: 1, targetId: 1, at: -1 });
auditLogSchema.index({ actorId: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });
auditLogSchema.index({ at: -1 });

appendOnly(auditLogSchema, 'auditLogs');

export type AuditLog = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel = model('AuditLog', auditLogSchema, 'auditLogs');
