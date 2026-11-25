import { EventEmitter } from 'node:events';
import type { ClientSession } from 'mongoose';
import { BookingModel, type BookingDoc } from '../bookings/booking.model.js';
import { OpsAlertModel } from '../bookings/alerts.js';
import { UserModel } from '../users/user.model.js';
import { requireConfig } from '../platformConfig/platformConfig.service.js';
import type { PlatformConfigValues } from '../platformConfig/platformConfig.schema.js';
import { notifyUser } from '../notifications/notification.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { mapsProvider } from '../maps/maps.provider.js';
import { distanceMeters, hasCoords } from '../../lib/geo.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { LocationPointModel, TrackingAccessModel } from './tracking.models.js';
import type { AuthContext } from '../../middleware/auth.js';

/**
 * Live tracking (spec section 6). Every read and write checks the caller's role and
 * membership of the booking. Nothing here is reachable without authentication, and
 * nothing is collected in the background: points arrive only while the driver has
 * the trip page open and has chosen to share.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ETA_REFRESH_MS = 60_000;
const STAFF_AUDIT_EVERY_MS = 60_000;
const GRANT_MAX_MS = 12 * HOUR;

/** In-process fan-out to WebSocket subscribers. One API instance; use Redis pub/sub to scale out. */
export const trackingBus = new EventEmitter();
trackingBus.setMaxListeners(0);
export type BusEvent = { bookingId: string; kind: 'point' | 'closed' };
const publish = (e: BusEvent) => trackingBus.emit('event', e);

export type WindowState = 'not_yet' | 'open' | 'closed';

/** Driver sharing and customer viewing: from `trackingWindowBeforePickupMinutes` before pickup (once assigned) until the trip ends. */
export function trackingWindow(b: BookingDoc, cfg: PlatformConfigValues, now = new Date()): { state: WindowState; opensAt: Date | null } {
  const opensAt = new Date(b.startAt.getTime() - cfg.trackingWindowBeforePickupMinutes * MIN);
  if (b.status === 'in_progress') return { state: 'open', opensAt };
  if (b.status === 'assigned') return { state: now >= opensAt ? 'open' : 'not_yet', opensAt };
  if (b.status === 'paid') return { state: 'not_yet', opensAt };
  return { state: 'closed', opensAt: null };
}

/** Vehicle owners: only multi-day hires (Super Admin threshold), only their own vehicle, only while the trip is in progress. */
export function ownerMayTrack(b: BookingDoc, cfg: PlatformConfigValues): { allowed: boolean; reason: string | null } {
  const min = cfg.vehiclePartnerLiveTrackingMinHours;
  if (min === null) return { allowed: false, reason: 'not_enabled' };
  if (b.endAt.getTime() - b.startAt.getTime() < min * HOUR) return { allowed: false, reason: 'too_short' };
  if (b.status !== 'in_progress') return { allowed: false, reason: 'not_in_progress' };
  return { allowed: true, reason: null };
}

/** Whether staff may open emergency access now, and on what basis. */
export async function emergencyBasis(b: BookingDoc): Promise<'safety_report' | 'trip_not_started' | null> {
  if (b.hasOpenSafetyReport) return 'safety_report';
  if (b.status === 'assigned' && (await OpsAlertModel.exists({ bookingId: b._id, type: 'trip_not_started', resolvedAt: null }))) return 'trip_not_started';
  return null;
}

function provisionalPurgeAt(b: BookingDoc, cfg: PlatformConfigValues, now: Date): Date | null {
  if (b.hasOpenSafetyReport) return null;
  const end = Math.max(now.getTime(), (b.endedAt ?? b.endAt).getTime());
  return new Date(end + cfg.locationRetentionDays * DAY);
}

// ---------------------------------------------------------------------------
// Driver: send a point
// ---------------------------------------------------------------------------

export interface PointInput {
  lat: number;
  lng: number;
  accuracyM: number;
  recordedAt: Date;
  headingDeg?: number | null;
  speedMps?: number | null;
  source?: 'driver_web' | 'driver_app';
}

