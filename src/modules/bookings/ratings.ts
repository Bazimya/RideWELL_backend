import { Schema, Types, model } from 'mongoose';
import { BookingModel, type BookingDoc } from './booking.model.js';
import { alertOps } from './alerts.js';
import { recordAudit } from '../audit/audit.service.js';
import { conflict, notFound } from '../../lib/errors.js';

/** A customer can rate the driver for this long after the trip ends. */
export const RATING_WINDOW_DAYS = 14;
/** Ratings at or below this alert operations. */
export const LOW_RATING_STARS = 2;

/**
 * Customer rates the driver after a completed trip. One per booking, final once
 * given. Only real ratings from real completed trips: none are seeded or edited.
 */
const ratingSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    bookingRef: { type: String, required: true },
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    direction: { type: String, enum: ['customer_to_driver'], default: 'customer_to_driver' },
    stars: { type: Number, required: true, min: 1, max: 5, validate: Number.isInteger },
    comment: { type: String, maxlength: 500, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
ratingSchema.index({ bookingId: 1, fromUserId: 1 }, { unique: true });
ratingSchema.index({ toUserId: 1, createdAt: -1 });
ratingSchema.index({ createdAt: -1 });
export const RatingModel = model('Rating', ratingSchema, 'reviews');

export function canRate(b: Pick<BookingDoc, 'status' | 'endedAt' | 'driverId'>, now = new Date()) {
  return b.status === 'completed' && Boolean(b.driverId) && Boolean(b.endedAt) && now.getTime() - b.endedAt!.getTime() <= RATING_WINDOW_DAYS * 86_400_000;
}

export async function rateDriver(bookingId: string, customerId: string, stars: number, comment: string | null) {
  const b = await BookingModel.findById(bookingId);
  if (!b || String(b.customerId) !== customerId) throw notFound('Booking not found.');
  if (!canRate(b)) throw conflict('not_rateable', `You can rate the driver after a completed trip, for up to ${RATING_WINDOW_DAYS} days.`);
  let rating;
  try {
    rating = await RatingModel.create({ bookingId: b._id, bookingRef: b.ref, fromUserId: customerId, toUserId: b.driverId, stars, comment });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('already_rated', 'You have already rated this trip.');
    throw err;
  }
  await recordAudit({ actor: { type: 'user', id: customerId, roles: ['customer'] }, action: 'rating.created', targetType: 'booking', targetId: String(b._id), after: { stars } });
  if (stars <= LOW_RATING_STARS) {
    await alertOps({ type: 'low_rating', bookingId: b._id, bookingRef: b.ref, message: `${b.ref}: the customer rated the driver ${stars} of 5. Review the trip and contact the customer.` });
  }
  return rating;
}

export async function bookingRating(bookingId: unknown) {
  const r = await RatingModel.findOne({ bookingId }).lean();
  return r ? { stars: r.stars, comment: r.comment ?? null, createdAt: r.createdAt } : null;
}

/** A driver's own ratings. Comments without customer names or booking references. */
export async function driverRatingSummary(driverId: string) {
  const [agg] = await RatingModel.aggregate([
    { $match: { toUserId: new Types.ObjectId(driverId) } },
    { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: '$stars' }, s1: { $sum: { $cond: [{ $eq: ['$stars', 1] }, 1, 0] } }, s2: { $sum: { $cond: [{ $eq: ['$stars', 2] }, 1, 0] } }, s3: { $sum: { $cond: [{ $eq: ['$stars', 3] }, 1, 0] } }, s4: { $sum: { $cond: [{ $eq: ['$stars', 4] }, 1, 0] } }, s5: { $sum: { $cond: [{ $eq: ['$stars', 5] }, 1, 0] } } } },
  ]);
  const recent = await RatingModel.find({ toUserId: driverId }).sort({ createdAt: -1 }).limit(10).select('stars comment createdAt').lean();
  return {
    count: agg?.count ?? 0,
    average: agg ? Math.round(agg.avg * 10) / 10 : null,
    distribution: agg ? { 1: agg.s1, 2: agg.s2, 3: agg.s3, 4: agg.s4, 5: agg.s5 } : { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    recent: recent.map((r) => ({ stars: r.stars, comment: r.comment ?? null, createdAt: r.createdAt })),
  };
}
