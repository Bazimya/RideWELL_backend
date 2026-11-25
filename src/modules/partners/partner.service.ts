import type { ClientSession, Types } from 'mongoose';
import {
  DriverProfileModel,
  OwnerProfileModel,
  VehicleModel,
  normalisePlate,
  type DriverProfileDoc,
  type OwnerProfileDoc,
  type PartnerStatus,
  type VehicleDoc,
} from './partner.models.js';
import {
  allDone,
  docsFor,
  driverApprovalRequirements,
  driverEligibility,
  driverSubmissionRequirements,
  ownerApprovalRequirements,
  ownerSubmissionRequirements,
  vehicleApprovalRequirements,
  vehicleEligibility,
  vehicleSubmissionRequirements,
} from './requirements.js';
import { UserModel } from '../users/user.model.js';
import { hasAdminRole, type Role } from '../users/roles.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { notifyUser } from '../notifications/notification.service.js';
import { revokeAllSessions } from '../auth/token.service.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { listDocuments } from '../documents/document.service.js';
import { toDocumentView } from '../documents/document.model.js';

export type SubjectKind = 'driver' | 'owner' | 'vehicle';
type AnyPartnerDoc = DriverProfileDoc | OwnerProfileDoc | VehicleDoc;
type UserActor = AuditActor & { type: 'user' };

const EDITABLE: readonly PartnerStatus[] = ['draft', 'rejected'];
const ROLE_LABEL = { driver: 'driver partner', owner: 'vehicle partner' } as const;

function assertEditable(doc: { status: string }, what: string) {
  if (!EDITABLE.includes(doc.status as PartnerStatus)) {
    throw conflict('not_editable', `This ${what} is ${doc.status.replace('_', ' ')} and cannot be changed now. Contact RideWELL operations for changes.`);
  }
}

/** Every status change: history entry + audit entry, in the caller's transaction. */
async function transition(
  doc: AnyPartnerDoc,
  kind: SubjectKind,
  to: PartnerStatus,
  actor: AuditActor,
  reason: string | null,
  session: ClientSession | null,
) {
  const from = doc.status as PartnerStatus;
  const at = new Date();
  doc.status = to;
  doc.statusHistory.push({ from, to, at, by: actor.type === 'user' ? (actor.id as unknown as Types.ObjectId) : null, reason });
  if (to === 'applied') doc.submittedAt = at;
  if (to === 'approved' || to === 'rejected') {
    doc.decidedAt = at;
    doc.decidedBy = actor.type === 'user' ? (actor.id as unknown as Types.ObjectId) : null;
    doc.decisionReason = reason;
  }
  await doc.save(session ? { session } : {});
  await recordAudit(
    { actor, action: `${kind}.${to}`, targetType: kind, targetId: String(doc._id), before: { status: from }, after: { status: to }, reason },
    session ?? undefined,
  );
}

async function assertPartnerCapable(userId: string) {
  const user = await UserModel.findById(userId).lean();
  if (!user || user.status !== 'active') throw forbidden();
  if (hasAdminRole(user.roles as Role[])) throw forbidden('Admin accounts cannot apply as partners. Use a separate account.');
  return user;
}

// ===========================================================================
// Driver partner: self-service
// ===========================================================================

export async function getOrCreateDriverProfile(userId: string): Promise<DriverProfileDoc> {
  const user = await assertPartnerCapable(userId);
  const existing = await DriverProfileModel.findOne({ userId });
  if (existing) return existing;
  try {
    return await DriverProfileModel.create({ userId, contactPhone: user.phone ?? null, statusHistory: [{ from: null, to: 'draft', at: new Date(), by: userId }] });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return (await DriverProfileModel.findOne({ userId }))!;
    throw err;
  }
}

export async function driverView(profile: DriverProfileDoc) {
  const user = await UserModel.findById(profile.userId).lean();
  const docs = await listDocuments('driver', profile._id);
  return {
    profile: {
      id: profile.id as string,
      status: profile.status,
      submittedAt: profile.submittedAt,
      decisionReason: profile.decisionReason,
      contactPhone: profile.contactPhone,
      licenceNumber: profile.licenceNumber,
      licenceExpiry: profile.licenceExpiry,
      licenceCategories: profile.licenceCategories,
      experienceYears: profile.experienceYears,
      areas: profile.areas,
      languages: profile.languages,
      bio: profile.bio,
      references: profile.references,
      availability: profile.availability,
      statusHistory: profile.statusHistory.map((h) => ({ from: h.from, to: h.to, at: h.at, reason: h.reason })),
    },
    documents: docs.map(toDocumentView),
    submissionRequirements: driverSubmissionRequirements(profile, user ?? {}, docs),
  };
}

