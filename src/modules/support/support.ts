import crypto from 'node:crypto';
import { Router } from 'express';
import { Schema, model, type Types } from 'mongoose';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate, valid, objectIdSchema } from '../../lib/validate.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { BookingModel } from '../bookings/booking.model.js';
import { UserModel } from '../users/user.model.js';
import { notifyUser } from '../notifications/notification.service.js';
import { auditContext, recordAudit } from '../audit/audit.service.js';

export const SUPPORT_CATEGORIES = ['booking', 'payment', 'account', 'partner', 'other'] as const;
/** Open requests one person may have at a time. */
export const MAX_OPEN_REQUESTS = 5;

/**
 * "Request support" (customers and partners) and "handle support" (operations).
 * Safety problems go through safety reports instead, which alert operations at once.
 */
const supportSchema = new Schema(
  {
    ref: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    bookingRef: { type: String, default: null },
    category: { type: String, enum: SUPPORT_CATEGORIES, required: true },
    message: { type: String, required: true, maxlength: 2000 },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    /** Staff reply shown to the person who asked. */
    reply: { type: String, maxlength: 2000, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
supportSchema.index({ ref: 1 }, { unique: true });
supportSchema.index({ userId: 1, createdAt: -1 });
supportSchema.index({ status: 1, createdAt: -1 });
export const SupportRequestModel = model('SupportRequest', supportSchema, 'supportRequests');

const newRef = () => `S-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

type SupportDoc = { _id: unknown; ref: string; bookingRef?: string | null; bookingId?: Types.ObjectId | null; category: string; message: string; status: string; reply?: string | null; createdAt: Date; resolvedAt?: Date | null };
const view = (s: SupportDoc) => ({
  id: String(s._id),
  ref: s.ref,
  bookingId: s.bookingId ? String(s.bookingId) : null,
  bookingRef: s.bookingRef ?? null,
  category: s.category,
  message: s.message,
  status: s.status,
  reply: s.reply ?? null,
  createdAt: s.createdAt,
  resolvedAt: s.resolvedAt ?? null,
});

const text = (max: number) => z.string().trim().min(3).max(max);

/** /support: the signed-in person's own requests. */
export function supportRouter(): Router {
  const r = Router();
  r.use(authenticate, (req, _res, next) => (req.auth!.sessionKind === 'user' ? next() : next(forbidden('Staff accounts do not open support requests.'))));

  r.get('/', async (req, res) => {
    const rows = await SupportRequestModel.find({ userId: req.auth!.user.id }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ requests: rows.map(view) });
  });

  r.post('/', validate({ body: z.strictObject({ category: z.enum(SUPPORT_CATEGORIES), message: text(2000), bookingId: objectIdSchema.nullable().optional() }) }), async (req, res) => {
    const body = valid<{ category: string; message: string; bookingId?: string | null }>(req, 'body');
    const userId = req.auth!.user.id;
    if ((await SupportRequestModel.countDocuments({ userId, status: 'open' })) >= MAX_OPEN_REQUESTS) {
      throw conflict('too_many_open', `You already have ${MAX_OPEN_REQUESTS} open requests. We will answer them first.`);
    }
    let booking = null;
    if (body.bookingId) {
      booking = await BookingModel.findById(body.bookingId).select('ref customerId driverId vehicleOwnerId').lean();
      const party = booking && [booking.customerId, booking.driverId, booking.vehicleOwnerId].some((id) => id && String(id) === userId);
      if (!party) throw notFound('Booking not found.');
    }
    let created;
    for (let i = 0; i < 5 && !created; i++) {
      try {
        created = await SupportRequestModel.create({ ref: newRef(), userId, bookingId: booking?._id ?? null, bookingRef: booking?.ref ?? null, category: body.category, message: body.message });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }
    }
    if (!created) throw conflict('try_again', 'Please try again.');
    await recordAudit({ actor: { type: 'user', id: userId, roles: req.auth!.user.roles }, action: 'support.requested', targetType: 'support', targetId: String(created._id), after: { category: body.category, bookingRef: booking?.ref ?? null }, ...auditContext(req) });
    await notifyUser(userId, 'support.received', { ref: created.ref }, { link: '/support', dedupeKey: `support.received/${created._id}` });
    res.status(201).json({ request: view(created.toObject()) });
  });

  return r;
}

/** /admin/support: operations answer and close requests. */
export function adminSupportRouter(): Router {
  const r = Router();
  r.use(authenticate, (req, _res, next) => (req.auth!.sessionKind === 'admin' ? next() : next(forbidden())));

  r.get('/', requirePermission('support.handle'), validate({ query: z.strictObject({ status: z.enum(['open', 'resolved']).default('open') }) }), async (req, res) => {
    const rows = await SupportRequestModel.find({ status: valid<{ status: string }>(req, 'query').status }).sort({ createdAt: valid<{ status: string }>(req, 'query').status === 'open' ? 1 : -1 }).limit(200).lean();
    const users = await UserModel.find({ _id: { $in: rows.map((s) => s.userId) } }).select('firstName lastName phone email roles').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    res.json({
      requests: rows.map((s) => {
        const u = byId.get(String(s.userId));
        return { ...view(s), user: u ? { id: String(u._id), name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null, phone: u.phone ?? null, email: u.email ?? null, roles: u.roles } : null };
      }),
    });
  });

  r.post('/:id/resolve', requirePermission('support.handle'), validate({ params: z.strictObject({ id: objectIdSchema }), body: z.strictObject({ reply: text(2000) }) }), async (req, res) => {
    const { id } = valid<{ id: string }>(req, 'params');
    const { reply } = valid<{ reply: string }>(req, 'body');
    const s = await SupportRequestModel.findOneAndUpdate({ _id: id, status: 'open' }, { $set: { status: 'resolved', reply, resolvedBy: req.auth!.user.id, resolvedAt: new Date() } }, { new: true });
    if (!s) {
      if (await SupportRequestModel.exists({ _id: id })) throw conflict('already_resolved', 'This request is already answered.');
      throw notFound('Request not found.');
    }
    await recordAudit({ actor: { type: 'user', id: req.auth!.user.id, roles: req.auth!.user.roles }, action: 'support.resolved', targetType: 'support', targetId: id, ...auditContext(req) });
    await notifyUser(String(s.userId), 'support.answered', { ref: s.ref }, { link: '/support', dedupeKey: `support.answered/${s._id}` });
    res.json({ request: view(s.toObject()) });
  });

  return r;
}
