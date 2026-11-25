import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth.js';
import { validate, valid, objectIdSchema } from '../../lib/validate.js';
import { phoneSchema } from '../../lib/phone.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { BookingModel, SERVICES } from './booking.model.js';
import {
  acceptTrip,
  cancelBooking,
  completeTrip,
  createBooking,
  declineTrip,
  loadBooking,
  quoteBooking,
  reassign,
  startTrip,
  type NewBookingInput,
} from './booking.service.js';
import { customerView, driverTripView, listRow, ownerTripView, staffView } from './booking.views.js';
import { driverCandidates, vehicleCandidates } from './availability.js';
import { OpsAlertModel } from './alerts.js';
import { SafetyReportModel, reportSafety, resolveSafetyReport } from './safety.js';
import { driverRatingSummary, rateDriver } from './ratings.js';
import { startPayment } from '../payments/payment.service.js';
import { requireConfig, getCurrentConfig } from '../platformConfig/platformConfig.service.js';
import { UserModel } from '../users/user.model.js';
import { hasAdminRole, type Role } from '../users/roles.js';
import { DocumentModel } from '../documents/document.model.js';
import { storage } from '../storage/storage.js';
import { recordAudit, auditContext } from '../audit/audit.service.js';

const idParam = z.strictObject({ id: objectIdSchema });
const text = (max: number) => z.string().trim().min(1).max(max);
const place = z.strictObject({
  address: text(300),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
});

const bookingBody = z
  .strictObject({
    service: z.enum(SERVICES),
    airport: z.strictObject({ direction: z.enum(['from_airport', 'to_airport']), flightNumber: z.string().trim().max(20).nullable().optional() }).nullable().optional(),
    pickup: place,
    dropoff: place.nullable().optional(),
    startAt: z.coerce.date(),
    durationHours: z.number().int().min(1).max(336),
    passengers: z.number().int().min(1).max(60),
    notes: z.string().trim().max(1000).nullable().optional(),
    customerVehicle: z
      .strictObject({
        make: text(60),
        model: text(60),
        plate: z.string().trim().min(4).max(14),
        colour: z.string().trim().max(40).nullable().optional(),
        transmission: z.enum(['automatic', 'manual']).nullable().optional(),
      })
      .nullable()
      .optional(),
  });

const actorOf = (req: Request, type: 'customer' | 'driver' | 'vehicle_partner' | 'staff') => ({ type, id: req.auth!.user.id, roles: req.auth!.user.roles });

// ===========================================================================
// Public: indicative prices for the home page (no personal data)
// ===========================================================================

export function publicRouter(): Router {
  const r = Router();
  r.get('/prices', async (_req, res) => {
    const cfg = await getCurrentConfig();
    res.json({ prices: cfg?.values.priceList ?? null, isPlaceholder: cfg?.isPlaceholder ?? true, currency: 'RWF' });
  });
  return r;
}

// ===========================================================================
// Customers: /bookings
// ===========================================================================

