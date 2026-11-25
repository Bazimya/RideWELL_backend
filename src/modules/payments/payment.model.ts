import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * One customer payment attempt for a booking. The amount always comes from the
 * booking's quote on the server, never from the browser. `providerRef` is unique,
 * so a confirmation (webhook, re-check, retry) can only ever mark one payment paid.
 */
const paymentSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, enum: ['dev'], required: true },
    /** Our own unique reference sent to the provider. */
    reference: { type: String, required: true },
    providerRef: { type: String, required: true },
    amountRwf: { type: Number, required: true },
    /** Provider fee reported at confirmation (whole RWF). */
    feeRwf: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'successful', 'failed'], default: 'pending' },
    /** True for the development stand-in: no money moved. */
    isDevelopment: { type: Boolean, required: true },
    verifiedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);
paymentSchema.index({ providerRef: 1 }, { unique: true });
paymentSchema.index({ reference: 1 }, { unique: true });
paymentSchema.index({ bookingId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: 1 });

export type Payment = InferSchemaType<typeof paymentSchema>;
export const PaymentModel = model('Payment', paymentSchema, 'payments');