export interface DriverProfileInput {
  contactPhone?: string;
  licenceNumber?: string;
  licenceExpiry?: Date;
  licenceCategories?: string[];
  experienceYears?: number;
  areas?: string[];
  languages?: string[];
  bio?: string | null;
  references?: Array<{ name: string; phone: string; relationship: string }>;
}

export async function updateDriverProfile(userId: string, input: DriverProfileInput, actor: UserActor) {
  const profile = await getOrCreateDriverProfile(userId);
  assertEditable(profile, 'application');
  const before = profile.toObject();
  Object.assign(profile, input);
  await profile.save();
  await recordAudit({ actor, action: 'driver.profile_updated', targetType: 'driver', targetId: profile.id, before: pick(before, Object.keys(input)), after: input });
  return profile;
}

export async function submitDriverApplication(userId: string, actor: UserActor) {
  const profile = await getOrCreateDriverProfile(userId);
  assertEditable(profile, 'application');
  const user = await UserModel.findById(userId).lean();
  const reqs = driverSubmissionRequirements(profile, user ?? {}, await docsFor('driver', profile._id));
  if (!allDone(reqs)) throw new AppError(400, 'incomplete_application', 'Complete every item before submitting.', reqs.filter((r) => !r.done));
  await transition(profile, 'driver', 'applied', actor, null, null);
  await notifyUser(userId, 'partner.application_received', { roleLabel: ROLE_LABEL.driver });
  return profile;
}

export async function setDriverAvailability(userId: string, availability: { acceptingTrips: boolean; unavailable: Array<{ from: Date; to: Date; note?: string | null }> }, actor: UserActor) {
  const profile = await DriverProfileModel.findOne({ userId });
  if (!profile || profile.status !== 'approved') throw conflict('not_approved', 'You can set availability once your application is approved.');
  profile.availability = availability as never;
  await profile.save();
  await recordAudit({ actor, action: 'driver.availability_updated', targetType: 'driver', targetId: profile.id, after: availability });
  return profile;
}

// ===========================================================================
// Vehicle partner (owner): self-service
// ===========================================================================

export async function getOrCreateOwnerProfile(userId: string): Promise<OwnerProfileDoc> {
  const user = await assertPartnerCapable(userId);
  const existing = await OwnerProfileModel.findOne({ userId });
  if (existing) return existing;
  try {
    return await OwnerProfileModel.create({ userId, contactPhone: user.phone ?? null, statusHistory: [{ from: null, to: 'draft', at: new Date(), by: userId }] });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return (await OwnerProfileModel.findOne({ userId }))!;
    throw err;
  }
}

export async function ownerView(profile: OwnerProfileDoc) {
  const user = await UserModel.findById(profile.userId).lean();
  const docs = await listDocuments('owner', profile._id);
  const vehicles = await VehicleModel.find({ ownerProfileId: profile._id }).sort({ createdAt: -1 }).lean();
  return {
    profile: {
      id: profile.id as string,
      status: profile.status,
      submittedAt: profile.submittedAt,
      decisionReason: profile.decisionReason,
      contactPhone: profile.contactPhone,
      type: profile.type,
      companyName: profile.companyName,
      rdbNumber: profile.rdbNumber,
      tinNumber: profile.tinNumber,
      representativeName: profile.representativeName,
      payout: profile.payout,
      statusHistory: profile.statusHistory.map((h) => ({ from: h.from, to: h.to, at: h.at, reason: h.reason })),
    },
    documents: docs.map(toDocumentView),
    submissionRequirements: ownerSubmissionRequirements(profile, user ?? {}, docs),
    vehicles: vehicles.map((v) => ({ id: String(v._id), make: v.make, model: v.model, year: v.year, plate: v.plate, colour: v.colour, status: v.status })),
  };
}

