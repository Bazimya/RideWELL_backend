import { Schema, model, type ClientSession, type Types } from 'mongoose';
import { BookingModel, HOLDING_STATUSES } from './booking.model.js';
import { DriverProfileModel, OwnerProfileModel, VehicleModel } from '../partners/partner.models.js';
import { driverEligibility, vehicleEligibility } from '../partners/requirements.js';
import { UserModel } from '../users/user.model.js';

/**
 * One tiny document per driver and per vehicle. Every assignment transaction
 * writes to the locks of the resources it uses before checking for overlaps, so
 * two concurrent assignments of the same driver conflict at the database and one
 * of them is retried, sees the other's booking, and is refused. This is what makes
 * double-booking impossible even with two admins clicking at the same moment.
 */
const resourceLockSchema = new Schema({ _id: String, v: { type: Number, default: 0 } }, { versionKey: false });
export const ResourceLockModel = model('ResourceLock', resourceLockSchema, 'resourceLocks');

export async function lockResources(keys: string[], session: ClientSession): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await ResourceLockModel.updateOne({ _id: key }, { $inc: { v: 1 } }, { upsert: true, session });
  }
}

export interface Conflict {
  bookingId: string;
  ref: string;
  startAt: Date;
  endAt: Date;
  status: string;
}

/**
 * Bookings that hold `field` (driverId / vehicleId) during [startAt − buffer,
 * endAt + buffer). A quote that has passed its validity no longer holds anything.
 */
export async function findConflicts(
  field: 'driverId' | 'vehicleId',
  id: Types.ObjectId | string,
  startAt: Date,
  endAt: Date,
  bufferMinutes: number,
  excludeBookingId: Types.ObjectId | string | null,
  session?: ClientSession,
): Promise<Conflict[]> {
  const buf = bufferMinutes * 60_000;
  const rows = await BookingModel.find(
    {
      [field]: id,
      ...(excludeBookingId ? { _id: { $ne: excludeBookingId } } : {}),
      status: { $in: HOLDING_STATUSES },
      startAt: { $lt: new Date(endAt.getTime() + buf) },
      endAt: { $gt: new Date(startAt.getTime() - buf) },
      $or: [{ status: { $ne: 'quoted' } }, { 'quote.validUntil': { $gt: new Date() } }],
    },
    { ref: 1, startAt: 1, endAt: 1, status: 1 },
    session ? { session } : {},
  ).lean();
  return rows.map((r) => ({ bookingId: String(r._id), ref: r.ref, startAt: r.startAt, endAt: r.endAt, status: r.status }));
}

const overlapsPeriod = (periods: Array<{ from: Date; to: Date }> | undefined, startAt: Date, endAt: Date) =>
  (periods ?? []).some((p) => p.from < endAt && p.to > startAt);

export interface Candidate {
  id: string;
  label: string;
  detail: string;
  available: boolean;
  reasons: string[];
  conflicts: Conflict[];
}

/** Every approved driver, with whether they can take [startAt, endAt] and why not. */
export async function driverCandidates(startAt: Date, endAt: Date, bufferMinutes: number, excludeBookingId: string | null): Promise<Candidate[]> {
  const profiles = await DriverProfileModel.find({ status: 'approved' }).lean();
  const users = await UserModel.find({ _id: { $in: profiles.map((p) => p.userId) } }).select('firstName lastName phone').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const out: Candidate[] = [];
  for (const p of profiles) {
    const userId = String(p.userId);
    const u = byId.get(userId);
    const elig = await driverEligibility(userId, endAt);
    const reasons = [...elig.reasons];
    if (overlapsPeriod(p.availability?.unavailable as Array<{ from: Date; to: Date }>, startAt, endAt)) reasons.push('marked_unavailable');
    const conflicts = await findConflicts('driverId', userId, startAt, endAt, bufferMinutes, excludeBookingId);
    if (conflicts.length) reasons.push('booked_at_this_time');
    out.push({
      id: userId,
      label: [u?.firstName, u?.lastName].filter(Boolean).join(' ') || 'Driver',
      detail: `${p.experienceYears ?? '?'} yrs · ${(p.languages ?? []).join(', ')}`,
      available: reasons.length === 0,
      reasons,
      conflicts,
    });
  }
  return out.sort((a, b) => Number(b.available) - Number(a.available) || a.label.localeCompare(b.label));
}

