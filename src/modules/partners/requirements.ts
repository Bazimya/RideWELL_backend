import type { Types } from 'mongoose';
import { DocumentModel, type DocumentKind } from '../documents/document.model.js';
import type { DriverProfile, OwnerProfile, Vehicle } from './partner.models.js';
import { DriverProfileModel, OwnerProfileModel, VehicleModel } from './partner.models.js';
import { UserModel } from '../users/user.model.js';

export interface Requirement {
  key: string;
  label: string;
  done: boolean;
}

export const MIN_VEHICLE_PHOTOS = 4;
export const MIN_REFERENCES = 2;

type DocSummary = { kind: string; status: string; expiresAt?: Date | null };

const has = (docs: DocSummary[], kind: DocumentKind, statuses: string[]) => docs.some((d) => d.kind === kind && statuses.includes(d.status));
const countOf = (docs: DocSummary[], kind: DocumentKind, statuses: string[]) => docs.filter((d) => d.kind === kind && statuses.includes(d.status)).length;
const approvedValid = (docs: DocSummary[], kind: DocumentKind, at: Date) =>
  docs.some((d) => d.kind === kind && d.status === 'approved' && d.expiresAt && d.expiresAt > at);

const UPLOADED = ['pending', 'approved'];
const future = (d?: Date | null) => Boolean(d && d > new Date());