export interface OwnerProfileInput {
  contactPhone?: string;
  type?: 'individual' | 'company';
  companyName?: string | null;
  rdbNumber?: string | null;
  tinNumber?: string | null;
  representativeName?: string | null;
  payout?: { method: 'momo' | 'bank'; momoPhone?: string | null; momoName?: string | null; bankName?: string | null; accountName?: string | null; accountNumber?: string | null };
}

export async function updateOwnerProfile(userId: string, input: OwnerProfileInput, actor: UserActor) {
  const profile = await getOrCreateOwnerProfile(userId);
  assertEditable(profile, 'application');
  const before = profile.toObject();
  Object.assign(profile, input);
  await profile.save();
  // Payout details are recorded in the audit trail as changed, not their values.
  const safeAfter = { ...input, payout: input.payout ? { method: input.payout.method, changed: true } : undefined };
  await recordAudit({ actor, action: 'owner.profile_updated', targetType: 'owner', targetId: profile.id, before: pick(before, Object.keys(input).filter((k) => k !== 'payout')), after: safeAfter });
  return profile;
}

export async function submitOwnerApplication(userId: string, actor: UserActor) {
  const profile = await getOrCreateOwnerProfile(userId);
  assertEditable(profile, 'application');
  const user = await UserModel.findById(userId).lean();
  const reqs = ownerSubmissionRequirements(profile, user ?? {}, await docsFor('owner', profile._id));
  if (!allDone(reqs)) throw new AppError(400, 'incomplete_application', 'Complete every item before submitting.', reqs.filter((r) => !r.done));
  await transition(profile, 'owner', 'applied', actor, null, null);
  await notifyUser(userId, 'partner.application_received', { roleLabel: ROLE_LABEL.owner });
  return profile;
}

// ---- vehicles ----------------------------------------------------------------

export interface VehicleInput {
  make?: string;
  model?: string;
  year?: number;
  plate?: string;
  colour?: string;
  category?: string;
  seats?: number;
  insurer?: string | null;
  insurancePolicyNumber?: string | null;
  insuranceExpiry?: Date | null;
  proposedRates?: { hourlyRwf?: number | null; dailyRwf?: number | null; airportTransferRwf?: number | null };
}

async function ownVehicle(userId: string, vehicleId: string): Promise<VehicleDoc> {
  const v = await VehicleModel.findOne({ _id: vehicleId, ownerUserId: userId });
  if (!v) throw notFound('Vehicle not found.');
  return v;
}

function plateOrThrow(raw: string): string {
  const plate = normalisePlate(raw);
  if (!plate) throw badRequest('invalid_plate', 'Enter the number plate as it appears on the vehicle, e.g. RAB 123 C.');
  return plate;
}

export async function createVehicle(userId: string, input: Required<Pick<VehicleInput, 'make' | 'model' | 'year' | 'plate' | 'colour' | 'category' | 'seats'>> & VehicleInput, actor: UserActor) {
  const owner = await getOrCreateOwnerProfile(userId);
  if (owner.status === 'suspended' || owner.status === 'rejected') throw conflict('owner_not_active', 'Your owner account must be active to add vehicles.');
  try {
    const v = await VehicleModel.create({
      ...input,
      plate: plateOrThrow(input.plate),
      ownerUserId: userId,
      ownerProfileId: owner._id,
      statusHistory: [{ from: null, to: 'draft', at: new Date(), by: userId }],
    });
    await recordAudit({ actor, action: 'vehicle.created', targetType: 'vehicle', targetId: v.id, after: { plate: v.plate, make: v.make, model: v.model } });
    return v;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('plate_taken', 'A vehicle with this number plate is already registered. Contact RideWELL if this is your vehicle.');
    throw err;
  }
}

export async function updateVehicle(userId: string, vehicleId: string, input: VehicleInput, actor: UserActor) {
  const v = await ownVehicle(userId, vehicleId);
  assertEditable(v, 'vehicle');
  const before = v.toObject();
  Object.assign(v, { ...input, ...(input.plate ? { plate: plateOrThrow(input.plate) } : {}) });
  try {
    await v.save();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('plate_taken', 'A vehicle with this number plate is already registered.');
    throw err;
  }
  await recordAudit({ actor, action: 'vehicle.updated', targetType: 'vehicle', targetId: v.id, before: pick(before, Object.keys(input)), after: input });
  return v;
}