/** Every approved vehicle, with whether it can take [startAt, endAt] for `passengers` and why not. */
export async function vehicleCandidates(startAt: Date, endAt: Date, bufferMinutes: number, passengers: number, excludeBookingId: string | null): Promise<Candidate[]> {
  const vehicles = await VehicleModel.find({ status: 'approved' }).lean();
  const owners = await OwnerProfileModel.find({ _id: { $in: vehicles.map((v) => v.ownerProfileId) } }).select('companyName').lean();
  const ownerName = new Map(owners.map((o) => [String(o._id), o.companyName]));
  const out: Candidate[] = [];
  for (const v of vehicles) {
    const elig = await vehicleEligibility(String(v._id), endAt);
    const reasons = [...elig.reasons];
    if (v.seats < passengers) reasons.push('not_enough_seats');
    if (overlapsPeriod(v.availability?.unavailable as Array<{ from: Date; to: Date }>, startAt, endAt)) reasons.push('marked_unavailable');
    const conflicts = await findConflicts('vehicleId', v._id, startAt, endAt, bufferMinutes, excludeBookingId);
    if (conflicts.length) reasons.push('booked_at_this_time');
    out.push({
      id: String(v._id),
      label: `${v.make} ${v.model} · ${v.plate}`,
      detail: `${v.category} · ${v.seats} seats · ${v.colour}${ownerName.get(String(v.ownerProfileId)) ? ` · ${ownerName.get(String(v.ownerProfileId))}` : ''}`,
      available: reasons.length === 0,
      reasons,
      conflicts,
    });
  }
  return out.sort((a, b) => Number(b.available) - Number(a.available) || a.label.localeCompare(b.label));
}

/** Throw unless this driver can take the slot (checked inside the assignment transaction). */
export async function assertDriverFree(driverId: string, startAt: Date, endAt: Date, bufferMinutes: number, bookingId: string, session: ClientSession) {
  const elig = await driverEligibility(driverId, endAt);
  const profile = await DriverProfileModel.findOne({ userId: driverId }, null, { session }).lean();
  const reasons = [...elig.reasons];
  if (overlapsPeriod(profile?.availability?.unavailable as Array<{ from: Date; to: Date }>, startAt, endAt)) reasons.push('marked_unavailable');
  const conflicts = await findConflicts('driverId', driverId, startAt, endAt, bufferMinutes, bookingId, session);
  if (conflicts.length) reasons.push(`booked_at_this_time (${conflicts.map((c) => c.ref).join(', ')})`);
  return reasons;
}

export async function assertVehicleFree(vehicleId: string, startAt: Date, endAt: Date, bufferMinutes: number, passengers: number, bookingId: string, session: ClientSession) {
  const elig = await vehicleEligibility(vehicleId, endAt);
  const vehicle = await VehicleModel.findById(vehicleId, null, { session }).lean();
  const reasons = [...elig.reasons];
  if (vehicle && vehicle.seats < passengers) reasons.push('not_enough_seats');
  if (overlapsPeriod(vehicle?.availability?.unavailable as Array<{ from: Date; to: Date }>, startAt, endAt)) reasons.push('marked_unavailable');
  const conflicts = await findConflicts('vehicleId', vehicleId, startAt, endAt, bufferMinutes, bookingId, session);
  if (conflicts.length) reasons.push(`booked_at_this_time (${conflicts.map((c) => c.ref).join(', ')})`);
  return { reasons, ownerUserId: vehicle ? String(vehicle.ownerUserId) : null };
}