export async function recordPoint(bookingId: string, driverId: string, p: PointInput, now = new Date()) {
  const b = await BookingModel.findById(bookingId);
  if (!b || String(b.driverId) !== driverId) throw notFound('Trip not found.');
  const cfg = (await requireConfig()).values;
  const w = trackingWindow(b, cfg, now);
  if (w.state === 'closed') throw conflict('tracking_closed', 'Location sharing has ended for this trip.');
  if (w.state === 'not_yet') throw conflict('tracking_not_open', `Location sharing opens ${cfg.trackingWindowBeforePickupMinutes} minutes before pickup.`);
  if (p.recordedAt.getTime() > now.getTime() + MIN) throw conflict('bad_timestamp', 'The location time is in the future.');
  if (p.recordedAt.getTime() < now.getTime() - 10 * MIN) throw conflict('stale_point', 'This location is too old to share.');

  // One point per half interval at most: extra points are acknowledged, not stored.
  const last = b.tracking?.lastPoint?.receivedAt;
  const minGap = (cfg.locationUpdateIntervalSeconds * 1000) / 2;
  if (last && now.getTime() - last.getTime() < minGap) return { accepted: false as const, reason: 'too_soon', nextInSeconds: cfg.locationUpdateIntervalSeconds };

  await LocationPointModel.create({
    bookingId: b._id,
    userId: driverId,
    source: p.source ?? 'driver_web',
    lat: p.lat,
    lng: p.lng,
    accuracyM: Math.round(p.accuracyM),
    headingDeg: p.headingDeg ?? null,
    speedMps: p.speedMps ?? null,
    recordedAt: p.recordedAt,
    receivedAt: now,
    purgeAt: provisionalPurgeAt(b, cfg, now),
  });
  await BookingModel.updateOne(
    { _id: b._id },
    { $set: { 'tracking.lastPoint': { lat: p.lat, lng: p.lng, accuracyM: Math.round(p.accuracyM), recordedAt: p.recordedAt, receivedAt: now } } },
  );

  // "Driver approaching": once per trip, before the start, within the configured radius of pickup.
  if (b.status === 'assigned' && hasCoords(b.pickup) && distanceMeters(p, b.pickup) <= cfg.driverApproachingMeters) {
    const claimed = await BookingModel.updateOne({ _id: b._id, 'tracking.approachingNotifiedAt': null }, { $set: { 'tracking.approachingNotifiedAt': now } });
    if (claimed.modifiedCount) {
      const driver = await UserModel.findById(driverId).select('firstName').lean();
      await notifyUser(String(b.customerId), 'trip.approaching', { ref: b.ref, driverName: driver?.firstName ?? 'Your driver', distance: cfg.driverApproachingMeters >= 1000 ? `${cfg.driverApproachingMeters / 1000} km` : `${cfg.driverApproachingMeters} m` }, { link: `/bookings/${b._id}`, dedupeKey: `trip.approaching/${b._id}/${b.driverId}` });
    }
  }
  publish({ bookingId: String(b._id), kind: 'point' });
  return { accepted: true as const, reason: null, nextInSeconds: cfg.locationUpdateIntervalSeconds };
}

// ---------------------------------------------------------------------------
// Lifecycle hooks (called inside the booking transactions)
// ---------------------------------------------------------------------------

/** Trip ended or cancelled: sharing stops and the retention clock starts from the end. */
export async function closeTracking(bookingId: string, endedAt: Date, session: ClientSession) {
  const b = await BookingModel.findById(bookingId, null, { session });
  if (!b) return;
  const cfg = (await requireConfig(session)).values;
  await BookingModel.updateOne({ _id: b._id }, { $set: { 'tracking.closedAt': endedAt } }, { session });
  if (!b.hasOpenSafetyReport) {
    await LocationPointModel.updateMany({ bookingId: b._id }, { $set: { purgeAt: new Date(endedAt.getTime() + cfg.locationRetentionDays * DAY) } }, { session });
  }
}