export async function vehicleView(v: VehicleDoc | (Record<string, unknown> & { _id: unknown }), opts: { forAdmin?: boolean } = {}) {
  const vehicle = v as VehicleDoc;
  const docs = await listDocuments('vehicle', vehicle._id);
  const owner = await OwnerProfileModel.findById(vehicle.ownerProfileId).lean();
  const base = {
    id: String(vehicle._id),
    status: vehicle.status,
    submittedAt: vehicle.submittedAt,
    decisionReason: vehicle.decisionReason,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    plate: vehicle.plate,
    colour: vehicle.colour,
    category: vehicle.category,
    seats: vehicle.seats,
    insurer: vehicle.insurer,
    insurancePolicyNumber: vehicle.insurancePolicyNumber,
    insuranceExpiry: vehicle.insuranceExpiry,
    proposedRates: vehicle.proposedRates,
    inspection: vehicle.inspection ? { result: vehicle.inspection.result, notes: vehicle.inspection.notes, at: vehicle.inspection.at } : null,
    availability: vehicle.availability,
    statusHistory: vehicle.statusHistory.map((h) => ({ from: h.from, to: h.to, at: h.at, reason: h.reason })),
  };
  return {
    vehicle: base,
    documents: docs.map(toDocumentView),
    submissionRequirements: vehicleSubmissionRequirements(vehicle, docs, owner?.status ?? null),
    ...(opts.forAdmin
      ? {
          approvalRequirements: vehicleApprovalRequirements(vehicle, docs, owner?.status ?? null),
          eligibility: await vehicleEligibility(String(vehicle._id)),
          owner: owner ? { id: String(owner._id), status: owner.status, type: owner.type, companyName: owner.companyName } : null,
        }
      : {}),
  };
}

export async function getOwnVehicle(userId: string, vehicleId: string) {
  return ownVehicle(userId, vehicleId);
}

export async function submitVehicle(userId: string, vehicleId: string, actor: UserActor) {
  const v = await ownVehicle(userId, vehicleId);
  assertEditable(v, 'vehicle');
  const owner = await OwnerProfileModel.findById(v.ownerProfileId).lean();
  const reqs = vehicleSubmissionRequirements(v, await docsFor('vehicle', v._id), owner?.status ?? null);
  if (!allDone(reqs)) throw new AppError(400, 'incomplete_application', 'Complete every item before submitting.', reqs.filter((r) => !r.done));
  await transition(v, 'vehicle', 'applied', actor, null, null);
  return v;
}

export async function setVehicleAvailability(userId: string, vehicleId: string, availability: { acceptingTrips: boolean; unavailable: Array<{ from: Date; to: Date; note?: string | null }> }, actor: UserActor) {
  const v = await ownVehicle(userId, vehicleId);
  if (v.status !== 'approved') throw conflict('not_approved', 'You can set availability once the vehicle is approved.');
  v.availability = availability as never;
  await v.save();
  await recordAudit({ actor, action: 'vehicle.availability_updated', targetType: 'vehicle', targetId: v.id, after: availability });
  return v;
}

// ===========================================================================
// Admin review
// ===========================================================================

async function loadSubject(kind: SubjectKind, id: string, session?: ClientSession): Promise<AnyPartnerDoc> {
  const opts = session ? { session } : {};
  const doc =
    kind === 'driver'
      ? await DriverProfileModel.findById(id, null, opts)
      : kind === 'owner'
        ? await OwnerProfileModel.findById(id, null, opts)
        : await VehicleModel.findById(id, null, opts);
  if (!doc) throw notFound('Application not found.');
  return doc;
}

export async function listApplications(kind: SubjectKind, statuses: PartnerStatus[], limit: number, before?: string) {
  const Model = (kind === 'driver' ? DriverProfileModel : kind === 'owner' ? OwnerProfileModel : VehicleModel) as unknown as typeof VehicleModel;
  const filter: Record<string, unknown> = { status: { $in: statuses } };
  if (before) filter._id = { $lt: before };
  const rows = await Model.find(filter).sort({ submittedAt: 1, _id: -1 }).limit(limit).lean();
  const userIds = rows.map((r) => (kind === 'vehicle' ? r.ownerUserId : (r as unknown as { userId: unknown }).userId));
  const users = await UserModel.find({ _id: { $in: userIds } }).select('firstName lastName phone email').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return rows.map((r) => {
    const uid = String(kind === 'vehicle' ? r.ownerUserId : (r as unknown as { userId: unknown }).userId);
    const u = byId.get(uid);
    return {
      id: String(r._id),
      kind,
      status: r.status,
      submittedAt: r.submittedAt,
      applicant: u ? { id: uid, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null, phone: u.phone ?? null, email: u.email ?? null } : null,
      summary: kind === 'vehicle' ? `${r.make} ${r.model} · ${r.plate}` : kind === 'owner' ? ((r as unknown as { companyName?: string }).companyName ?? 'Individual owner') : 'Driver',
    };
  });
}

