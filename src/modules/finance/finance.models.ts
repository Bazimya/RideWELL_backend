import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Partner earnings: what RideWELL owes a partner for one booking. Not a wallet
 * and not escrow: the company sells the service and pays partners for their part.
 *
 *   pending (payment confirmed) → held (trip started / completed, waiting for the
 *   dispute-free period) → payable (release rule met) → paid (Super Admin confirmed
 *   the transfer).  Side states: disputed (open safety report blocks it),
 *   reversed (cancellation / reassignment, via ledger reversal entries).
 *
 * Status changes are made only by the finance service, always alongside ledger
 * entries; there are no routes that change earnings directly.
 */
export const EARNING_STATUSES = ['pending', 'held', 'payable', 'paid', 'disputed', 'reversed'] as const;
export type EarningStatus = (typeof EARNING_STATUSES)[number];

const earningSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    bookingRef: { type: String, required: true },
    partnerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['driver', 'vehicle_owner'], required: true },
    amountRwf: { type: Number, required: true },
    status: { type: String, enum: EARNING_STATUSES, default: 'pending' },
    ledgerEntryId: { type: Schema.Types.ObjectId, required: true },
    /** When held earnings may become payable (trip end + release period). */
    releaseAt: { type: Date, default: null },
    payoutId: { type: Schema.Types.ObjectId, ref: 'Payout', default: null },
    history: {
      type: [new Schema({ to: String, at: Date, reason: String }, { _id: false })],
      default: [],
    },
  },
  { timestamps: true, versionKey: false },
);
earningSchema.index({ partnerUserId: 1, status: 1 });
earningSchema.index({ bookingId: 1, role: 1, status: 1 });
earningSchema.index({ status: 1, releaseAt: 1 });
export type Earning = InferSchemaType<typeof earningSchema>;
export const EarningModel = model('Earning', earningSchema, 'earnings');

/**
 * Refunds: requested by operations (or by the cancellation policy), approved by
 * someone else with refunds.approve, then sent through the payment provider.
 */
export const REFUND_STATUSES = ['requested', 'approved', 'rejected', 'completed', 'failed'] as const;
const refundSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    bookingRef: { type: String, required: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true },
    amountRwf: { type: Number, required: true },
    reason: { type: String, required: true, maxlength: 500 },
    source: { type: String, enum: ['cancellation_policy', 'staff_request'], required: true },
    status: { type: String, enum: REFUND_STATUSES, default: 'requested' },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, maxlength: 500, default: null },
    providerRef: { type: String, default: null },
    providerConfirmedAt: { type: Date, default: null },
    isDevelopment: { type: Boolean, default: false },
    failureReason: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);
refundSchema.index({ status: 1, createdAt: 1 });
refundSchema.index({ bookingId: 1 });
export const RefundModel = model('Refund', refundSchema, 'refunds');

/**
 * Manual payouts: a Super Admin transfers money outside the platform (MoMo or bank)
 * and records it here with the real transaction reference. The idempotency key is
 * unique, and each earning can belong to one payout only.
 */
const payoutSchema = new Schema(
  {
    partnerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    earningIds: { type: [Schema.Types.ObjectId], required: true },
    amountRwf: { type: Number, required: true },
    method: { type: String, enum: ['momo', 'bank'], required: true },
    destination: { type: String, required: true, maxlength: 200 },
    transactionRef: { type: String, required: true, maxlength: 100 },
    idempotencyKey: { type: String, required: true },
    note: { type: String, maxlength: 500, default: null },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    confirmedAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);
payoutSchema.index({ idempotencyKey: 1 }, { unique: true });
payoutSchema.index({ partnerUserId: 1, confirmedAt: -1 });
payoutSchema.index({ method: 1, transactionRef: 1 }, { unique: true });
export const PayoutModel = model('Payout', payoutSchema, 'payouts');
