import { bookingRating, canRate } from './ratings.js';
import type { BookingDoc } from './booking.model.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel } from '../partners/partner.models.js';
import { DocumentModel } from '../documents/document.model.js';
import { PaymentModel } from '../payments/payment.model.js';
import { decryptSecret } from '../../lib/crypto.js';
import { policyRefund } from './booking.service.js';
import { RefundModel } from '../finance/finance.models.js';

/**
 * What each party may see about a booking (spec "Permissions matrix", "Data
 * protection"). Every view is built from scratch: no raw booking documents leave
 * the server.
 */

const HOUR = 3_600_000;
const CONTACT_HIDE_MS = 24 * HOUR;

function common(b: BookingDoc) {
  return {
    id: String(b._id),
    ref: b.ref,
    service: b.service,
    airport: b.airport?.direction ? { direction: b.airport.direction, flightNumber: b.airport.flightNumber ?? null } : null,
    startAt: b.startAt,
    endAt: b.endAt,
    passengers: b.passengers,
    status: b.status,
    startedAt: b.startedAt ?? null,
    endedAt: b.endedAt ?? null,
  };
}

const places = (b: BookingDoc) => ({
  pickup: { address: b.pickup.address, notes: b.pickup.notes ?? null, lat: b.pickup.lat ?? null, lng: b.pickup.lng ?? null },
  dropoff: b.dropoff ? { address: b.dropoff.address, notes: b.dropoff.notes ?? null, lat: b.dropoff.lat ?? null, lng: b.dropoff.lng ?? null } : null,
});

const history = (b: BookingDoc) => b.statusHistory.map((h) => ({ to: h.to, at: h.at, actorType: h.actorType, reason: h.reason ?? null }));

async function vehicleSummary(b: BookingDoc) {
  if (!b.vehicleId) return null;
  const v = await VehicleModel.findById(b.vehicleId).lean();
  return v ? { id: String(v._id), make: v.make, model: v.model, colour: v.colour, plate: v.plate, seats: v.seats, category: v.category } : null;
}

/** Free Google Maps navigation link: exact coordinates when known, otherwise the typed address. */
const navigationUrl = (p: { address: string; lat?: number | null; lng?: number | null }) =>
  `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(typeof p.lat === 'number' && typeof p.lng === 'number' ? `${p.lat},${p.lng}` : p.address)}`;

// ---------------------------------------------------------------------------

export async function customerView(b: BookingDoc) {
  const assignedLike = ['assigned', 'in_progress', 'completed'].includes(b.status);
  const driver = assignedLike && b.driverId ? await UserModel.findById(b.driverId).select('firstName').lean() : null;
  const hasPhoto = driver ? Boolean(await DocumentModel.exists({ ownerId: b.driverId, kind: 'profile_photo', status: 'approved' })) : false;
  const payment = await PaymentModel.findOne({ bookingId: b._id, status: 'successful' }).lean();
  const refunds = await RefundModel.find({ bookingId: b._id }).sort({ createdAt: 1 }).lean();
  const now = new Date();
  const rating = b.status === 'completed' ? await bookingRating(b._id) : null;
  const cancellable = ['requested', 'quoted', 'paid', 'assigned'].includes(b.status);
  const quoteValid = b.status === 'quoted' && b.quote && b.quote.validUntil > now;
  return {
    ...common(b),
    ...places(b),
    notes: b.notes ?? null,
    customerVehicle: b.service === 'driver_on_demand' ? b.customerVehicle : null,
    history: history(b),
    quote: b.quote ? { amountRwf: b.quote.amountRwf, validUntil: b.quote.validUntil, note: b.quote.note ?? null } : null,
    canPay: Boolean(quoteValid),
    payment: payment ? { amountRwf: payment.amountRwf, verifiedAt: payment.verifiedAt, isDevelopment: payment.isDevelopment } : null,
    driver: driver ? { firstName: driver.firstName ?? 'Driver', hasPhoto } : null,
    vehicle: assignedLike ? await vehicleSummary(b) : null,
    // The PIN is for pickup: shown until the trip starts.
    tripPin: b.status === 'assigned' && b.tripPinEnc ? decryptSecret(b.tripPinEnc) : null,
    cancellable,
    cancellationPreview: cancellable && (b.status === 'paid' || b.status === 'assigned') ? policyRefund(b, now) : null,
    cancellation: b.cancellation?.at ? { at: b.cancellation.at, reason: b.cancellation.reason ?? null, refundDueRwf: b.cancellation.refundDueRwf ?? null } : null,
    refunds: refunds.map((r) => ({ amountRwf: r.amountRwf, status: r.status === 'approved' ? 'requested' : r.status, completedAt: r.providerConfirmedAt ?? null, isDevelopment: r.isDevelopment })),
    canReportSafety: canReportSafety(b, now),
    hasOpenSafetyReport: Boolean(b.hasOpenSafetyReport),
    rating,
    canRate: !rating && canRate(b, now),
  };
}

