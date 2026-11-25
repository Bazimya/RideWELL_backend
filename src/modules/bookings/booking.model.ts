import { Schema, model, type InferSchemaType } from 'mongoose';

export const SERVICES = ['driver_on_demand', 'chauffeur'] as const;
export type Service = (typeof SERVICES)[number];

export const BOOKING_STATUSES = ['requested', 'quoted', 'paid', 'assigned', 'in_progress', 'completed', 'expired', 'cancelled', 'refunded'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Statuses in which a booking holds its driver and vehicle for its time slot. */
export const HOLDING_STATUSES: readonly BookingStatus[] = ['quoted', 'paid', 'assigned', 'in_progress'];

const placeSchema = new Schema(
  {
    address: { type: String, required: true, maxlength: 300 },
    /** Optional until maps arrive (Phase 6). */
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    notes: { type: String, maxlength: 300, default: null },
  },
  { _id: false },
);

const statusEventSchema = new Schema(
  {
    from: { type: String, enum: BOOKING_STATUSES, default: null },
    to: { type: String, enum: BOOKING_STATUSES, required: true },
    at: { type: Date, required: true },
    actorType: { type: String, enum: ['customer', 'driver', 'vehicle_partner', 'staff', 'system', 'payment'], required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, maxlength: 500, default: null },
  },
  { _id: false },
);

const quoteSchema = new Schema(
  {
    amountRwf: { type: Number, required: true },
    note: { type: String, maxlength: 500, default: null },
    sentAt: { type: Date, required: true },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    validUntil: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * Commission and partner shares at quote time, copied onto the booking so later
 * configuration changes never alter it (brief §4).
 */
const commissionSnapshotSchema = new Schema(
  {
    configVersion: { type: Number, required: true },
    isPlaceholder: { type: Boolean, required: true },
    sharesBps: { type: Schema.Types.Mixed, required: true },
    split: { type: Schema.Types.Mixed, required: true }, // whole RWF per party, adds up to the quote
    providerFeeBearer: { type: String, required: true },
    cancellationTiers: { type: [Schema.Types.Mixed], required: true },
  },
  { _id: false },
);

const bookingSchema = new Schema(
  {
    ref: { type: String, required: true },
    service: { type: String, enum: SERVICES, required: true },
    /** Airport transfers are chauffeur bookings with a direction and flight. */
    airport: {
      direction: { type: String, enum: ['from_airport', 'to_airport'], default: null },
      flightNumber: { type: String, maxlength: 20, default: null },
    },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channel: { type: String, enum: ['web', 'phone'], default: 'web' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    pickup: { type: placeSchema, required: true },
    dropoff: { type: placeSchema, default: null },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    passengers: { type: Number, required: true, min: 1, max: 60 },
    notes: { type: String, maxlength: 1000, default: null },
    /** Driver on Demand: the customer's own car. */
    customerVehicle: {
      make: { type: String, maxlength: 60, default: null },
      model: { type: String, maxlength: 60, default: null },
      plate: { type: String, maxlength: 14, default: null },
      colour: { type: String, maxlength: 40, default: null },
      transmission: { type: String, enum: ['automatic', 'manual', null], default: null },
    },

    status: { type: String, enum: BOOKING_STATUSES, default: 'requested' },
    statusHistory: { type: [statusEventSchema], default: [] },

    quote: { type: quoteSchema, default: null },
    commissionSnapshot: { type: commissionSnapshotSchema, default: null },

    driverId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    vehicleOwnerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    acceptance: {
      deadline: { type: Date, default: null },
      driverAcceptedAt: { type: Date, default: null },
      vehicleAcceptedAt: { type: Date, default: null },
      offeredAt: { type: Date, default: null },
    },
    declines: {
      type: [new Schema({ by: Schema.Types.ObjectId, role: String, at: Date, reason: String }, { _id: false })],
      default: [],
    },

    /** Trip PIN: encrypted so the customer can see it; checked by the driver at pickup. */
    tripPinEnc: { type: String, default: null, select: false },
    pinFailedAttempts: { type: Number, default: 0 },
    pinLocked: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },

    cancellation: {
      at: { type: Date, default: null },
      by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      actorType: { type: String, default: null },
      reason: { type: String, maxlength: 500, default: null },
      hoursBeforePickup: { type: Number, default: null },
      refundBps: { type: Number, default: null },
      /** What the policy says should be refunded (whole RWF). Refunds are processed in Phase 5. */
      refundDueRwf: { type: Number, default: null },
    },

    /** Operations attention flags (cleared when handled). */
    attention: {
      needsReassignment: { type: Boolean, default: false },
      reason: { type: String, default: null },
      notStartedAlertAt: { type: Date, default: null },
      acceptanceTimeoutAt: { type: Date, default: null },
    },
    hasOpenSafetyReport: { type: Boolean, default: false },

    /**
     * Live tracking state (spec section 6). The latest point is copied here for fast
     * reads; the point history lives in `locationPoints` with a retention TTL.
     */
    tracking: {
      lastPoint: {
        lat: { type: Number, default: null },
        lng: { type: Number, default: null },
        accuracyM: { type: Number, default: null },
        recordedAt: { type: Date, default: null },
        receivedAt: { type: Date, default: null },
      },
      estimate: {
        to: { type: String, enum: ['pickup', 'dropoff', null], default: null },
        distanceM: { type: Number, default: null },
        durationS: { type: Number, default: null },
        kind: { type: String, enum: ['route', 'straight_line', null], default: null },
        computedAt: { type: Date, default: null },
      },
      approachingNotifiedAt: { type: Date, default: null },
      closedAt: { type: Date, default: null },
    },
  },
  { timestamps: true, versionKey: false },
);

bookingSchema.index({ ref: 1 }, { unique: true });
bookingSchema.index({ customerId: 1, createdAt: -1 });
bookingSchema.index({ driverId: 1, startAt: 1 });
bookingSchema.index({ vehicleId: 1, startAt: 1 });
bookingSchema.index({ status: 1, startAt: 1 });
bookingSchema.index({ vehicleOwnerId: 1, startAt: -1 });
bookingSchema.index({ 'attention.needsReassignment': 1, status: 1 });

export type Booking = InferSchemaType<typeof bookingSchema>;
export const BookingModel = model('Booking', bookingSchema, 'bookings');
export type BookingDoc = InstanceType<typeof BookingModel>;
