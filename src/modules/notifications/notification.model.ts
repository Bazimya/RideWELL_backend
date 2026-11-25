import { Schema, model, type InferSchemaType } from 'mongoose';

export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Delivery attempts before a message is marked failed. */
export const MAX_ATTEMPTS = 4;
/** Wait before attempt 2, 3 and 4. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
/** Notifications are deleted by the database after this many days. */
export const NOTIFICATION_RETENTION_DAYS = 180;

/**
 * One message to one user: the in-app inbox entry and its SMS or email delivery
 * record. Sign-in codes are never stored here. Secrets in a message (the trip
 * PIN) are masked in `body`; such a message cannot be resent from this record.
 */
const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true, maxlength: 80 },
    title: { type: String, required: true, maxlength: 200 },
    /** What the user reads in the app. Secrets masked. */
    body: { type: String, required: true, maxlength: 1000 },
    /** Path in the web app this message is about, e.g. /bookings/<id>. */
    link: { type: String, maxlength: 200, default: null },
    channel: { type: String, enum: ['sms', 'email', 'none'], required: true },
    /** Masked recipient, for the delivery log. */
    toMasked: { type: String, maxlength: 120, default: null },
    status: { type: String, enum: NOTIFICATION_STATUSES, required: true, default: 'pending' },
    /** False when the delivered text held a secret that is not stored. */
    resendable: { type: Boolean, required: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    lastError: { type: String, maxlength: 300, default: null },
    provider: { type: String, default: null },
    providerMessageId: { type: String, default: null },
    sentAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    /** Unique per real-world event, so a replayed event notifies once. */
    dedupeKey: { type: String, maxlength: 200 },
    expireAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
notificationSchema.index({ status: 1, nextAttemptAt: 1 });
notificationSchema.index({ status: 1, createdAt: -1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
notificationSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export type NotificationDoc = InferSchemaType<typeof notificationSchema> & { _id: unknown };
export const NotificationModel = model('Notification', notificationSchema, 'notifications');
