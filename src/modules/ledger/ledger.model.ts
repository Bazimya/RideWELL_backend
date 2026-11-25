import { Schema, model, type InferSchemaType } from 'mongoose';
import { appendOnly } from '../../db/appendOnly.js';

/**
 * Internal accounting ledger (not a wallet, not escrow). One entry per financial
 * event. Append-only: corrections are new `adjustment` or `reversal` entries that
 * point at the entry they correct.
 */
export const LEDGER_TYPES = [
  'customer_payment',
  'provider_fee',
  'platform_commission',
  'driver_earning',
  'vehicle_owner_earning',
  'payout',
  'refund',
  'adjustment',
  'reversal',
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

export const LEDGER_PARTIES = ['customer', 'platform', 'driver', 'vehicle_owner', 'payment_provider'] as const;
export type LedgerParty = (typeof LEDGER_PARTIES)[number];

const ledgerEntrySchema = new Schema(
  {
    type: { type: String, enum: LEDGER_TYPES, required: true },
    party: { type: String, enum: LEDGER_PARTIES, required: true },
    /** The user behind the party (customer, driver, vehicle owner); null for platform/provider. */
    partyUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    payoutId: { type: Schema.Types.ObjectId, default: null },
    refundId: { type: Schema.Types.ObjectId, default: null },
    /**
     * Whole RWF. Positive = money owed to / received by the party; negative only on
     * reversal/adjustment entries that reduce an earlier amount.
     */
    amount: {
      type: Number,
      required: true,
      validate: { validator: (v: number) => Number.isSafeInteger(v) && v !== 0, message: 'amount must be a non-zero whole number of RWF' },
    },
    currency: { type: String, enum: ['RWF'], default: 'RWF' },
    /** Entry this one corrects (reversal / adjustment). */
    correctsEntryId: { type: Schema.Types.ObjectId, default: null },
    /** Provider or bank transaction id, when the event happened outside the platform. */
    externalRef: { type: String, default: null },
    /** Unique per real-world event: replaying the same event cannot double-post. */
    idempotencyKey: { type: String, required: true },
    memo: { type: String, maxlength: 500, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBySystem: { type: String, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false },
);

ledgerEntrySchema.index({ idempotencyKey: 1 }, { unique: true });
ledgerEntrySchema.index({ bookingId: 1, createdAt: 1 });
ledgerEntrySchema.index({ partyUserId: 1, createdAt: -1 });
ledgerEntrySchema.index({ type: 1, createdAt: -1 });

appendOnly(ledgerEntrySchema, 'ledger');

export type LedgerEntry = InferSchemaType<typeof ledgerEntrySchema>;
export const LedgerEntryModel = model('LedgerEntry', ledgerEntrySchema, 'ledger');