/** Safety report opened: keep every point until the report is closed. */
export async function holdLocationPoints(bookingId: string, session: ClientSession) {
  await LocationPointModel.updateMany({ bookingId }, { $set: { purgeAt: null } }, { session });
}

/** Last open report closed: back on the normal schedule (deleted at once if that date has passed). */
export async function releaseLocationHold(bookingId: string, session: ClientSession, now = new Date()) {
  const b = await BookingModel.findById(bookingId, null, { session }).lean();
  if (!b) return;
  const cfg = (await requireConfig(session)).values;
  const end = (b.endedAt ?? b.cancellation?.at ?? b.endAt).getTime();
  const purgeAt = new Date(Math.max(now.getTime(), end + cfg.locationRetentionDays * DAY));
  await LocationPointModel.updateMany({ bookingId }, { $set: { purgeAt } }, { session });
}

/** Called after a booking transaction commits, so WebSocket viewers see the end immediately. */
export const announceClosed = (bookingId: string) => publish({ bookingId, kind: 'closed' });

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function estimateFor(b: BookingDoc, now: Date) {
  const last = b.tracking?.lastPoint;
  if (!hasCoords(last)) return null;
  const to = b.status === 'in_progress' ? 'dropoff' : 'pickup';
  const target = to === 'pickup' ? b.pickup : b.dropoff;
  if (!hasCoords(target)) return null;
  const cached = b.tracking?.estimate;
  // Billed provider routes are cached for a minute; the free straight-line distance is always current.
  const cacheable = mapsProvider().name !== 'dev';
  const fresh = cacheable && cached?.computedAt && cached.to === to && now.getTime() - cached.computedAt.getTime() < ETA_REFRESH_MS;
  if (fresh) return { to, distanceM: cached!.distanceM!, durationS: cached!.durationS ?? null, kind: cached!.kind!, computedAt: cached!.computedAt! };
  // Route/ETA at most once a minute per trip, not on every location update (cost control).
  const r = await mapsProvider().route(last, target);
  const estimate = { to, distanceM: r.distanceM, durationS: r.durationS, kind: r.kind, computedAt: now };
  await BookingModel.updateOne({ _id: b._id }, { $set: { 'tracking.estimate': estimate } });
  return estimate;
}

const pointView = (b: BookingDoc) => {
  const p = b.tracking?.lastPoint;
  return hasCoords(p) && p.recordedAt ? { lat: p.lat, lng: p.lng, accuracyM: p.accuracyM ?? null, recordedAt: p.recordedAt, receivedAt: p.receivedAt ?? null } : null;
};
const placeView = (pl: BookingDoc['pickup'] | null | undefined) => (pl ? { address: pl.address, lat: pl.lat ?? null, lng: pl.lng ?? null } : null);

export type TrackingViewer = 'customer' | 'driver' | 'owner' | 'staff';

/** The tracking view for one caller, or an error if they may not see it. */
export async function trackingView(bookingId: string, auth: AuthContext, as: TrackingViewer, now = new Date()) {
  const b = await BookingModel.findById(bookingId);
  if (!b) throw notFound('Booking not found.');
  const me = auth.user.id;
  const cfg = (await requireConfig()).values;
  const base = { bookingId: String(b._id), status: b.status, updateIntervalSeconds: cfg.locationUpdateIntervalSeconds, provider: mapsProvider().name };

  if (as === 'customer') {
    if (String(b.customerId) !== me || auth.sessionKind !== 'user') throw notFound('Booking not found.');
    const w = trackingWindow(b, cfg, now);
    if (w.state !== 'open') return { ...base, state: w.state, opensAt: w.opensAt, driverLocation: null, pickup: placeView(b.pickup), dropoff: placeView(b.dropoff), estimate: null };
    return { ...base, state: w.state, opensAt: w.opensAt, driverLocation: pointView(b), pickup: placeView(b.pickup), dropoff: placeView(b.dropoff), estimate: await estimateFor(b, now) };
  }
  if (as === 'driver') {
    if (String(b.driverId) !== me || !auth.user.roles.includes('driver_partner')) throw notFound('Trip not found.');
    const w = trackingWindow(b, cfg, now);
    return { ...base, state: w.state, opensAt: w.opensAt, driverLocation: pointView(b), pickup: placeView(b.pickup), dropoff: placeView(b.dropoff), estimate: w.state === 'open' ? await estimateFor(b, now) : null };
  }
  if (as === 'owner') {
    if (String(b.vehicleOwnerId) !== me || !auth.user.roles.includes('vehicle_partner')) throw notFound('Trip not found.');
    const o = ownerMayTrack(b, cfg);
    // No customer addresses for vehicle owners: the vehicle's position only.
    return { ...base, state: o.allowed ? ('open' as const) : ('closed' as const), reason: o.reason, opensAt: null, driverLocation: o.allowed ? pointView(b) : null, pickup: null, dropoff: null, estimate: null };
  }
  throw forbidden();
}

