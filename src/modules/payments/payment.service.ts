import crypto from 'node:crypto';
import { PaymentModel } from './payment.model.js';
import { paymentProvider } from './provider.js';
import { BookingModel } from '../bookings/booking.model.js';
import { markPaid } from '../bookings/booking.service.js';
import { alertOps } from '../bookings/alerts.js';
import { allocateOnPayment } from '../finance/finance.service.js';
import { withTransaction } from '../../db/transaction.js';
import { recordAudit } from '../audit/audit.service.js';
import { conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Customer pays an accepted quote. The amount is the server's quote; the browser
 * sends nothing but the booking id. The booking becomes `paid` only through
 * confirmPayment(), after the provider confirms the status and exact amount.
 */
export async function startPayment(bookingId: string, customerId: string) {
  const b = await BookingModel.findById(bookingId).lean();
  if (!b || String(b.customerId) !== customerId) throw notFound('Booking not found.');
  if (b.status !== 'quoted' || !b.quote) throw conflict('not_payable', 'This booking has no quote waiting for payment.');
  if (b.quote.validUntil <= new Date()) throw conflict('quote_expired', 'This quote has expired. Request a new booking.');
  if (!b.driverId || (b.service === 'chauffeur' && !b.vehicleId)) {
    throw conflict('not_ready', 'This quote is being updated by our team. Please try again shortly.');
  }

  const provider = paymentProvider();
  const reference = `PAY-${b.ref}-${crypto.randomBytes(4).toString('hex')}`;
  const customer = await import('../users/user.model.js').then((m) => m.UserModel.findById(customerId).select('phone').lean());
  const { providerRef } = await provider.requestPayment({ reference, amountRwf: b.quote.amountRwf, phone: customer?.phone ?? null });
  const payment = await PaymentModel.create({
    bookingId: b._id,
    customerId,
    provider: provider.name,
    reference,
    providerRef,
    amountRwf: b.quote.amountRwf,
    isDevelopment: provider.isDevelopment,
  });
  await recordAudit({
    actor: { type: 'user', id: customerId, roles: ['customer'] },
    action: 'payment.requested',
    targetType: 'payment',
    targetId: payment.id,
    after: { bookingId: String(b._id), amountRwf: b.quote.amountRwf, provider: provider.name, isDevelopment: provider.isDevelopment },
  });

  // The development provider settles immediately; a real one confirms by webhook (Phase 5).
  if (provider.isDevelopment) await confirmPayment(providerRef, 'dev-immediate');
  return PaymentModel.findById(payment._id).lean();
}

/**
 * Confirm a payment by its provider reference. Safe to call any number of times
 * (webhook retries, the stuck-payment re-check): it re-asks the provider, requires
 * the exact quoted amount, and marks the booking paid at most once.
 */
export async function confirmPayment(providerRef: string, source: string): Promise<'paid' | 'already' | 'pending' | 'failed' | 'mismatch' | 'too_late'> {
  const provider = paymentProvider();
  const payment = await PaymentModel.findOne({ providerRef }).lean();
  if (!payment) throw notFound('Unknown payment.');
  if (payment.status === 'successful') return 'already';

  const status = await provider.getStatus(providerRef);
  if (status.status === 'pending') return 'pending';
  if (status.status === 'failed') {
    await PaymentModel.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'failed', failureReason: 'provider_failed' } });
    return 'failed';
  }
  if (status.amountRwf !== payment.amountRwf) {
    await PaymentModel.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'failed', failureReason: 'amount_mismatch' } });
    await recordAudit({ actor: { type: 'system', name: 'payments' }, action: 'payment.amount_mismatch', targetType: 'payment', targetId: String(payment._id), after: { expected: payment.amountRwf, reported: status.amountRwf } });
    return 'mismatch';
  }

  const state: { outcome: 'paid' | 'already' | 'too_late' } = { outcome: 'paid' };
  const after = await withTransaction(async (session) => {
    state.outcome = 'paid';
    const res = await PaymentModel.updateOne(
      { _id: payment._id, status: 'pending' },
      { $set: { status: 'successful', verifiedAt: new Date(), feeRwf: Math.max(0, Math.floor(status.feeRwf ?? 0)) } },
      { session },
    );
    if (!res.modifiedCount) {
      state.outcome = 'already';
      return [];
    }
    const b = await BookingModel.findById(payment.bookingId, null, { session }).lean();
    if (!b || b.status !== 'quoted' || !b.quote || b.quote.amountRwf !== payment.amountRwf) {
      // Money arrived for a booking that can no longer take it (expired, cancelled, re-quoted).
      state.outcome = 'too_late';
      return [];
    }
    await recordAudit({ actor: { type: 'system', name: 'payments' }, action: 'payment.confirmed', targetType: 'payment', targetId: String(payment._id), after: { source, amountRwf: payment.amountRwf } }, session);
    const after = await markPaid(String(payment.bookingId), session);
    // Ledger: payment, fee, commission and partner earnings (pending), in the same transaction.
    await allocateOnPayment(String(payment.bookingId), String(payment._id), session);
    return after;
  });
  for (const fn of after) await fn().catch((err: unknown) => logger.error({ err }, 'post-payment notification failed'));
  if (state.outcome === 'too_late') {
    const b = await BookingModel.findById(payment.bookingId).lean();
    await alertOps({
      type: 'payment_after_expiry',
      bookingId: payment.bookingId,
      bookingRef: b?.ref ?? null,
      message: `${b?.ref ?? 'A booking'}: a payment of ${payment.amountRwf} RWF was confirmed after the booking stopped accepting it. A refund is needed.`,
      severity: 'high',
    });
  }
  return state.outcome;
}