export function canReportSafety(b: BookingDoc, now = new Date()) {
  if (b.status === 'assigned' || b.status === 'in_progress') return true;
  return b.status === 'completed' && Boolean(b.endedAt) && now.getTime() - b.endedAt!.getTime() < CONTACT_HIDE_MS;
}

/** The trip as a driver sees it. Customer phone only while assigned and paid, until the trip ends. */
export async function driverTripView(b: BookingDoc, driverId: string) {
  const offered = b.status === 'paid' && !b.acceptance?.driverAcceptedAt;
  const active = b.status === 'assigned' || b.status === 'in_progress';
  const customer = await UserModel.findById(b.customerId).select('firstName phone').lean();
  return {
    ...common(b),
    ...places(b),
    notes: b.notes ?? null,
    customerVehicle: b.service === 'driver_on_demand' ? b.customerVehicle : null,
    vehicle: await vehicleSummary(b),
    customer: { firstName: customer?.firstName ?? 'Customer', phone: active ? (customer?.phone ?? null) : null },
    offer: offered ? { deadline: b.acceptance?.deadline ?? null } : null,
    accepted: Boolean(b.acceptance?.driverAcceptedAt),
    waitingForVehicleOwner: b.service === 'chauffeur' && b.status === 'paid' && Boolean(b.acceptance?.driverAcceptedAt) && !b.acceptance?.vehicleAcceptedAt,
    navigation: active
      ? { pickup: navigationUrl(b.pickup), dropoff: b.dropoff ? navigationUrl(b.dropoff) : null }
      : null,
    pinLocked: Boolean(b.pinLocked),
    canReportSafety: canReportSafety(b),
    cancelled: b.status === 'cancelled' ? { at: b.cancellation?.at ?? null } : null,
    isMine: String(b.driverId) === driverId,
  };
}

/** The trip as the vehicle owner sees it: status and times for their own vehicle, no customer details. */
export async function ownerTripView(b: BookingDoc) {
  return {
    ...common(b),
    vehicle: await vehicleSummary(b),
    offer: b.status === 'paid' && !b.acceptance?.vehicleAcceptedAt ? { deadline: b.acceptance?.deadline ?? null } : null,
    accepted: Boolean(b.acceptance?.vehicleAcceptedAt),
  };
}

/** Everything, for staff with bookings.view. */
export async function staffView(b: BookingDoc) {
  const [customer, driver, payments] = await Promise.all([
    UserModel.findById(b.customerId).select('firstName lastName phone email').lean(),
    b.driverId ? UserModel.findById(b.driverId).select('firstName lastName phone').lean() : null,
    PaymentModel.find({ bookingId: b._id }).sort({ createdAt: -1 }).lean(),
  ]);
  return {
    ...common(b),
    ...places(b),
    notes: b.notes ?? null,
    channel: b.channel,
    customerVehicle: b.service === 'driver_on_demand' ? b.customerVehicle : null,
    customer: customer ? { id: String(customer._id), name: [customer.firstName, customer.lastName].filter(Boolean).join(' '), phone: customer.phone ?? null, email: customer.email ?? null } : null,
    driver: driver ? { id: String(driver._id), name: [driver.firstName, driver.lastName].filter(Boolean).join(' '), phone: driver.phone ?? null } : null,
    vehicle: await vehicleSummary(b),
    quote: b.quote ?? null,
    commissionSnapshot: b.commissionSnapshot ?? null,
    acceptance: b.acceptance ?? null,
    declines: b.declines,
    attention: b.attention,
    pinLocked: Boolean(b.pinLocked),
    pinFailedAttempts: b.pinFailedAttempts,
    cancellation: b.cancellation?.at ? b.cancellation : null,
    payments: payments.map((p) => ({ id: String(p._id), provider: p.provider, amountRwf: p.amountRwf, status: p.status, isDevelopment: p.isDevelopment, verifiedAt: p.verifiedAt, createdAt: p.createdAt })),
    history: b.statusHistory,
    hasOpenSafetyReport: Boolean(b.hasOpenSafetyReport),
    rating: await bookingRating(b._id),
  };
}

export function listRow(b: BookingDoc) {
  return {
    ...common(b),
    pickup: b.pickup.address,
    dropoff: b.dropoff?.address ?? null,
    quoteAmountRwf: b.quote?.amountRwf ?? null,
    needsAttention: Boolean(b.attention?.needsReassignment) || Boolean(b.pinLocked) || Boolean(b.hasOpenSafetyReport),
    attentionReason: b.attention?.reason ?? (b.pinLocked ? 'PIN locked' : b.hasOpenSafetyReport ? 'Safety report' : null),
  };
}