export function customerBookingRouter(): Router {
  const r = Router();
  r.use(authenticate, (req, _res, next) => (req.auth!.sessionKind === 'user' && !hasAdminRole(req.auth!.user.roles as Role[]) ? next() : next(forbidden())));

  r.post('/', validate({ body: bookingBody }), async (req, res) => {
    const b = await createBooking(valid<NewBookingInput>(req, 'body'), req.auth!.user.id, actorOf(req, 'customer'), 'web');
    res.status(201).json(await customerView(b));
  });

  r.get('/', async (req, res) => {
    const rows = await BookingModel.find({ customerId: req.auth!.user.id }).sort({ startAt: -1 }).limit(100);
    res.json({ bookings: rows.map(listRow) });
  });

  const own = async (req: Request) => {
    const b = await loadBooking(valid<{ id: string }>(req, 'params').id);
    if (String(b.customerId) !== req.auth!.user.id) throw notFound('Booking not found.');
    return b;
  };

  r.get('/:id', validate({ params: idParam }), async (req, res) => {
    res.json(await customerView(await own(req)));
  });

  // Pay the quote. The browser sends no amount: the server charges the stored quote.
  r.post('/:id/pay', validate({ params: idParam }), async (req, res) => {
    const b = await own(req);
    const payment = await startPayment(String(b._id), req.auth!.user.id);
    res.json({ payment: { status: payment?.status, isDevelopment: payment?.isDevelopment }, booking: await customerView(await loadBooking(String(b._id))) });
  });

  r.post('/:id/cancel', validate({ params: idParam, body: z.strictObject({ reason: z.string().trim().max(500).nullable().optional() }) }), async (req, res) => {
    const b = await own(req);
    await cancelBooking(String(b._id), actorOf(req, 'customer'), valid<{ reason?: string | null }>(req, 'body').reason ?? null);
    res.json(await customerView(await loadBooking(String(b._id))));
  });

  r.post('/:id/safety-report', validate({ params: idParam, body: z.strictObject({ message: text(2000) }) }), async (req, res) => {
    const b = await own(req);
    await reportSafety(String(b._id), { id: req.auth!.user.id, role: 'customer' }, valid<{ message: string }>(req, 'body').message);
    res.status(201).json(await customerView(await loadBooking(String(b._id))));
  });

  r.post(
    '/:id/rating',
    validate({ params: idParam, body: z.strictObject({ stars: z.number().int().min(1).max(5), comment: z.string().trim().max(500).nullable().optional() }) }),
    async (req, res) => {
      const b = await own(req);
      const body = valid<{ stars: number; comment?: string | null }>(req, 'body');
      await rateDriver(String(b._id), req.auth!.user.id, body.stars, body.comment || null);
      res.status(201).json(await customerView(await loadBooking(String(b._id))));
    },
  );

  /** The assigned driver's approved photo, for this booking's customer only. */
  r.get('/:id/driver-photo', validate({ params: idParam }), async (req, res) => {
    const b = await own(req);
    if (!['assigned', 'in_progress', 'completed'].includes(b.status) || !b.driverId) throw notFound();
    const doc = await DocumentModel.findOne({ ownerId: b.driverId, kind: 'profile_photo', status: 'approved' }).select('+storageKey').sort({ reviewedAt: -1 }).lean();
    if (!doc) throw notFound();
    const body = await storage().get(doc.storageKey);
    res.set({ 'Content-Type': doc.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.end(body);
  });

  return r;
}

// ===========================================================================
// Drivers (/driver/trips) and vehicle owners (/owner/trips)
// ===========================================================================

export function partnerTripRouter(): Router {
  const r = Router();
  // Mounted at the API root: authenticate only this router's own paths.
  r.use(['/driver', '/owner'], authenticate);

  // ---- drivers -------------------------------------------------------------
  const driverOnly = requireRole('driver_partner');

  r.get('/driver/trips', driverOnly, async (req, res) => {
    const me = req.auth!.user.id;
    const since = new Date(Date.now() - 24 * 3_600_000);
    const rows = await BookingModel.find({
      driverId: me,
      $or: [{ status: { $in: ['paid', 'assigned', 'in_progress'] } }, { status: 'completed', endedAt: { $gt: since } }],
    }).sort({ startAt: 1 });
    res.json({ trips: await Promise.all(rows.map((b) => driverTripView(b, me))) });
  });

  const myTrip = async (req: Request) => {
    const b = await loadBooking(valid<{ id: string }>(req, 'params').id);
    const me = req.auth!.user.id;
    const since = Date.now() - 24 * 3_600_000;
    const visible = String(b.driverId) === me && (['paid', 'assigned', 'in_progress'].includes(b.status) || (b.status === 'completed' && (b.endedAt?.getTime() ?? 0) > since));
    if (!visible) throw notFound('Trip not found.');
    return b;
  };

  r.get('/driver/trips/:id', driverOnly, validate({ params: idParam }), async (req, res) => {
    res.json(await driverTripView(await myTrip(req), req.auth!.user.id));
  });
  r.post('/driver/trips/:id/accept', driverOnly, validate({ params: idParam }), async (req, res) => {
    const b = await acceptTrip(valid<{ id: string }>(req, 'params').id, req.auth!.user.id, 'driver');
    res.json(await driverTripView(b, req.auth!.user.id));
  });
  r.post('/driver/trips/:id/decline', driverOnly, validate({ params: idParam, body: z.strictObject({ reason: z.string().trim().max(500).nullable().optional() }) }), async (req, res) => {
    await declineTrip(valid<{ id: string }>(req, 'params').id, req.auth!.user.id, 'driver', valid<{ reason?: string | null }>(req, 'body').reason ?? null);
    res.status(204).end();
  });
  r.post('/driver/trips/:id/start', driverOnly, validate({ params: idParam, body: z.strictObject({ pin: z.string().regex(/^\d{4}$/, 'Enter the 4-digit PIN.') }) }), async (req, res) => {
    const b = await startTrip(valid<{ id: string }>(req, 'params').id, req.auth!.user.id, valid<{ pin: string }>(req, 'body').pin);
    res.json(await driverTripView(b, req.auth!.user.id));
  });
  r.post('/driver/trips/:id/complete', driverOnly, validate({ params: idParam }), async (req, res) => {
    const b = await completeTrip(valid<{ id: string }>(req, 'params').id, actorOf(req, 'driver'));
    res.json(await driverTripView(b, req.auth!.user.id));
  });
  r.get('/driver/ratings', driverOnly, async (req, res) => {
    res.json(await driverRatingSummary(req.auth!.user.id));
  });
  r.post('/driver/trips/:id/safety-report', driverOnly, validate({ params: idParam, body: z.strictObject({ message: text(2000) }) }), async (req, res) => {
    const b = await myTrip(req);
    await reportSafety(String(b._id), { id: req.auth!.user.id, role: 'driver' }, valid<{ message: string }>(req, 'body').message);
    res.status(201).json(await driverTripView(await loadBooking(String(b._id)), req.auth!.user.id));
  });

  // ---- vehicle owners ------------------------------------------------------
  const ownerOnly = requireRole('vehicle_partner');

  r.get('/owner/trips', ownerOnly, async (req, res) => {
    const rows = await BookingModel.find({ vehicleOwnerId: req.auth!.user.id, status: { $in: ['paid', 'assigned', 'in_progress', 'completed'] } }).sort({ startAt: -1 }).limit(200);
    res.json({ trips: await Promise.all(rows.map(ownerTripView)) });
  });
  r.post('/owner/trips/:id/accept', ownerOnly, validate({ params: idParam }), async (req, res) => {
    res.json(await ownerTripView(await acceptTrip(valid<{ id: string }>(req, 'params').id, req.auth!.user.id, 'vehicle_partner')));
  });
  r.post('/owner/trips/:id/decline', ownerOnly, validate({ params: idParam, body: z.strictObject({ reason: z.string().trim().max(500).nullable().optional() }) }), async (req, res) => {
    await declineTrip(valid<{ id: string }>(req, 'params').id, req.auth!.user.id, 'vehicle_partner', valid<{ reason?: string | null }>(req, 'body').reason ?? null);
    res.status(204).end();
  });

  return r;
}

// ===========================================================================
// Staff: /admin/bookings, /admin/alerts, /admin/safety-reports
// ===========================================================================

export function adminBookingRouter(): Router {
  const r = Router();
  // Mounted at /admin alongside other admin routers: guard only this router's paths.
  r.use(['/bookings', '/alerts', '/safety-reports'], authenticate, (req, _res, next) => (req.auth!.sessionKind === 'admin' ? next() : next(forbidden())));
  const staff = (req: Request) => actorOf(req, 'staff');

  r.get(
    '/bookings',
    requirePermission('bookings.view'),
    validate({
      query: z.strictObject({
        status: z.string().optional(),
        attention: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
    }),
    async (req, res) => {
      const q = valid<{ status?: string; attention?: string; limit: number }>(req, 'query');
      const filter: Record<string, unknown> = {};
      if (q.status) filter.status = { $in: q.status.split(',').filter((s) => /^[a-z_]+$/.test(s)) };
      if (q.attention === 'true') filter.$or = [{ 'attention.needsReassignment': true }, { pinLocked: true }, { hasOpenSafetyReport: true }];
      const rows = await BookingModel.find(filter).sort({ startAt: 1 }).limit(q.limit);
      res.json({ bookings: rows.map(listRow) });
    },
  );

  // Phone bookings: staff book for a customer, found or created by phone number.
  r.post(
    '/bookings',
    requirePermission('bookings.manage'),
    validate({ body: bookingBody.extend({ customerPhone: phoneSchema, customerFirstName: z.string().trim().max(80).optional(), customerLastName: z.string().trim().max(80).optional() }) }),
    async (req, res) => {
      const body = valid<NewBookingInput & { customerPhone: string; customerFirstName?: string; customerLastName?: string }>(req, 'body');
      let customer = await UserModel.findOne({ phone: body.customerPhone });
      if (customer && hasAdminRole(customer.roles as Role[])) throw forbidden('This phone number belongs to a staff account.');
      if (!customer) {
        customer = await UserModel.create({ phone: body.customerPhone, firstName: body.customerFirstName, lastName: body.customerLastName, roles: ['customer'], status: 'active' });
        await recordAudit({ actor: { type: 'user', id: req.auth!.user.id, roles: req.auth!.user.roles }, action: 'user.created_for_phone_booking', targetType: 'user', targetId: customer.id, ...auditContext(req) });
      }
      const { customerPhone: _p, customerFirstName: _f, customerLastName: _l, ...input } = body;
      const b = await createBooking(input, customer.id, staff(req), 'phone');
      res.status(201).json(await staffView(b));
    },
  );

  r.get('/bookings/:id', requirePermission('bookings.view'), validate({ params: idParam }), async (req, res) => {
    res.json(await staffView(await loadBooking(valid<{ id: string }>(req, 'params').id)));
  });

  r.get('/bookings/:id/candidates', requirePermission('bookings.manage'), validate({ params: idParam, query: z.strictObject({ durationHours: z.coerce.number().int().min(1).max(336).optional() }) }), async (req, res) => {
    const b = await loadBooking(valid<{ id: string }>(req, 'params').id);
    const { durationHours } = valid<{ durationHours?: number }>(req, 'query');
    const endAt = durationHours ? new Date(b.startAt.getTime() + durationHours * 3_600_000) : b.endAt;
    const buffer = (await requireConfig()).values.schedulingBufferMinutes;
    res.json({
      drivers: await driverCandidates(b.startAt, endAt, buffer, String(b._id)),
      vehicles: b.service === 'chauffeur' ? await vehicleCandidates(b.startAt, endAt, buffer, b.passengers, String(b._id)) : [],
      bufferMinutes: buffer,
    });
  });

  r.post(
    '/bookings/:id/quote',
    requirePermission('bookings.manage'),
    validate({
      params: idParam,
      body: z.strictObject({
        amountRwf: z.number().int().min(100).max(100_000_000),
        driverId: objectIdSchema,
        vehicleId: objectIdSchema.nullable().optional(),
        durationHours: z.number().int().min(1).max(336).optional(),
        note: z.string().trim().max(500).nullable().optional(),
      }),
    }),
    async (req, res) => {
      const b = await quoteBooking(valid<{ id: string }>(req, 'params').id, valid(req, 'body'), staff(req));
      res.json(await staffView(b));
    },
  );

  r.post(
    '/bookings/:id/assign',
    requirePermission('bookings.manage'),
    validate({ params: idParam, body: z.strictObject({ driverId: objectIdSchema.nullable().optional(), vehicleId: objectIdSchema.nullable().optional() }) }),
    async (req, res) => {
      const b = await reassign(valid<{ id: string }>(req, 'params').id, valid(req, 'body'), staff(req));
      res.json(await staffView(b));
    },
  );

  r.post(
    '/bookings/:id/cancel',
    requirePermission('bookings.manage'),
    validate({ params: idParam, body: z.strictObject({ reason: text(500), refundMode: z.enum(['policy', 'full']).default('policy') }) }),
    async (req, res) => {
      const body = valid<{ reason: string; refundMode: 'policy' | 'full' }>(req, 'body');
      const b = await cancelBooking(valid<{ id: string }>(req, 'params').id, staff(req), body.reason, body.refundMode);
      res.json(await staffView(b));
    },
  );

  r.post('/bookings/:id/complete', requirePermission('bookings.manage'), validate({ params: idParam, body: z.strictObject({ reason: text(500) }) }), async (req, res) => {
    const b = await completeTrip(valid<{ id: string }>(req, 'params').id, staff(req), valid<{ reason: string }>(req, 'body').reason);
    res.json(await staffView(b));
  });

  // ---- alerts ----------------------------------------------------------------

  r.get('/alerts', requirePermission('bookings.view', 'safety.handle'), async (_req, res) => {
    const alerts = await OpsAlertModel.find({ resolvedAt: null }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ alerts: alerts.map((a) => ({ id: String(a._id), type: a.type, severity: a.severity, bookingId: a.bookingId ? String(a.bookingId) : null, bookingRef: a.bookingRef, message: a.message, createdAt: a.createdAt })) });
  });

  r.post('/alerts/:id/resolve', requirePermission('bookings.manage', 'safety.handle'), validate({ params: idParam, body: z.strictObject({ resolution: text(500) }) }), async (req, res) => {
    const { id } = valid<{ id: string }>(req, 'params');
    const resolution = valid<{ resolution: string }>(req, 'body').resolution;
    const done = await OpsAlertModel.findOneAndUpdate({ _id: id, resolvedAt: null }, { $set: { resolvedAt: new Date(), resolvedBy: req.auth!.user.id, resolution } }, { new: true }).lean();
    if (!done) throw notFound('Alert not found or already resolved.');
    await recordAudit({ actor: { type: 'user', id: req.auth!.user.id, roles: req.auth!.user.roles }, action: 'alert.resolved', targetType: 'alert', targetId: id, reason: resolution, ...auditContext(req) });
    res.status(204).end();
  });

  // ---- safety reports ----------------------------------------------------------

  r.get('/safety-reports', requirePermission('safety.handle'), validate({ query: z.strictObject({ status: z.enum(['open', 'resolved']).default('open') }) }), async (req, res) => {
    const reports = await SafetyReportModel.find({ status: valid<{ status: string }>(req, 'query').status }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({
      reports: reports.map((r) => ({
        id: String(r._id),
        bookingId: String(r.bookingId),
        bookingRef: r.bookingRef,
        reporterRole: r.reporterRole,
        message: r.message,
        status: r.status,
        resolution: r.resolution,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
      })),
    });
  });

  r.post(
    '/safety-reports/:id/resolve',
    requirePermission('safety.handle'),
    validate({ params: idParam, body: z.strictObject({ resolution: text(2000), releaseDriver: z.boolean() }) }),
    async (req, res) => {
      const body = valid<{ resolution: string; releaseDriver: boolean }>(req, 'body');
      await resolveSafetyReport(valid<{ id: string }>(req, 'params').id, req.auth!.user.id, req.auth!.user.roles, body.resolution, body.releaseDriver);
      res.status(204).end();
    },
  );

  return r;
}