export async function adminSubjectView(kind: SubjectKind, id: string) {
  const subject = await loadSubject(kind, id);
  if (kind === 'vehicle') return { kind, ...(await vehicleView(subject as VehicleDoc, { forAdmin: true })) };
  const userId = String((subject as DriverProfileDoc | OwnerProfileDoc).userId);
  const user = await UserModel.findById(userId).lean();
  const applicant = user
    ? { id: userId, firstName: user.firstName ?? null, lastName: user.lastName ?? null, phone: user.phone ?? null, email: user.email ?? null, status: user.status }
    : null;
  if (kind === 'driver') {
    const p = subject as DriverProfileDoc;
    const docs = await docsFor('driver', p._id);
    return {
      kind,
      applicant,
      ...(await driverView(p)),
      checks: p.checks,
      approvalRequirements: driverApprovalRequirements(p, docs),
      eligibility: await driverEligibility(userId),
    };
  }
  const o = subject as OwnerProfileDoc;
  return { kind, applicant, ...(await ownerView(o)), approvalRequirements: ownerApprovalRequirements(o, await docsFor('owner', o._id)) };
}

/** An admin takes an application: applied → under_review. */
export async function startReview(kind: SubjectKind, id: string, actor: UserActor) {
  await withTransaction(async (session) => {
    const s = await loadSubject(kind, id, session);
    if (s.status !== 'applied') throw conflict('not_applied', `This application is ${s.status.replace('_', ' ')}.`);
    s.reviewerId = actor.id as unknown as Types.ObjectId;
    await transition(s, kind, 'under_review', actor, null, session);
  });
}

const CHECKS = ['interview', 'drivingTest', 'references'] as const;
export type DriverCheck = (typeof CHECKS)[number];

export async function recordDriverCheck(id: string, check: DriverCheck, result: 'passed' | 'failed', notes: string | null, actor: UserActor) {
  await withTransaction(async (session) => {
    const p = (await loadSubject('driver', id, session)) as DriverProfileDoc;
    if (p.status !== 'under_review') throw conflict('not_under_review', 'Start the review before recording checks.');
    const before = p.checks?.[check] ?? null;
    p.set(`checks.${check}`, { result, notes, by: actor.id, at: new Date() });
    await p.save({ session });
    await recordAudit({ actor, action: `driver.check_${result}`, targetType: 'driver', targetId: id, before: { [check]: before }, after: { [check]: { result, notes } } }, session);
  });
}

export async function recordInspection(id: string, result: 'passed' | 'failed', notes: string | null, actor: UserActor) {
  await withTransaction(async (session) => {
    const v = (await loadSubject('vehicle', id, session)) as VehicleDoc;
    if (v.status !== 'under_review') throw conflict('not_under_review', 'Start the review before recording the inspection.');
    v.set('inspection', { result, notes, by: actor.id, at: new Date() });
    await v.save({ session });
    await recordAudit({ actor, action: `vehicle.inspection_${result}`, targetType: 'vehicle', targetId: id, after: { result, notes } }, session);
  });
}

/**
 * Approve or reject. Approval is refused unless every approval requirement is met
 * (documents approved and in date, checks passed, owner approved for vehicles).
 * Approving a driver or owner grants the partner role. Rejection needs a reason
 * the partner will see.
 */
