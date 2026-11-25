import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Partner records. Each is approved on its own (spec: "each role is approved
 * separately"; "a vehicle has its own state").
 *
 *   draft → applied → under_review → approved ⇄ suspended
 *                          └──────→ rejected → applied (after changes)
 *
 * Small, bounded sub-data that is always read with the record (references,
 * review checks, availability, status history) is embedded. Documents are a
 * separate collection: they are reviewed and access-logged one by one.
 */
export const PARTNER_STATUSES = ['draft', 'applied', 'under_review', 'approved', 'rejected', 'suspended'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

const checkSchema = new Schema(
  {
    result: { type: String, enum: ['passed', 'failed'], required: true },
    notes: { type: String, maxlength: 1000, default: null },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const statusEventSchema = new Schema(
  {
    from: { type: String, enum: PARTNER_STATUSES, default: null },
    to: { type: String, enum: PARTNER_STATUSES, required: true },
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, maxlength: 1000, default: null },
  },
  { _id: false },
);

const periodSchema = new Schema(
  { from: { type: Date, required: true }, to: { type: Date, required: true }, note: { type: String, maxlength: 200, default: null } },
  { _id: false },
);

const availabilitySchema = new Schema(
  {
    acceptingTrips: { type: Boolean, default: false },
    unavailable: { type: [periodSchema], default: [] },
  },
  { _id: false },
);

const decisionFields = {
  status: { type: String, enum: PARTNER_STATUSES, default: 'draft' },
  statusHistory: { type: [statusEventSchema], default: [] },
  submittedAt: { type: Date, default: null },
  reviewerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  decidedAt: { type: Date, default: null },
  decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  decisionReason: { type: String, maxlength: 1000, default: null },
};

const payoutSchema = new Schema(
  {
    method: { type: String, enum: ['momo', 'bank'], required: true },
    momoPhone: { type: String, default: null },
    momoName: { type: String, maxlength: 120, default: null },
    bankName: { type: String, maxlength: 120, default: null },
    accountName: { type: String, maxlength: 120, default: null },
    accountNumber: { type: String, maxlength: 40, default: null },
  },
  { _id: false },
);

// ---------------------------------------------------------------------------
// Driver partner
// ---------------------------------------------------------------------------

const referenceSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 120 },
    phone: { type: String, required: true },
    relationship: { type: String, required: true, maxlength: 80 },
  },
  { _id: false },
);

const driverProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ...decisionFields,
    /** E.164 number operations calls. Defaults to the account phone; not a sign-in identity. */
    contactPhone: { type: String, default: null },
    licenceNumber: { type: String, maxlength: 40, default: null },
    /** Applicant's claim. The admin-confirmed expiry on the approved licence document is authoritative. */
    licenceExpiry: { type: Date, default: null },
    licenceCategories: { type: [String], default: [] },
    experienceYears: { type: Number, min: 0, max: 60, default: null },
    areas: { type: [String], default: [] },
    languages: { type: [String], default: [] },
    bio: { type: String, maxlength: 600, default: null },
    references: { type: [referenceSchema], default: [] },
    checks: {
      interview: { type: checkSchema, default: null },
      drivingTest: { type: checkSchema, default: null },
      references: { type: checkSchema, default: null },
    },
    availability: { type: availabilitySchema, default: () => ({}) },
    /** Where RideWELL pays this driver's earnings. */
    payout: { type: payoutSchema, default: null },
    /** Spec: a driver with a safety report is paused until the report is reviewed. */
    safetyHold: {
      active: { type: Boolean, default: false },
      since: { type: Date, default: null },
      reportId: { type: Schema.Types.ObjectId, default: null },
    },
  },
  { timestamps: true, versionKey: false },
);
driverProfileSchema.index({ userId: 1 }, { unique: true });
driverProfileSchema.index({ status: 1, submittedAt: 1 });

export type DriverProfile = InferSchemaType<typeof driverProfileSchema>;
export const DriverProfileModel = model('DriverProfile', driverProfileSchema, 'driverProfiles');
export type DriverProfileDoc = InstanceType<typeof DriverProfileModel>;

// ---------------------------------------------------------------------------
// Vehicle partner (owner: individual or company)
// ---------------------------------------------------------------------------

const ownerProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ...decisionFields,
    contactPhone: { type: String, default: null },
    type: { type: String, enum: ['individual', 'company'], default: null },
    companyName: { type: String, maxlength: 160, default: null },
    rdbNumber: { type: String, maxlength: 40, default: null },
    tinNumber: { type: String, maxlength: 40, default: null },
    representativeName: { type: String, maxlength: 120, default: null },
    payout: { type: payoutSchema, default: null },
  },
  { timestamps: true, versionKey: false },
);
ownerProfileSchema.index({ userId: 1 }, { unique: true });
ownerProfileSchema.index({ status: 1, submittedAt: 1 });

export type OwnerProfile = InferSchemaType<typeof ownerProfileSchema>;
export const OwnerProfileModel = model('OwnerProfile', ownerProfileSchema, 'partnerProfiles');
export type OwnerProfileDoc = InstanceType<typeof OwnerProfileModel>;

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export const VEHICLE_CATEGORIES = ['sedan', 'suv', 'executive', 'van', 'minibus'] as const;

const ratesSchema = new Schema(
  {
    /** Whole RWF. The owner's proposal; the platform sets the customer price. */
    hourlyRwf: { type: Number, default: null },
    dailyRwf: { type: Number, default: null },
    airportTransferRwf: { type: Number, default: null },
  },
  { _id: false },
);

const vehicleSchema = new Schema(
  {
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ownerProfileId: { type: Schema.Types.ObjectId, ref: 'OwnerProfile', required: true },
    ...decisionFields,
    /** Listing type, so self-drive rentals can be added later without a new model. */
    listingType: { type: String, enum: ['chauffeured'], default: 'chauffeured' },
    make: { type: String, required: true, maxlength: 60 },
    model: { type: String, required: true, maxlength: 60 },
    year: { type: Number, required: true, min: 1990, max: 2100 },
    /** Normalised: upper case, no spaces, e.g. RAB123C. */
    plate: { type: String, required: true },
    colour: { type: String, required: true, maxlength: 40 },
    category: { type: String, enum: VEHICLE_CATEGORIES, required: true },
    seats: { type: Number, required: true, min: 1, max: 60 },
    insurer: { type: String, maxlength: 120, default: null },
    insurancePolicyNumber: { type: String, maxlength: 60, default: null },
    /** Owner's claim. The admin-confirmed expiry on the approved insurance document is authoritative. */
    insuranceExpiry: { type: Date, default: null },
    proposedRates: { type: ratesSchema, default: () => ({}) },
    inspection: { type: checkSchema, default: null },
    availability: { type: availabilitySchema, default: () => ({}) },
  },
  { timestamps: true, versionKey: false },
);
vehicleSchema.index({ plate: 1 }, { unique: true });
vehicleSchema.index({ ownerUserId: 1, createdAt: -1 });
vehicleSchema.index({ status: 1, submittedAt: 1 });

export type Vehicle = InferSchemaType<typeof vehicleSchema>;
export const VehicleModel = model('Vehicle', vehicleSchema, 'vehicles');
export type VehicleDoc = InstanceType<typeof VehicleModel>;

export function normalisePlate(input: string): string | null {
  const p = input.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{4,10}$/.test(p) ? p : null;
}
