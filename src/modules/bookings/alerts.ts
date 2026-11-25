import { Schema, model } from 'mongoose';
import { UserModel } from '../users/user.model.js';
import { effectivePermissions, type Permission } from '../users/permissions.js';
import { sendEmail, sendSms } from '../notifications/notification.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { logger } from '../../lib/logger.js';

export const ALERT_TYPES = [
  'acceptance_declined',
  'acceptance_timeout',
  'trip_not_started',
  'pin_locked',
  'safety_report',
  'partner_suspended',
  'payment_after_expiry',
  'low_rating',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Something operations must act on. Shown on the bookings dashboard until resolved. */
const opsAlertSchema = new Schema(
  {
    type: { type: String, enum: ALERT_TYPES, required: true },
    severity: { type: String, enum: ['high', 'normal'], default: 'normal' },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    bookingRef: { type: String, default: null },
    message: { type: String, required: true, maxlength: 500 },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolution: { type: String, maxlength: 500, default: null },
  },
  { timestamps: true, versionKey: false },
);
opsAlertSchema.index({ resolvedAt: 1, createdAt: -1 });
opsAlertSchema.index({ bookingId: 1 });
export const OpsAlertModel = model('OpsAlert', opsAlertSchema, 'opsAlerts');

/** Staff who should hear about an alert: holders of `permission` (super admins hold all). */
async function recipients(permission: Permission) {
  const staff = await UserModel.find({ roles: { $in: ['staff', 'super_admin'] }, status: 'active' }).select('roles permissions phone email').lean();
  return staff.filter((u) => effectivePermissions(u).includes(permission));
}

/**
 * Record an alert and tell operations. High-severity alerts (safety) go by SMS
 * and email; others by SMS when a phone is on file, otherwise email. Messages
 * carry the booking reference only: no names, addresses or ID numbers.
 * Call only after the change it reports has committed (never inside a transaction).
 */
export async function alertOps(input: { type: AlertType; bookingId?: unknown; bookingRef?: string | null; message: string; severity?: 'high' | 'normal' }) {
  const alert = await OpsAlertModel.create({
    type: input.type,
    severity: input.severity ?? 'normal',
    bookingId: input.bookingId ?? null,
    bookingRef: input.bookingRef ?? null,
    message: input.message,
  });
  await recordAudit({
    actor: { type: 'system', name: 'ops-alerts' },
    action: `alert.${input.type}`,
    targetType: 'booking',
    targetId: input.bookingId ? String(input.bookingId) : null,
    after: { message: input.message },
  });
  const people = await recipients(input.type === 'safety_report' ? 'safety.handle' : 'bookings.manage');
  const text = `RideWELL ops${input.severity === 'high' ? ' URGENT' : ''}: ${input.message}`;
  for (const p of people) {
    try {
      if (p.phone) await sendSms(p.phone, 'ops.alert', { text });
      if (p.email && (input.severity === 'high' || !p.phone)) await sendEmail(p.email, 'ops.alert.subject', 'ops.alert', { text });
    } catch (err) {
      logger.error({ err }, 'ops alert notification failed');
    }
  }
  return alert;
}