export async function decide(kind: SubjectKind, id: string, decision: 'approve' | 'reject', reason: string | null, actor: UserActor) {
  if (decision === 'reject' && !reason?.trim()) throw badRequest('reason_required', 'Give the reason, so the applicant knows what to fix.');
  let notify: (() => Promise<void>) | null = null;
  await withTransaction(async (session) => {
    const s = await loadSubject(kind, id, session);
    if (s.status !== 'under_review') throw conflict('not_under_review', 'Only applications under review can be decided.');

    if (decision === 'approve') {
      let reqs;
      if (kind === 'driver') reqs = driverApprovalRequirements(s as DriverProfileDoc, await docsFor('driver', s._id));
      else if (kind === 'owner') reqs = ownerApprovalRequirements(s as OwnerProfileDoc, await docsFor('owner', s._id));
      else {
        const owner = await OwnerProfileModel.findById((s as VehicleDoc).ownerProfileId, null, { session }).lean();
        reqs = vehicleApprovalRequirements(s as VehicleDoc, await docsFor('vehicle', s._id), owner?.status ?? null);
      }
      if (!allDone(reqs)) throw new AppError(400, 'requirements_not_met', 'Not every requirement is met yet.', reqs.filter((r) => !r.done));
    }

    await transition(s, kind, decision === 'approve' ? 'approved' : 'rejected', actor, reason?.trim() || null, session);

    if (kind !== 'vehicle') {
      const userId = String((s as DriverProfileDoc).userId);
      if (decision === 'approve') {
        const role: Role = kind === 'driver' ? 'driver_partner' : 'vehicle_partner';
        const res = await UserModel.updateOne({ _id: userId }, { $addToSet: { roles: role } }, { session });
        if (res.modifiedCount) {
          await recordAudit({ actor, action: 'user.role_granted', targetType: 'user', targetId: userId, after: { role }, reason: `${kind} application approved` }, session);
        }
      }
      notify = () =>
        notifyUser(userId, decision === 'approve' ? 'partner.approved' : 'partner.rejected', {
          roleLabel: ROLE_LABEL[kind],
          ...(decision === 'reject' ? { reason: reason!.trim() } : {}),
        });
    } else {
      const v = s as VehicleDoc;
      notify = () =>
        notifyUser(String(v.ownerUserId), decision === 'approve' ? 'vehicle.approved' : 'vehicle.rejected', {
          plate: v.plate,
          ...(decision === 'reject' ? { reason: reason!.trim() } : {}),
        });
    }
  });
  await (notify as (() => Promise<void>) | null)?.();
}

/**
 * Pause or restore a partner or vehicle. Suspending a driver or owner ends their
 * sessions immediately (spec). Removing them from future unconfirmed bookings
 * arrives with bookings in Phase 4.
 */
export async function setSuspended(kind: SubjectKind, id: string, suspend: boolean, reason: string, actor: UserActor) {
  let userToSignOut: string | null = null;
  let notify: (() => Promise<void>) | null = null;
  await withTransaction(async (session) => {
    const s = await loadSubject(kind, id, session);
    if (suspend && s.status !== 'approved') throw conflict('not_approved', 'Only approved partners and vehicles can be suspended.');
    if (!suspend && s.status !== 'suspended') throw conflict('not_suspended', 'This is not suspended.');
    await transition(s, kind, suspend ? 'suspended' : 'approved', actor, reason, session);
    if (kind === 'vehicle') {
      const v = s as VehicleDoc;
      if (suspend) notify = () => notifyUser(String(v.ownerUserId), 'vehicle.suspended', { plate: v.plate });
    } else {
      const userId = String((s as DriverProfileDoc).userId);
      if (suspend) userToSignOut = userId;
      notify = () => notifyUser(userId, suspend ? 'partner.suspended' : 'partner.reinstated', { roleLabel: ROLE_LABEL[kind] });
    }
  });
  if (userToSignOut) await revokeAllSessions(userToSignOut, `${kind}_suspended`);
  // Spec: suspension removes the partner from future unconfirmed bookings.
  if (suspend) {
    const { releaseSuspendedPartner } = await import('../bookings/booking.service.js');
    if (kind === 'driver') {
      const p = await DriverProfileModel.findById(id).lean();
      if (p) await releaseSuspendedPartner('driver', String(p.userId));
    } else if (kind === 'vehicle') {
      await releaseSuspendedPartner('vehicle', id);
    } else {
      for (const v of await VehicleModel.find({ ownerProfileId: id }, { _id: 1 }).lean()) await releaseSuspendedPartner('vehicle', String(v._id));
    }
  }
  await (notify as (() => Promise<void>) | null)?.();
}

function pick(obj: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));
}
