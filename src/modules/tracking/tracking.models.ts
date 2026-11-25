import { Schema, model } from 'mongoose';

/**
 * Raw location points. Deleted automatically at `purgeAt` (TTL index): the
 * retention period after the trip ends, or never while a safety report on the
 * booking is open (`purgeAt: null`, which the TTL index ignores).
 */
const locationPointSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: String, enum: ['driver_web', 'driver_app'], default: 'driver_web' },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    accuracyM: { type: Number, required: true, min: 0 },
    headingDeg: { type: Number, default: null },
    speedMps: { type: Number, default: null },
    recordedAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true },
    purgeAt: { type: Date, default: null },
  },
  { versionKey: false },
);
locationPointSchema.index({ bookingId: 1, recordedAt: -1 });
locationPointSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export const LocationPointModel = model('LocationPoint', locationPointSchema, 'locationPoints');

/**
 * Break-glass access: one staff member, one booking, a written reason. Valid only
 * while the booking has an open safety report or an open trip-not-started alert.
 */
const trackingAccessSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true, maxlength: 500 },
    basis: { type: String, enum: ['safety_report', 'trip_not_started'], required: true },
    expiresAt: { type: Date, required: true },
    lastAuditedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
trackingAccessSchema.index({ bookingId: 1, staffId: 1, expiresAt: -1 });
export const TrackingAccessModel = model('TrackingAccess', trackingAccessSchema, 'trackingAccess');
