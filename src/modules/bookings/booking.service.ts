import crypto from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import { BookingModel, type BookingDoc, type BookingStatus, type Service } from './booking.model.js';
import { assertTransition, type ActorType } from './booking.states.js';
import { assertDriverFree, assertVehicleFree, lockResources } from './availability.js';
import { alertOps } from './alerts.js';
import { requireConfig, requireFinancialConfig, type CurrentConfig } from '../platformConfig/platformConfig.service.js';
import { withTransaction } from '../../db/transaction.js';
import { recordAudit } from '../audit/audit.service.js';
import { notifyUser } from '../notifications/notification.service.js';
import { decryptSecret, encryptSecret, randomDigits, safeEqual } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { applyBps, splitByBps } from '../../lib/money.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel } from '../partners/partner.models.js';
import { driverEligibility, vehicleEligibility } from '../partners/requirements.js';
import { onPaidBookingCancelled, onTripCompleted, onTripStarted, reallocateEarning } from '../finance/finance.service.js';
import { announceClosed, closeTracking } from '../tracking/tracking.service.js';

export interface Actor {
  type: ActorType;
  id: string | null;
  roles?: string[];
}

const KIGALI = 'Africa/Kigali';
export const fmtWhen = (d: Date) =>
  d.toLocaleString('en-GB', { timeZone: KIGALI, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const HOUR = 3_600_000;

type AfterCommit = Array<() => Promise<unknown>>;
async function runAfter(list: AfterCommit) {
  for (const fn of list) await fn();
}

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRef(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
  return `RW-${s}`;
}

export async function loadBooking(id: string, session?: ClientSession): Promise<BookingDoc> {
  const b = await BookingModel.findById(id, null, session ? { session } : {}).select('+tripPinEnc');
  if (!b) throw notFound('Booking not found.');
  return b;
}

/** Move a booking along the state machine, with history and an audit entry. */
async function moveTo(b: BookingDoc, to: BookingStatus, actor: Actor, reason: string | null, session: ClientSession | null) {
  const from = b.status as BookingStatus;
  assertTransition(from, to, actor.type);
  b.status = to;
  b.statusHistory.push({ from, to, at: new Date(), actorType: actor.type, by: (actor.id as unknown as Types.ObjectId) ?? null, reason });
  await b.save(session ? { session } : {});
  await recordAudit(
    {
      actor: actor.id ? { type: 'user', id: actor.id, roles: actor.roles ?? [actor.type] } : { type: 'system', name: actor.type },
      action: `booking.${to}`,
      targetType: 'booking',
      targetId: String(b._id),
      before: { status: from },
      after: { status: to },
      reason,
    },
    session ?? undefined,
  );
}

/**
 * How long partners have to accept: the configured deadline (30 min), or for
 * pickups closer than the short-notice threshold (2 h), the shorter of that and
 * half the time remaining (brief §0).
 */
export function acceptanceDeadline(now: Date, startAt: Date, cfg: CurrentConfig['values']): Date {
  const base = cfg.acceptanceDeadlineMinutes * 60_000;
  const remaining = startAt.getTime() - now.getTime();
  const ms = remaining < cfg.shortNoticeThresholdHours * HOUR ? Math.max(60_000, Math.min(base, Math.floor(remaining / 2))) : base;
  return new Date(now.getTime() + ms);
}

/** Refund the cancellation policy gives at `now` (tiers snapshotted at quote time). */
export function policyRefund(b: Pick<BookingDoc, 'startAt' | 'quote' | 'commissionSnapshot'>, now: Date) {
  const amount = b.quote?.amountRwf ?? 0;
  const hoursBefore = Math.max(0, (b.startAt.getTime() - now.getTime()) / HOUR);
  const tiers = (b.commissionSnapshot?.cancellationTiers ?? []) as Array<{ minHoursBeforePickup: number; refundBps: number }>;
  const tier = tiers.find((t) => hoursBefore >= t.minHoursBeforePickup);
  const refundBps = tier?.refundBps ?? 0;
  return { hoursBeforePickup: Math.round(hoursBefore * 10) / 10, refundBps, refundDueRwf: amount ? applyBps(amount, refundBps) : 0 };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface NewBookingInput {
  service: Service;
  airport?: { direction: 'from_airport' | 'to_airport'; flightNumber?: string | null } | null;
  pickup: { address: string; lat?: number | null; lng?: number | null; notes?: string | null };
  dropoff?: { address: string; lat?: number | null; lng?: number | null; notes?: string | null } | null;
  startAt: Date;
  durationHours: number;
  passengers: number;
  notes?: string | null;
  customerVehicle?: { make: string; model: string; plate: string; colour?: string | null; transmission?: 'automatic' | 'manual' | null } | null;
}

export async function createBooking(input: NewBookingInput, customerId: string, createdBy: Actor, channel: 'web' | 'phone') {
  const cfg = (await requireConfig()).values;
  const now = Date.now();
  if (input.startAt.getTime() < now + cfg.minBookingNoticeMinutes * 60_000) {
    throw badRequest('too_soon', `Pickup must be at least ${cfg.minBookingNoticeMinutes} minutes from now.`);
  }
  if (input.startAt.getTime() > now + cfg.maxBookingAheadDays * 24 * HOUR) {
    throw badRequest('too_far', `Bookings can be made up to ${cfg.maxBookingAheadDays} days ahead.`);
  }
  if (input.service === 'driver_on_demand' && !input.customerVehicle) {
    throw badRequest('vehicle_required', 'Tell us the make, model and plate of the car our driver will drive.');
  }
  if (input.service === 'chauffeur' && input.customerVehicle) throw badRequest('invalid_input', 'Chauffeur bookings use a RideWELL vehicle.');
  if (input.airport && input.service !== 'chauffeur') throw badRequest('invalid_input', 'Airport transfers are chauffeur bookings.');
  if (input.airport && !input.dropoff) throw badRequest('dropoff_required', 'Airport transfers need a drop-off.');

  const customer = await UserModel.findById(customerId).lean();
  if (!customer || customer.status !== 'active') throw forbidden('This account cannot book.');

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const b = await BookingModel.create({
        ref: newRef(),
        service: input.service,
        airport: input.airport ? { direction: input.airport.direction, flightNumber: input.airport.flightNumber ?? null } : { direction: null, flightNumber: null },
        customerId,
        channel,
        createdBy: createdBy.id,
        pickup: input.pickup,
        dropoff: input.dropoff ?? null,
        startAt: input.startAt,
        endAt: new Date(input.startAt.getTime() + input.durationHours * HOUR),
        passengers: input.passengers,
        notes: input.notes ?? null,
        customerVehicle: input.customerVehicle ?? {},
        status: 'requested',
        statusHistory: [{ from: null, to: 'requested', at: new Date(), actorType: createdBy.type, by: createdBy.id }],
      });
      await recordAudit({
        actor: createdBy.id ? { type: 'user', id: createdBy.id, roles: createdBy.roles ?? [] } : { type: 'system', name: 'booking' },
        action: 'booking.requested',
        targetType: 'booking',
        targetId: b.id,
        after: { ref: b.ref, service: b.service, channel, startAt: b.startAt },
      });
      await notifyUser(customerId, 'booking.received', { ref: b.ref }, { link: `/bookings/${b._id}` });
      return b;
    } catch (err) {
      if ((err as { code?: number; keyPattern?: Record<string, unknown> }).code === 11000 && (err as { keyPattern?: Record<string, unknown> }).keyPattern?.ref) continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a booking reference');
}

// ---------------------------------------------------------------------------
// Quote (staff): choose partners, price, snapshot the split
// ---------------------------------------------------------------------------

export async function quoteBooking(
  bookingId: string,
  input: { amountRwf: number; driverId: string; vehicleId?: string | null; durationHours?: number; note?: string | null },
  staff: Actor,
) {
  const cfg = await requireFinancialConfig();
  const values = cfg.values;
  const after: AfterCommit = [];
  const booking = await withTransaction(async (session) => {
    after.length = 0; // the driver may retry this callback
    const b = await loadBooking(bookingId, session);
    if (b.status !== 'requested' && b.status !== 'quoted') throw conflict('not_quotable', `A ${b.status.replace('_', ' ')} booking cannot be quoted.`);
    if (b.service === 'chauffeur' && !input.vehicleId) throw badRequest('vehicle_required', 'Choose a vehicle for a chauffeur booking.');
    if (b.service === 'driver_on_demand' && input.vehicleId) throw badRequest('invalid_input', 'Driver on Demand uses the customer’s car.');
    if (input.durationHours) b.endAt = new Date(b.startAt.getTime() + input.durationHours * HOUR);

    // Lock, then check: a concurrent assignment of the same driver/vehicle conflicts here.
    await lockResources([`driver:${input.driverId}`, ...(input.vehicleId ? [`vehicle:${input.vehicleId}`] : [])], session);
    const driverProblems = await assertDriverFree(input.driverId, b.startAt, b.endAt, values.schedulingBufferMinutes, String(b._id), session);
    if (driverProblems.length) throw new AppError(409, 'driver_unavailable', 'This driver cannot take this booking.', driverProblems);
    let ownerUserId: string | null = null;
    if (input.vehicleId) {
      const v = await assertVehicleFree(input.vehicleId, b.startAt, b.endAt, values.schedulingBufferMinutes, b.passengers, String(b._id), session);
      if (v.reasons.length) throw new AppError(409, 'vehicle_unavailable', 'This vehicle cannot take this booking.', v.reasons);
      ownerUserId = v.ownerUserId;
    }

    const sharesBps =
      b.service === 'driver_on_demand'
        ? { platform: values.shares.driver_on_demand.platformBps, driver: values.shares.driver_on_demand.driverBps }
        : { platform: values.shares.chauffeur.platformBps, driver: values.shares.chauffeur.driverBps, vehicle_owner: values.shares.chauffeur.vehicleOwnerBps };
    const now = new Date();
    const validUntil = new Date(Math.min(now.getTime() + values.quoteValidityHours * HOUR, b.startAt.getTime()));
    b.quote = { amountRwf: input.amountRwf, note: input.note ?? null, sentAt: now, sentBy: staff.id as unknown as Types.ObjectId, validUntil } as never;
    b.commissionSnapshot = {
      configVersion: cfg.version,
      isPlaceholder: cfg.isPlaceholder,
      sharesBps,
      split: splitByBps(input.amountRwf, sharesBps as Record<string, number> & { platform: number }),
      providerFeeBearer: values.providerFeeBearer,
      cancellationTiers: values.cancellationTiers,
    } as never;
    b.driverId = input.driverId as unknown as Types.ObjectId;
    b.vehicleId = (input.vehicleId ?? null) as unknown as Types.ObjectId;
    b.vehicleOwnerId = ownerUserId as unknown as Types.ObjectId;
    await moveTo(b, 'quoted', staff, input.note ?? null, session);
    after.push(() => notifyUser(String(b.customerId), 'booking.quoted', { ref: b.ref, amount: input.amountRwf.toLocaleString('en-US'), validUntil: fmtWhen(validUntil) }, { link: `/bookings/${b._id}` }));
    return b;
  });
  await runAfter(after);
  return booking;
}

// ---------------------------------------------------------------------------
// Payment confirmed → paid; partners are offered the trip
// ---------------------------------------------------------------------------

/**
 * Called by the payment service once the provider has confirmed the payment and
 * the exact amount (never by a browser). Runs inside the payment transaction.
 */
export async function markPaid(bookingId: string, session: ClientSession): Promise<AfterCommit> {
  const cfg = (await requireConfig(session)).values;
  const b = await loadBooking(bookingId, session);
  const now = new Date();
  await moveTo(b, 'paid', { type: 'payment', id: null }, null, session);
  b.acceptance = { deadline: acceptanceDeadline(now, b.startAt, cfg), offeredAt: now, driverAcceptedAt: null, vehicleAcceptedAt: null } as never;
  await b.save({ session });
  return [() => notifyUser(String(b.customerId), 'booking.paid', { ref: b.ref }, { link: `/bookings/${b._id}`, dedupeKey: `booking.paid/${b._id}` }), ...offerNotifications(b)];
}

function offerNotifications(b: BookingDoc): AfterCommit {
  const vars = { ref: b.ref, when: fmtWhen(b.startAt), deadline: fmtWhen(b.acceptance!.deadline!) };
  const out: AfterCommit = [];
  if (b.driverId && !b.acceptance?.driverAcceptedAt) out.push(() => notifyUser(String(b.driverId), 'trip.offer', vars, { link: `/driver/trips/${b._id}` }));
  if (b.vehicleOwnerId && !b.acceptance?.vehicleAcceptedAt) out.push(() => notifyUser(String(b.vehicleOwnerId), 'trip.offer', vars, { link: '/owner/trips' }));
  return out;
}

// ---------------------------------------------------------------------------
// Partner acceptance
// ---------------------------------------------------------------------------

export type PartnerRole = 'driver' | 'vehicle_partner';

export async function acceptTrip(bookingId: string, userId: string, role: PartnerRole) {
  const after: AfterCommit = [];
  const b = await withTransaction(async (session) => {
    after.length = 0; // the driver may retry this callback
    const b = await loadBooking(bookingId, session);
    const mine = role === 'driver' ? String(b.driverId) === userId : String(b.vehicleOwnerId) === userId;
    if (!mine) throw notFound('Trip not found.');
    if (b.status !== 'paid') throw conflict('not_offered', 'This trip is not waiting for acceptance.');
    if (b.acceptance?.deadline && b.acceptance.deadline < new Date()) throw conflict('acceptance_expired', 'The time to accept this trip has passed. Operations will contact you.');
    // Spec: "partner still approved, insurance not expired" at acceptance.
    if (role === 'driver') {
      if (b.acceptance?.driverAcceptedAt) return b;
      const elig = await driverEligibility(userId, b.endAt);
      const blocking = elig.reasons.filter((r) => r !== 'not_accepting_trips');
      if (blocking.length) throw new AppError(409, 'not_eligible', 'You cannot accept this trip right now.', blocking);
      b.set('acceptance.driverAcceptedAt', new Date());
    } else {
      if (b.acceptance?.vehicleAcceptedAt) return b;
      const elig = await vehicleEligibility(String(b.vehicleId), b.endAt);
      const blocking = elig.reasons.filter((r) => r !== 'not_accepting_trips');
      if (blocking.length) throw new AppError(409, 'not_eligible', 'This vehicle cannot take this trip right now.', blocking);
      b.set('acceptance.vehicleAcceptedAt', new Date());
    }
    await b.save({ session });
    await recordAudit({ actor: { type: 'user', id: userId, roles: [role] }, action: `booking.accepted_by_${role}`, targetType: 'booking', targetId: b.id }, session);

    const complete = Boolean(b.acceptance?.driverAcceptedAt) && (b.service === 'driver_on_demand' || Boolean(b.acceptance?.vehicleAcceptedAt));
    if (complete) {
      const pin = randomDigits(4);
      b.tripPinEnc = encryptSecret(pin);
      b.pinFailedAttempts = 0;
      b.pinLocked = false;
      b.set('attention.needsReassignment', false);
      b.set('attention.reason', null);
      await moveTo(b, 'assigned', { type: role, id: userId, roles: [role] }, null, session);
      const driver = await UserModel.findById(b.driverId, null, { session }).lean();
      const vehicle = b.vehicleId ? await VehicleModel.findById(b.vehicleId, null, { session }).lean() : null;
      after.push(() =>
        notifyUser(String(b.customerId), 'trip.assigned', {
          ref: b.ref,
          driverName: driver?.firstName ?? 'your driver',
          vehicle: vehicle ? ` in a ${vehicle.colour} ${vehicle.make} ${vehicle.model}, plate ${vehicle.plate}` : '',
          pin,
        }, { link: `/bookings/${b._id}` }),
      );
    }
    return b;
  });
  await runAfter(after);
  return b;
}

export async function declineTrip(bookingId: string, userId: string, role: PartnerRole, reason: string | null) {
  const b = await withTransaction(async (session) => {
    const b = await loadBooking(bookingId, session);
    const mine = role === 'driver' ? String(b.driverId) === userId : String(b.vehicleOwnerId) === userId;
    if (!mine) throw notFound('Trip not found.');
    if (b.status !== 'paid' && b.status !== 'quoted') throw conflict('cannot_decline', 'Only trips not yet confirmed can be declined. Contact operations.');
    b.declines.push({ by: userId as unknown as Types.ObjectId, role, at: new Date(), reason: reason ?? null });
    if (role === 'driver') {
      b.driverId = null;
      b.set('acceptance.driverAcceptedAt', null);
    } else {
      b.vehicleId = null;
      b.vehicleOwnerId = null;
      b.set('acceptance.vehicleAcceptedAt', null);
    }
    b.set('attention.needsReassignment', true);
    b.set('attention.reason', `${role === 'driver' ? 'Driver' : 'Vehicle owner'} declined`);
    await b.save({ session });
    await reallocateEarning(String(b._id), role === 'driver' ? 'driver' : 'vehicle_owner', null, { id: userId }, session);
    await recordAudit({ actor: { type: 'user', id: userId, roles: [role] }, action: `booking.declined_by_${role}`, targetType: 'booking', targetId: b.id, reason }, session);
    return b;
  });
  await alertOps({
    type: 'acceptance_declined',
    bookingId: b._id,
    bookingRef: b.ref,
    message: `${b.ref}: the ${role === 'driver' ? 'driver' : 'vehicle owner'} declined. Reassign before ${fmtWhen(b.startAt)}.`,
  });
  return b;
}

/**
 * Staff choose a new driver and/or vehicle for a paid or assigned booking (decline,
 * timeout, suspension, or operations' choice). Overlap-checked under the same locks.
 */
export async function reassign(bookingId: string, input: { driverId?: string | null; vehicleId?: string | null }, staff: Actor) {
  const cfg = (await requireConfig()).values;
  const after: AfterCommit = [];
  const b = await withTransaction(async (session) => {
    after.length = 0; // the driver may retry this callback
    const b = await loadBooking(bookingId, session);
    if (!['quoted', 'paid', 'assigned'].includes(b.status)) throw conflict('cannot_reassign', `A ${b.status.replace('_', ' ')} booking cannot be reassigned.`);
    const driverId = input.driverId ?? (b.driverId ? String(b.driverId) : null);
    const vehicleId = b.service === 'chauffeur' ? (input.vehicleId ?? (b.vehicleId ? String(b.vehicleId) : null)) : null;
    if (!driverId) throw badRequest('driver_required', 'Choose a driver.');
    if (b.service === 'chauffeur' && !vehicleId) throw badRequest('vehicle_required', 'Choose a vehicle.');
    await lockResources([`driver:${driverId}`, ...(vehicleId ? [`vehicle:${vehicleId}`] : [])], session);
    const dp = await assertDriverFree(driverId, b.startAt, b.endAt, cfg.schedulingBufferMinutes, String(b._id), session);
    if (dp.length) throw new AppError(409, 'driver_unavailable', 'This driver cannot take this booking.', dp);
    let ownerUserId: string | null = null;
    if (vehicleId) {
      const v = await assertVehicleFree(vehicleId, b.startAt, b.endAt, cfg.schedulingBufferMinutes, b.passengers, String(b._id), session);
      if (v.reasons.length) throw new AppError(409, 'vehicle_unavailable', 'This vehicle cannot take this booking.', v.reasons);
      ownerUserId = v.ownerUserId;
    }
    const driverChanged = String(b.driverId) !== driverId;
    const vehicleChanged = String(b.vehicleId ?? '') !== String(vehicleId ?? '');
    if (!driverChanged && !vehicleChanged) throw badRequest('no_change', 'Choose a different driver or vehicle.');
    const previous = { driverId: b.driverId ? String(b.driverId) : null, vehicleId: b.vehicleId ? String(b.vehicleId) : null };
    if (driverChanged && b.status === 'assigned' && b.driverId) {
      const old = String(b.driverId);
      after.push(() => notifyUser(old, 'trip.cancelled_partner', { ref: b.ref, when: fmtWhen(b.startAt) }));
    }
    b.driverId = driverId as unknown as Types.ObjectId;
    b.vehicleId = vehicleId as unknown as Types.ObjectId;
    b.vehicleOwnerId = ownerUserId as unknown as Types.ObjectId;
    if (driverChanged) {
      b.set('acceptance.driverAcceptedAt', null);
      // A new driver starts with a clean tracking state: never show the previous driver's position.
      b.set('tracking.lastPoint', { lat: null, lng: null, accuracyM: null, recordedAt: null, receivedAt: null });
      b.set('tracking.estimate', { to: null, distanceM: null, durationS: null, kind: null, computedAt: null });
      b.set('tracking.approachingNotifiedAt', null);
    }
    if (vehicleChanged) b.set('acceptance.vehicleAcceptedAt', null);
    b.set('attention.needsReassignment', false);
    b.set('attention.reason', null);
    b.set('attention.acceptanceTimeoutAt', null);
    if (b.status === 'assigned') {
      // Back to waiting for the new partner's acceptance.
      b.status = 'paid';
      b.statusHistory.push({ from: 'assigned', to: 'paid', at: new Date(), actorType: 'staff', by: staff.id as unknown as Types.ObjectId, reason: 'Reassigned' });
      b.tripPinEnc = null;
    }
    if (b.status === 'paid') b.set('acceptance.deadline', acceptanceDeadline(new Date(), b.startAt, cfg));
    await b.save({ session });
    if (driverChanged) await reallocateEarning(String(b._id), 'driver', driverId, { id: staff.id }, session);
    if (vehicleChanged) await reallocateEarning(String(b._id), 'vehicle_owner', ownerUserId, { id: staff.id }, session);
    await recordAudit(
      { actor: { type: 'user', id: staff.id!, roles: staff.roles ?? [] }, action: 'booking.reassigned', targetType: 'booking', targetId: b.id, before: previous, after: { driverId, vehicleId } },
      session,
    );
    if (b.status === 'paid') after.push(...offerNotifications(b));
    return b;
  });
  await runAfter(after);
  return b;
}

// ---------------------------------------------------------------------------
// Trip: PIN start, end
// ---------------------------------------------------------------------------

export async function startTrip(bookingId: string, driverId: string, pin: string) {
  const cfg = (await requireConfig()).values;
  let lockedNow = false;
  const after: AfterCommit = [];
  const result = await withTransaction(async (session) => {
    after.length = 0; // the driver may retry this callback
    const b = await loadBooking(bookingId, session);
    if (String(b.driverId) !== driverId) throw notFound('Trip not found.');
    if (b.status !== 'assigned') throw conflict('not_startable', 'This trip cannot be started.');
    const now = Date.now();
    if (now < b.startAt.getTime() - cfg.tripStartWindowHours * HOUR || now > b.endAt.getTime()) {
      throw conflict('outside_start_window', `A trip can be started from ${cfg.tripStartWindowHours} hours before pickup.`);
    }
    if (b.pinLocked) throw new AppError(423, 'pin_locked', 'Too many wrong PINs. Operations have been alerted and will help you.');
    const expected = b.tripPinEnc ? decryptSecret(b.tripPinEnc) : null;
    if (!expected || !safeEqual(pin, expected)) {
      b.pinFailedAttempts += 1;
      if (b.pinFailedAttempts >= cfg.maxPinAttempts) {
        b.pinLocked = true;
        lockedNow = true;
      }
      await b.save({ session });
      return { ok: false as const, b };
    }
    b.startedAt = new Date();
    await moveTo(b, 'in_progress', { type: 'driver', id: driverId, roles: ['driver_partner'] }, null, session);
    await onTripStarted(String(b._id), session);
    after.push(() => notifyUser(String(b.customerId), 'trip.started', { ref: b.ref }, { link: `/bookings/${b._id}` }));
    return { ok: true as const, b };
  });
  if (!result.ok) {
    if (lockedNow) {
      await alertOps({ type: 'pin_locked', bookingId: result.b._id, bookingRef: result.b.ref, message: `${result.b.ref}: trip PIN entered wrongly ${cfg.maxPinAttempts} times. Call the driver and customer.`, severity: 'high' });
      throw new AppError(423, 'pin_locked', 'Too many wrong PINs. Operations have been alerted and will help you.');
    }
    throw new AppError(400, 'wrong_pin', `That PIN is not correct. Ask the customer for their 4-digit trip PIN.`);
  }
  await runAfter(after);
  return result.b;
}

export async function completeTrip(bookingId: string, actor: Actor, reason: string | null = null) {
  const after: AfterCommit = [];
  const b = await withTransaction(async (session) => {
    after.length = 0; // the driver may retry this callback
    const b = await loadBooking(bookingId, session);
    if (actor.type === 'driver' && String(b.driverId) !== actor.id) throw notFound('Trip not found.');
    if (b.status !== 'in_progress') throw conflict('not_in_progress', 'Only a trip in progress can be ended.');
    b.endedAt = new Date();
    await moveTo(b, 'completed', actor, reason, session);
    await onTripCompleted(String(b._id), b.endedAt, session);
    await closeTracking(String(b._id), b.endedAt, session);
    after.push(async () => announceClosed(String(b._id)));
    after.push(() => notifyUser(String(b.customerId), 'trip.completed', { ref: b.ref }, { link: `/bookings/${b._id}` }));
    return b;
  });
  await runAfter(after);
  return b;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export async function cancelBooking(bookingId: string, actor: Actor, reason: string | null, refundMode: 'policy' | 'full' = 'policy') {
  const after: AfterCommit = [];
  const b = await withTransaction(async (session) => {
    after.length = 0; // the driver may retry this callback
    const b = await loadBooking(bookingId, session);
    if (actor.type === 'customer' && String(b.customerId) !== actor.id) throw notFound('Booking not found.');
    if (actor.type === 'customer' && refundMode !== 'policy') throw forbidden();
    const wasPaid = b.status === 'paid' || b.status === 'assigned';
    const refund = wasPaid
      ? refundMode === 'full'
        ? { hoursBeforePickup: policyRefund(b, new Date()).hoursBeforePickup, refundBps: 10_000, refundDueRwf: b.quote!.amountRwf }
        : policyRefund(b, new Date())
      : { hoursBeforePickup: null, refundBps: null, refundDueRwf: null };
    b.cancellation = { at: new Date(), by: actor.id as unknown as Types.ObjectId, actorType: actor.type, reason, ...refund } as never;
    const partners = [b.driverId, b.vehicleOwnerId].filter(Boolean).map(String);
    await moveTo(b, 'cancelled', actor, reason, session);
    if (wasPaid) await onPaidBookingCancelled(String(b._id), refund.refundDueRwf ?? 0, { id: actor.id }, actor.roles ?? [actor.type], session);
    await closeTracking(String(b._id), new Date(), session);
    after.push(async () => announceClosed(String(b._id)));
    after.push(() =>
      notifyUser(String(b.customerId), 'booking.cancelled', {
        ref: b.ref,
        refund: refund.refundDueRwf ? ` A refund of ${refund.refundDueRwf.toLocaleString('en-US')} RWF is due under the cancellation policy.` : '',
      }, { link: `/bookings/${b._id}` }),
    );
    if (wasPaid) for (const p of partners) after.push(() => notifyUser(p, 'trip.cancelled_partner', { ref: b.ref, when: fmtWhen(b.startAt) }));
    return b;
  });
  await runAfter(after);
  return b;
}

// ---------------------------------------------------------------------------
// Background checks (jobs)
// ---------------------------------------------------------------------------

/** Quotes not paid by their deadline expire. */
export async function expireQuotes(now = new Date()): Promise<number> {
  const due = await BookingModel.find({ status: 'quoted', 'quote.validUntil': { $lte: now } }, { _id: 1 }).lean();
  let n = 0;
  for (const { _id } of due) {
    const b = await withTransaction(async (session) => {
      const b = await loadBooking(String(_id), session);
      if (b.status !== 'quoted' || !b.quote || b.quote.validUntil > now) return null;
      await moveTo(b, 'expired', { type: 'system', id: null }, 'Quote not paid in time', session);
      return b;
    });
    if (b) {
      n++;
      await notifyUser(String(b.customerId), 'booking.expired', { ref: b.ref }, { link: `/bookings/${b._id}` });
    }
  }
  return n;
}

/** Partners who did not accept in time: operations are alerted to reassign (once per offer). */
export async function acceptanceTimeouts(now = new Date()): Promise<number> {
  const due = await BookingModel.find({ status: 'paid', 'acceptance.deadline': { $lte: now }, 'attention.acceptanceTimeoutAt': null }).lean();
  let n = 0;
  for (const b of due) {
    const res = await BookingModel.updateOne(
      { _id: b._id, status: 'paid', 'attention.acceptanceTimeoutAt': null },
      { $set: { 'attention.acceptanceTimeoutAt': now, 'attention.needsReassignment': true, 'attention.reason': 'Not accepted in time' } },
    );
    if (!res.modifiedCount) continue;
    n++;
    const who = [!b.acceptance?.driverAcceptedAt && 'driver', b.service === 'chauffeur' && !b.acceptance?.vehicleAcceptedAt && 'vehicle owner'].filter(Boolean).join(' and ');
    await alertOps({ type: 'acceptance_timeout', bookingId: b._id, bookingRef: b.ref, message: `${b.ref}: the ${who} did not accept in time. Reassign before ${fmtWhen(b.startAt)}.` });
  }
  return n;
}

/** Trips not started N minutes after pickup: operations are alerted (once). */
export async function notStartedAlerts(now = new Date()): Promise<number> {
  const cfg = (await requireConfig()).values;
  const cutoff = new Date(now.getTime() - cfg.tripNotStartedAlertMinutes * 60_000);
  const due = await BookingModel.find({ status: 'assigned', startAt: { $lte: cutoff }, 'attention.notStartedAlertAt': null }).lean();
  let n = 0;
  for (const b of due) {
    const res = await BookingModel.updateOne({ _id: b._id, status: 'assigned', 'attention.notStartedAlertAt': null }, { $set: { 'attention.notStartedAlertAt': now } });
    if (!res.modifiedCount) continue;
    n++;
    await alertOps({
      type: 'trip_not_started',
      bookingId: b._id,
      bookingRef: b.ref,
      message: `${b.ref}: trip not started ${cfg.tripNotStartedAlertMinutes} minutes after pickup time. Call the driver and customer.`,
      severity: 'high',
    });
  }
  return n;
}

/**
 * Spec: suspending a partner removes them from future unconfirmed bookings. Quoted
 * and paid bookings lose the partner and are flagged for reassignment; assigned
 * bookings keep them but operations are alerted to decide.
 */
export async function releaseSuspendedPartner(kind: 'driver' | 'vehicle', id: string): Promise<number> {
  const field = kind === 'driver' ? 'driverId' : 'vehicleId';
  const affected = await BookingModel.find({ [field]: id, status: { $in: ['quoted', 'paid', 'assigned'] } }).lean();
  for (const b of affected) {
    if (b.status === 'assigned') {
      await alertOps({ type: 'partner_suspended', bookingId: b._id, bookingRef: b.ref, message: `${b.ref}: the ${kind} on this confirmed trip was suspended. Decide whether to reassign.`, severity: 'high' });
      continue;
    }
    const unset = kind === 'driver' ? { driverId: null, 'acceptance.driverAcceptedAt': null } : { vehicleId: null, vehicleOwnerId: null, 'acceptance.vehicleAcceptedAt': null };
    await withTransaction(async (session) => {
      await BookingModel.updateOne({ _id: b._id }, { $set: { ...unset, 'attention.needsReassignment': true, 'attention.reason': `${kind === 'driver' ? 'Driver' : 'Vehicle'} suspended` } }, { session });
      await reallocateEarning(String(b._id), kind === 'driver' ? 'driver' : 'vehicle_owner', null, { id: null, system: 'suspension' }, session);
    });
    await recordAudit({ actor: { type: 'system', name: 'suspension' }, action: `booking.${kind}_removed_suspended`, targetType: 'booking', targetId: String(b._id) });
    await alertOps({ type: 'partner_suspended', bookingId: b._id, bookingRef: b.ref, message: `${b.ref}: the ${kind} was suspended and removed. Reassign.` });
  }
  return affected.length;
}