async function docsFor(subjectType: 'driver' | 'owner' | 'vehicle', subjectId: Types.ObjectId | string): Promise<DocSummary[]> {
  return DocumentModel.find({ subjectType, subjectId, status: { $ne: 'superseded' } }, { kind: 1, status: 1, expiresAt: 1 }).lean();
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export function driverSubmissionRequirements(p: DriverProfile, names: { firstName?: string | null; lastName?: string | null }, docs: DocSummary[]): Requirement[] {
  return [
    { key: 'name', label: 'Your first and last name', done: Boolean(names.firstName && names.lastName) },
    { key: 'contactPhone', label: 'A phone number operations can reach you on', done: Boolean(p.contactPhone) },
    { key: 'licence', label: 'Licence number and expiry date (not expired)', done: Boolean(p.licenceNumber) && future(p.licenceExpiry) },
    { key: 'experience', label: 'Years of driving experience', done: p.experienceYears !== null && p.experienceYears !== undefined },
    { key: 'areas', label: 'At least one area you work in', done: (p.areas ?? []).length > 0 },
    { key: 'references', label: `At least ${MIN_REFERENCES} references`, done: (p.references ?? []).length >= MIN_REFERENCES },
    { key: 'doc:id_document', label: 'National ID or passport', done: has(docs, 'id_document', UPLOADED) },
    { key: 'doc:driving_licence', label: 'Driving licence', done: has(docs, 'driving_licence', UPLOADED) },
    { key: 'doc:profile_photo', label: 'A clear photo of your face', done: has(docs, 'profile_photo', UPLOADED) },
  ];
}

export function driverApprovalRequirements(p: DriverProfile, docs: DocSummary[]): Requirement[] {
  const now = new Date();
  return [
    { key: 'doc:id_document', label: 'ID document approved', done: has(docs, 'id_document', ['approved']) },
    { key: 'doc:driving_licence', label: 'Driving licence approved and not expired', done: approvedValid(docs, 'driving_licence', now) },
    { key: 'doc:profile_photo', label: 'Profile photo approved', done: has(docs, 'profile_photo', ['approved']) },
    { key: 'check:interview', label: 'Interview passed', done: p.checks?.interview?.result === 'passed' },
    { key: 'check:drivingTest', label: 'Driving test passed', done: p.checks?.drivingTest?.result === 'passed' },
    { key: 'check:references', label: 'References checked', done: p.checks?.references?.result === 'passed' },
  ];
}

// ---------------------------------------------------------------------------
// Owner (vehicle partner)
// ---------------------------------------------------------------------------

export function ownerSubmissionRequirements(p: OwnerProfile, names: { firstName?: string | null; lastName?: string | null }, docs: DocSummary[]): Requirement[] {
  const company = p.type === 'company';
  const payout = p.payout;
  const payoutDone =
    Boolean(payout) &&
    (payout!.method === 'momo' ? Boolean(payout!.momoPhone && payout!.momoName) : Boolean(payout!.bankName && payout!.accountName && payout!.accountNumber));
  const reqs: Requirement[] = [
    { key: 'name', label: 'Your first and last name', done: Boolean(names.firstName && names.lastName) },
    { key: 'contactPhone', label: 'A phone number operations can reach you on', done: Boolean(p.contactPhone) },
    { key: 'type', label: 'Individual owner or company', done: Boolean(p.type) },
    { key: 'payout', label: 'Where we pay your earnings (MoMo or bank)', done: payoutDone },
    { key: 'doc:id_document', label: company ? "Representative's ID or passport" : 'National ID or passport', done: has(docs, 'id_document', UPLOADED) },
  ];
  if (company) {
    reqs.push(
      { key: 'company', label: 'Company name, RDB number and representative', done: Boolean(p.companyName && p.rdbNumber && p.representativeName) },
      { key: 'doc:rdb_certificate', label: 'RDB registration certificate', done: has(docs, 'rdb_certificate', UPLOADED) },
    );
  }
  return reqs;
}

export function ownerApprovalRequirements(p: OwnerProfile, docs: DocSummary[]): Requirement[] {
  const reqs: Requirement[] = [{ key: 'doc:id_document', label: 'ID document approved', done: has(docs, 'id_document', ['approved']) }];
  if (p.type === 'company') reqs.push({ key: 'doc:rdb_certificate', label: 'RDB certificate approved', done: has(docs, 'rdb_certificate', ['approved']) });
  return reqs;
}

// ---------------------------------------------------------------------------
// Vehicle
// ---------------------------------------------------------------------------

export function vehicleSubmissionRequirements(v: Vehicle, docs: DocSummary[], ownerStatus: string | null): Requirement[] {
  const r = v.proposedRates;
  return [
    { key: 'owner', label: 'Your owner application is submitted', done: Boolean(ownerStatus && !['draft', 'rejected', 'suspended'].includes(ownerStatus)) },
    { key: 'insuranceDetails', label: 'Insurer and insurance expiry date (not expired)', done: Boolean(v.insurer) && future(v.insuranceExpiry) },
    { key: 'rates', label: 'At least one proposed rate', done: Boolean(r?.hourlyRwf || r?.dailyRwf || r?.airportTransferRwf) },
    { key: 'doc:registration_certificate', label: 'Registration certificate (carte jaune)', done: has(docs, 'registration_certificate', UPLOADED) },
    { key: 'doc:ownership_proof', label: 'Proof of ownership or authorisation to rent it out', done: has(docs, 'ownership_proof', UPLOADED) },
    { key: 'doc:insurance', label: 'Insurance certificate', done: has(docs, 'insurance', UPLOADED) },
    {
      key: 'doc:vehicle_photo',
      label: `At least ${MIN_VEHICLE_PHOTOS} real photos of the vehicle`,
      done: countOf(docs, 'vehicle_photo', UPLOADED) >= MIN_VEHICLE_PHOTOS,
    },
  ];
}

export function vehicleApprovalRequirements(v: Vehicle, docs: DocSummary[], ownerStatus: string | null): Requirement[] {
  const now = new Date();
  return [
    { key: 'owner', label: 'Owner approved', done: ownerStatus === 'approved' },
    { key: 'doc:registration_certificate', label: 'Registration approved', done: has(docs, 'registration_certificate', ['approved']) },
    { key: 'doc:ownership_proof', label: 'Ownership / authorisation approved', done: has(docs, 'ownership_proof', ['approved']) },
    { key: 'doc:insurance', label: 'Insurance approved and not expired', done: approvedValid(docs, 'insurance', now) },
    { key: 'doc:vehicle_photo', label: `${MIN_VEHICLE_PHOTOS}+ photos approved`, done: countOf(docs, 'vehicle_photo', ['approved']) >= MIN_VEHICLE_PHOTOS },
    { key: 'check:inspection', label: 'Inspection passed', done: v.inspection?.result === 'passed' },
  ];
}

export const allDone = (reqs: Requirement[]) => reqs.every((r) => r.done);

// ---------------------------------------------------------------------------
// Eligibility for assignment (used by Phase 4). Computed live, so an expiry
// blocks assignment the moment it passes, whether or not a job has run.
// ---------------------------------------------------------------------------

export interface Eligibility {
  assignable: boolean;
  reasons: string[];
}

/** Can this driver be assigned a trip that ends at `until`? */
export async function driverEligibility(userId: string, until: Date = new Date()): Promise<Eligibility> {
  const reasons: string[] = [];
  const [user, profile] = await Promise.all([UserModel.findById(userId).lean(), DriverProfileModel.findOne({ userId }).lean()]);
  if (!user || user.status !== 'active') reasons.push('account_inactive');
  if (!profile) return { assignable: false, reasons: [...reasons, 'no_driver_profile'] };
  if (profile.status !== 'approved') reasons.push(`driver_${profile.status}`);
  const docs = await docsFor('driver', profile._id);
  if (!approvedValid(docs, 'driving_licence', until)) reasons.push('licence_expired_or_missing');
  if (!profile.availability?.acceptingTrips) reasons.push('not_accepting_trips');
  if (profile.safetyHold?.active) reasons.push('paused_safety_review');
  return { assignable: reasons.length === 0, reasons };
}

/** Can this vehicle be assigned a trip that ends at `until`? Expired insurance blocks automatically. */
export async function vehicleEligibility(vehicleId: string, until: Date = new Date()): Promise<Eligibility> {
  const reasons: string[] = [];
  const vehicle = await VehicleModel.findById(vehicleId).lean();
  if (!vehicle) return { assignable: false, reasons: ['no_vehicle'] };
  const [owner, ownerUser] = await Promise.all([
    OwnerProfileModel.findById(vehicle.ownerProfileId).lean(),
    UserModel.findById(vehicle.ownerUserId).lean(),
  ]);
  if (vehicle.status !== 'approved') reasons.push(`vehicle_${vehicle.status}`);
  if (!owner || owner.status !== 'approved') reasons.push(`owner_${owner?.status ?? 'missing'}`);
  if (!ownerUser || ownerUser.status !== 'active') reasons.push('owner_account_inactive');
  const docs = await docsFor('vehicle', vehicle._id);
  if (!approvedValid(docs, 'insurance', until)) reasons.push('insurance_expired_or_missing');
  if (!vehicle.availability?.acceptingTrips) reasons.push('not_accepting_trips');
  return { assignable: reasons.length === 0, reasons };
}

export { docsFor };