// ---------------------------------------------------------------------------
// Staff break-glass
// ---------------------------------------------------------------------------

async function liveGrant(bookingId: string, staffId: string, now: Date) {
  return TrackingAccessModel.findOne({ bookingId, staffId, expiresAt: { $gt: now } }).sort({ expiresAt: -1 });
}

export async function openEmergencyAccess(bookingId: string, staff: { id: string; roles: string[] }, reason: string, ctx: { ip: string | null; userAgent: string | null; requestId: string | null }, now = new Date()) {
  const b = await BookingModel.findById(bookingId);
  if (!b) throw notFound('Booking not found.');
  const basis = await emergencyBasis(b);
  if (!basis) throw conflict('no_emergency', 'Location can only be opened while this booking has an open safety report or a trip-not-started alert.');
  const grant = await TrackingAccessModel.create({ bookingId: b._id, staffId: staff.id, reason, basis, expiresAt: new Date(now.getTime() + GRANT_MAX_MS), lastAuditedAt: now });
  await recordAudit({ actor: { type: 'user', id: staff.id, roles: staff.roles }, action: 'tracking.emergency_opened', targetType: 'booking', targetId: String(b._id), after: { basis, grantId: String(grant._id) }, reason, ...ctx });
  return grant;
}

/** Staff view. Without a live grant (or once the emergency is over) it shows only whether access can be opened. */
export async function staffTrackingView(bookingId: string, staff: { id: string; roles: string[] }, ctx: { ip: string | null; userAgent: string | null; requestId: string | null }, now = new Date()) {
  const b = await BookingModel.findById(bookingId);
  if (!b) throw notFound('Booking not found.');
  const basis = await emergencyBasis(b);
  const grant = await liveGrant(bookingId, staff.id, now);
  if (!basis || !grant) {
    if (grant && !basis) await TrackingAccessModel.updateOne({ _id: grant._id }, { $set: { expiresAt: now } }); // emergency over: access ends
    return { eligible: Boolean(basis), basis, access: null };
  }
  // Every access is logged. A view refreshing on screen counts as one access per minute.
  if (!grant.lastAuditedAt || now.getTime() - grant.lastAuditedAt.getTime() >= STAFF_AUDIT_EVERY_MS) {
    await recordAudit({ actor: { type: 'user', id: staff.id, roles: staff.roles }, action: 'tracking.emergency_viewed', targetType: 'booking', targetId: String(b._id), after: { basis, grantId: String(grant._id) }, reason: grant.reason, ...ctx });
    await TrackingAccessModel.updateOne({ _id: grant._id }, { $set: { lastAuditedAt: now } });
  }
  const trail = await LocationPointModel.find({ bookingId: b._id }).sort({ recordedAt: -1 }).limit(30).lean();
  return {
    eligible: true,
    basis,
    access: {
      reason: grant.reason,
      expiresAt: grant.expiresAt,
      status: b.status,
      driverLocation: pointView(b),
      pickup: placeView(b.pickup),
      dropoff: placeView(b.dropoff),
      trail: trail.map((p) => ({ lat: p.lat, lng: p.lng, accuracyM: p.accuracyM, recordedAt: p.recordedAt })),
    },
  };
}
