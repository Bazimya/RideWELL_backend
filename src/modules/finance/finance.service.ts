import crypto from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import { EarningModel, PayoutModel, RefundModel, type EarningStatus } from './finance.models.js';
import { LedgerEntryModel } from '../ledger/ledger.model.js';
import { postLedgerEntries, type LedgerEntryInput } from '../ledger/ledger.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { PaymentModel } from '../payments/payment.model.js';
import { paymentProvider } from '../payments/provider.js';
import { requireConfig } from '../platformConfig/platformConfig.service.js';
import { withTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { notifyUser } from '../notifications/notification.service.js';
import { splitByBps } from '../../lib/money.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { UserModel } from '../users/user.model.js';
import { DriverProfileModel, OwnerProfileModel } from '../partners/partner.models.js';

/**
 * RideWELL's internal accounting (brief §4). The company sells the service and pays
 * partners for their part: no wallets, no escrow. Every money event is a ledger
 * entry; nothing is edited. For every booking:
 *
 *   customer payments − refunds  =  Σ allocations
 *   allocations = platform_commission + driver_earning + vehicle_owner_earning
 *               + provider_fee + adjustment + reversal
 *
 * Payouts settle earnings and are not allocations.
 */

const ALLOCATION_TYPES = ['platform_commission', 'driver_earning', 'vehicle_owner_earning', 'provider_fee', 'adjustment', 'reversal'] as const;

type Actor = { id: string | null; system?: string };
const by = (a: Actor) => (a.id ? { createdBy: a.id } : { createdBySystem: a.system ?? 'finance' });
const auditActor = (a: Actor, roles: readonly string[] = []): AuditActor => (a.id ? { type: 'user', id: a.id, roles } : { type: 'system', name: a.system ?? 'finance' });

function addHistory(status: EarningStatus, reason: string) {
  return { $set: { status }, $push: { history: { to: status, at: new Date(), reason } } };
}

// ---------------------------------------------------------------------------
// Payment confirmed: post the split and allocate partner earnings (pending)
// ---------------------------------------------------------------------------

export async function allocateOnPayment(bookingId: string, paymentId: string, session: ClientSession) {
  const b = await BookingModel.findById(bookingId, null, { session });
  const payment = await PaymentModel.findById(paymentId, null, { session });
  if (!b || !payment || !b.commissionSnapshot) throw new Error('allocateOnPayment: booking, payment or snapshot missing');
  const snap = b.commissionSnapshot as unknown as { sharesBps: Record<string, number> & { platform: number }; providerFeeBearer: string };
  const amount = payment.amountRwf;
  const fee = payment.feeRwf ?? 0;
  const net = snap.providerFeeBearer === 'deducted_before_split' ? amount - fee : amount;
  const split = splitByBps(net, snap.sharesBps) as Record<string, number> & { platform: number };
  const sys = { createdBySystem: 'payments' };

  const [payEntry] = await postLedgerEntries(
    [{ type: 'customer_payment', party: 'customer', partyUserId: b.customerId, bookingId: b._id, amount, externalRef: payment.providerRef, idempotencyKey: `pay:${paymentId}`, ...sys }],
    session,
  );
  const rest: LedgerEntryInput[] = [];
  if (fee > 0) rest.push({ type: 'provider_fee', party: 'payment_provider', bookingId: b._id, amount: fee, idempotencyKey: `fee:${paymentId}`, ...sys });
  if (split.platform > 0) rest.push({ type: 'platform_commission', party: 'platform', bookingId: b._id, amount: split.platform, idempotencyKey: `commission:${paymentId}`, ...sys });
  if (fee > 0 && snap.providerFeeBearer === 'platform') {
    rest.push({ type: 'adjustment', party: 'platform', bookingId: b._id, amount: -fee, correctsEntryId: payEntry!._id, memo: 'Provider fee absorbed by the platform', idempotencyKey: `fee-absorbed:${paymentId}`, ...sys });
  }
  if (rest.length) await postLedgerEntries(rest, session);

  if (b.driverId && split.driver) await createEarning(b, 'driver', String(b.driverId), split.driver, session);
  if (b.vehicleOwnerId && split.vehicle_owner) await createEarning(b, 'vehicle_owner', String(b.vehicleOwnerId), split.vehicle_owner, session);
}

async function createEarning(b: { _id: unknown; ref: string }, role: 'driver' | 'vehicle_owner', partnerUserId: string, amount: number, session: ClientSession) {
  const n = await EarningModel.countDocuments({ bookingId: b._id, role }, { session });
  const [entry] = await postLedgerEntries(
    [
      {
        type: role === 'driver' ? 'driver_earning' : 'vehicle_owner_earning',
        party: role,
        partyUserId: partnerUserId,
        bookingId: b._id as Types.ObjectId,
        amount,
        idempotencyKey: `earning:${String(b._id)}:${role}:${n}`,
        createdBySystem: 'payments',
      },
    ],
    session,
  );
  await EarningModel.create(
    [{ bookingId: b._id, bookingRef: b.ref, partnerUserId, role, amountRwf: amount, ledgerEntryId: entry!._id, history: [{ to: 'pending', at: new Date(), reason: 'Payment confirmed' }] }],
    { session },
  );
}

/** Reverse an earning that will not be paid (cancellation, reassignment). Never touches paid earnings. */
async function reverseEarning(earningId: unknown, reason: string, actor: Actor, session: ClientSession) {
  const e = await EarningModel.findOneAndUpdate(
    { _id: earningId, status: { $in: ['pending', 'held', 'payable', 'disputed'] } },
    addHistory('reversed', reason),
    { session, new: true },
  );
  if (!e) return null;
  await postLedgerEntries(
    [{ type: 'reversal', party: e.role as 'driver' | 'vehicle_owner', partyUserId: e.partnerUserId, bookingId: e.bookingId, amount: -e.amountRwf, correctsEntryId: e.ledgerEntryId, memo: reason, idempotencyKey: `reversal:${String(e.ledgerEntryId)}`, ...by(actor) }],
    session,
  );
  return e;
}

/**
 * The booking's partner for `role` changed after payment (decline, reassignment,
 * suspension): the old partner's earning is reversed and the same amount is
 * allocated to the new partner.
 */
export async function reallocateEarning(bookingId: string, role: 'driver' | 'vehicle_owner', newPartnerUserId: string | null, actor: Actor, session: ClientSession) {
  const current = await EarningModel.findOne({ bookingId, role, status: { $in: ['pending', 'held', 'payable', 'disputed'] } }, null, { session });
  const b = await BookingModel.findById(bookingId, null, { session });
  if (!b) return;
  const hasPayment = await LedgerEntryModel.exists({ bookingId, type: 'customer_payment' }).session(session);
  if (!hasPayment) return; // nothing allocated before payment
  if (current && String(current.partnerUserId) === newPartnerUserId) return;
  let amount = current?.amountRwf ?? null;
  if (current) await reverseEarning(current._id, newPartnerUserId ? 'Reassigned to another partner' : 'Partner removed from booking', actor, session);
  if (amount === null) {
    // No live earning (it was reversed when the partner declined): reallocate the snapshot share.
    const split = (b.commissionSnapshot as unknown as { split: Record<string, number> } | null)?.split ?? {};
    amount = split[role] ?? null;
  }
  if (newPartnerUserId && amount) await createEarning(b, role, newPartnerUserId, amount, session);
}

// ---------------------------------------------------------------------------
// Trip lifecycle → earning states
// ---------------------------------------------------------------------------

export async function onTripStarted(bookingId: string, session: ClientSession) {
  await EarningModel.updateMany({ bookingId, status: 'pending' }, addHistory('held', 'Trip started'), { session });
}

export async function onTripCompleted(bookingId: string, endedAt: Date, session: ClientSession) {
  const cfg = (await requireConfig(session)).values;
  const releaseAt = new Date(endedAt.getTime() + cfg.payoutReleaseHours * 3_600_000);
  await EarningModel.updateMany(
    { bookingId, status: { $in: ['pending', 'held'] } },
    { $set: { status: 'held', releaseAt }, $push: { history: { to: 'held', at: new Date(), reason: `Trip completed; payable after ${cfg.payoutReleaseHours} h without disputes` } } },
    { session },
  );
}

/** Safety report opened: everything unpaid on the booking is blocked. */
export async function disputeBooking(bookingId: string, session: ClientSession) {
  await EarningModel.updateMany({ bookingId, status: { $in: ['pending', 'held', 'payable'] } }, addHistory('disputed', 'Safety report under review'), { session });
}

/** Last open report resolved: earnings go back to held; the release job decides when they are payable. */
export async function undisputeBooking(bookingId: string, session: ClientSession) {
  const b = await BookingModel.findById(bookingId, null, { session }).lean();
  const back: EarningStatus = b?.status === 'completed' ? 'held' : b?.status === 'in_progress' ? 'held' : 'pending';
  await EarningModel.updateMany({ bookingId, status: 'disputed' }, addHistory(back, 'Safety report resolved'), { session });
}

/**
 * Release rule (brief §0): completed + the dispute-free period + no open safety
 * report → payable. Never released just because payment was received.
 */
export async function releaseDueEarnings(now = new Date()): Promise<number> {
  const due = await EarningModel.find({ status: 'held', releaseAt: { $lte: now } }).lean();
  let n = 0;
  for (const e of due) {
    const b = await BookingModel.findById(e.bookingId).lean();
    if (!b || b.status !== 'completed') continue;
    if (b.hasOpenSafetyReport) {
      await EarningModel.updateOne({ _id: e._id, status: 'held' }, addHistory('disputed', 'Safety report open at release time'));
      continue;
    }
    const res = await EarningModel.updateOne({ _id: e._id, status: 'held' }, addHistory('payable', 'Release period passed without disputes'));
    if (res.modifiedCount) {
      n++;
      await recordAudit({ actor: { type: 'system', name: 'earnings-release' }, action: 'earning.payable', targetType: 'earning', targetId: String(e._id), after: { amountRwf: e.amountRwf, bookingRef: e.bookingRef } });
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Cancellation of a paid booking
// ---------------------------------------------------------------------------

/**
 * Reverse the commission and every unpaid earning, keep what the policy keeps
 * as platform income, and create the refund request for what the policy returns.
 */
export async function onPaidBookingCancelled(bookingId: string, refundDueRwf: number, actor: Actor, actorRoles: string[], session: ClientSession) {
  const payEntries = await LedgerEntryModel.find({ bookingId, type: 'customer_payment' }, null, { session }).lean();
  if (!payEntries.length) return null;
  const paid = payEntries.reduce((s, e) => s + e.amount, 0);

  for (const e of await EarningModel.find({ bookingId, status: { $in: ['pending', 'held', 'payable', 'disputed'] } }, null, { session })) {
    await reverseEarning(e._id, 'Booking cancelled', actor, session);
  }
  const reversible = await LedgerEntryModel.find({ bookingId, type: { $in: ['platform_commission'] } }, null, { session }).lean();
  for (const c of reversible) {
    await postLedgerEntries([{ type: 'reversal', party: 'platform', bookingId: c.bookingId, amount: -c.amount, correctsEntryId: c._id, memo: 'Booking cancelled', idempotencyKey: `reversal:${String(c._id)}`, ...by(actor) }], session);
  }
  // Allocations must now equal paid − refund: whatever is left after the provider fee is retained by the platform.
  const allocated = await allocationsTotal(bookingId, session);
  const retain = paid - refundDueRwf - allocated;
  if (retain !== 0) {
    await postLedgerEntries(
      [{ type: 'adjustment', party: 'platform', bookingId: payEntries[0]!.bookingId, amount: retain, correctsEntryId: payEntries[0]!._id, memo: 'Kept under the cancellation policy', idempotencyKey: `cancel-retained:${bookingId}`, ...by(actor) }],
      session,
    );
  }
  if (refundDueRwf <= 0) return null;
  const payment = await PaymentModel.findOne({ bookingId, status: 'successful' }, null, { session }).lean();
  const b = await BookingModel.findById(bookingId, null, { session }).lean();
  const [refund] = await RefundModel.create(
    [{ bookingId, bookingRef: b!.ref, paymentId: payment!._id, amountRwf: refundDueRwf, reason: 'Cancellation policy', source: 'cancellation_policy', requestedBy: actor.id }],
    { session },
  );
  await recordAudit({ actor: auditActor(actor, actorRoles), action: 'refund.requested', targetType: 'refund', targetId: String(refund!._id), after: { amountRwf: refundDueRwf, source: 'cancellation_policy', bookingRef: b!.ref } }, session);
  return refund;
}

async function allocationsTotal(bookingId: string, session?: ClientSession): Promise<number> {
  const rows = await LedgerEntryModel.find({ bookingId, type: { $in: ALLOCATION_TYPES } }, { amount: 1 }, session ? { session } : {}).lean();
  return rows.reduce((s, r) => s + r.amount, 0);
}

/** The accounting identity for one booking. `balanced` must always be true. */
export async function bookingBalance(bookingId: string) {
  const rows = await LedgerEntryModel.find({ bookingId }).lean();
  const sum = (types: readonly string[]) => rows.filter((r) => types.includes(r.type)).reduce((s, r) => s + r.amount, 0);
  const paid = sum(['customer_payment']);
  const refunded = sum(['refund']);
  const allocations = sum(ALLOCATION_TYPES);
  const paidOut = sum(['payout']);
  return { paid, refunded, allocations, paidOut, balanced: paid - refunded === allocations };
}

// ---------------------------------------------------------------------------
// Refunds: requested by one person, approved by another
// ---------------------------------------------------------------------------

export async function requestRefund(bookingId: string, amountRwf: number, reason: string, staff: { id: string; roles: string[] }) {
  return withTransaction(async (session) => {
    const b = await BookingModel.findById(bookingId, null, { session }).lean();
    if (!b) throw notFound('Booking not found.');
    const payment = await PaymentModel.findOne({ bookingId, status: 'successful' }, null, { session }).lean();
    if (!payment) throw conflict('not_paid', 'This booking has no confirmed payment to refund.');
    const existing = await RefundModel.find({ bookingId, status: { $in: ['requested', 'approved', 'completed'] } }, { amountRwf: 1 }, { session }).lean();
    const committed = existing.reduce((s, r) => s + r.amountRwf, 0);
    if (amountRwf > payment.amountRwf - committed) {
      throw badRequest('refund_too_large', `At most ${payment.amountRwf - committed} RWF can still be refunded on this booking.`);
    }
    const [r] = await RefundModel.create([{ bookingId, bookingRef: b.ref, paymentId: payment._id, amountRwf, reason, source: 'staff_request', requestedBy: staff.id }], { session });
    await recordAudit({ actor: { type: 'user', id: staff.id, roles: staff.roles }, action: 'refund.requested', targetType: 'refund', targetId: String(r!._id), after: { amountRwf, reason, bookingRef: b.ref } }, session);
    return r!;
  });
}

/**
 * Approve: never by the person who requested it. The refund is sent through the
 * payment provider; only a provider-confirmed refund is posted to the ledger.
 */
export async function approveRefund(refundId: string, approver: { id: string; roles: string[] }, note: string | null) {
  const r = await RefundModel.findById(refundId).lean();
  if (!r) throw notFound('Refund not found.');
  if (r.status !== 'requested') throw conflict('not_requested', `This refund is already ${r.status}.`);
  if (r.requestedBy && String(r.requestedBy) === approver.id) throw forbidden('You cannot approve a refund you requested. Another person must approve it.');
  const claimed = await RefundModel.findOneAndUpdate({ _id: refundId, status: 'requested' }, { $set: { status: 'approved', decidedBy: approver.id, decidedAt: new Date(), decisionNote: note } }, { new: true }).lean();
  if (!claimed) throw conflict('not_requested', 'This refund was decided by someone else just now.');
  await recordAudit({ actor: { type: 'user', id: approver.id, roles: approver.roles }, action: 'refund.approved', targetType: 'refund', targetId: refundId, after: { amountRwf: r.amountRwf }, reason: note });

  const payment = await PaymentModel.findById(r.paymentId).lean();
  const provider = paymentProvider();
  let result: { providerRef: string; status: string };
  try {
    result = await provider.refund({ paymentProviderRef: payment!.providerRef, amountRwf: r.amountRwf, reference: `REF-${r.bookingRef}-${crypto.randomBytes(3).toString('hex')}` });
  } catch (err) {
    await RefundModel.updateOne({ _id: refundId }, { $set: { status: 'failed', failureReason: (err as Error).message.slice(0, 200) } });
    throw new AppError(502, 'refund_failed', 'The payment provider did not accept the refund. It is marked failed; try again or contact the provider.');
  }
  if (result.status !== 'successful') {
    await RefundModel.updateOne({ _id: refundId }, { $set: { status: 'failed', providerRef: result.providerRef, failureReason: `provider_${result.status}` } });
    throw new AppError(502, 'refund_failed', 'The payment provider has not confirmed the refund.');
  }
  await completeRefund(refundId, result.providerRef, provider.isDevelopment, approver);
  return RefundModel.findById(refundId).lean();
}

async function completeRefund(refundId: string, providerRef: string, isDevelopment: boolean, approver: { id: string; roles: string[] }) {
  let customerId: string | null = null;
  let ref = '';
  let amount = 0;
  await withTransaction(async (session) => {
    const r = await RefundModel.findOneAndUpdate(
      { _id: refundId, status: 'approved' },
      { $set: { status: 'completed', providerRef, providerConfirmedAt: new Date(), isDevelopment } },
      { session, new: true },
    );
    if (!r) return;
    const b = await BookingModel.findById(r.bookingId, null, { session });
    customerId = String(b!.customerId);
    ref = r.bookingRef;
    amount = r.amountRwf;
    const entries: LedgerEntryInput[] = [
      { type: 'refund', party: 'customer', partyUserId: b!.customerId, bookingId: r.bookingId, refundId: r._id, amount: r.amountRwf, externalRef: providerRef, idempotencyKey: `refund:${refundId}`, createdBy: approver.id },
    ];
    if (r.source === 'staff_request') {
      // Goodwill refund outside the cancellation policy: the platform absorbs it.
      const pay = await LedgerEntryModel.findOne({ bookingId: r.bookingId, type: 'customer_payment' }, null, { session }).lean();
      entries.push({ type: 'adjustment', party: 'platform', bookingId: r.bookingId, refundId: r._id, amount: -r.amountRwf, correctsEntryId: pay!._id, memo: 'Goodwill refund absorbed by the platform', idempotencyKey: `refund-absorbed:${refundId}`, createdBy: approver.id });
    }
    await postLedgerEntries(entries, session);
    await recordAudit({ actor: { type: 'user', id: approver.id, roles: approver.roles }, action: 'refund.completed', targetType: 'refund', targetId: refundId, after: { amountRwf: r.amountRwf, providerRef, isDevelopment } }, session);
    // A cancelled booking whose refunds are all done becomes `refunded`.
    if (b!.status === 'cancelled' && !(await RefundModel.exists({ bookingId: r.bookingId, status: { $in: ['requested', 'approved'] } }).session(session))) {
      b!.status = 'refunded';
      b!.statusHistory.push({ from: 'cancelled', to: 'refunded', at: new Date(), actorType: 'staff', by: approver.id as unknown as Types.ObjectId, reason: 'Refund confirmed by the payment provider' });
      await b!.save({ session });
      await recordAudit({ actor: { type: 'user', id: approver.id, roles: approver.roles }, action: 'booking.refunded', targetType: 'booking', targetId: String(b!._id) }, session);
    }
  });
  if (customerId) await notifyUser(customerId, 'refund.processed', { ref, amount: amount.toLocaleString('en-US') }, { dedupeKey: `refund.processed/${refundId}` });
}

export async function rejectRefund(refundId: string, approver: { id: string; roles: string[] }, note: string) {
  await withTransaction(async (session) => {
    const r = await RefundModel.findOne({ _id: refundId }, null, { session });
    if (!r) throw notFound('Refund not found.');
    if (r.status !== 'requested') throw conflict('not_requested', `This refund is already ${r.status}.`);
    if (r.requestedBy && String(r.requestedBy) === approver.id) throw forbidden('You cannot decide on a refund you requested.');
    r.status = 'rejected';
    r.decidedBy = approver.id as unknown as Types.ObjectId;
    r.decidedAt = new Date();
    r.decisionNote = note;
    await r.save({ session });
    if (r.source === 'cancellation_policy') {
      // The amount set aside for the customer stays with the platform.
      const pay = await LedgerEntryModel.findOne({ bookingId: r.bookingId, type: 'customer_payment' }, null, { session }).lean();
      await postLedgerEntries(
        [{ type: 'adjustment', party: 'platform', bookingId: r.bookingId, refundId: r._id, amount: r.amountRwf, correctsEntryId: pay!._id, memo: 'Refund rejected', idempotencyKey: `refund-rejected:${refundId}`, createdBy: approver.id }],
        session,
      );
    }
    await recordAudit({ actor: { type: 'user', id: approver.id, roles: approver.roles }, action: 'refund.rejected', targetType: 'refund', targetId: refundId, reason: note }, session);
  });
}

// ---------------------------------------------------------------------------
// Payouts (manual, confirmed by a Super Admin with the real transaction reference)
// ---------------------------------------------------------------------------

async function payoutDetails(partnerUserId: string) {
  const [driver, owner] = await Promise.all([DriverProfileModel.findOne({ userId: partnerUserId }).lean(), OwnerProfileModel.findOne({ userId: partnerUserId }).lean()]);
  return (owner?.payout ?? (driver as unknown as { payout?: unknown } | null)?.payout ?? null) as { method: string; momoPhone?: string; momoName?: string; bankName?: string; accountName?: string; accountNumber?: string } | null;
}

/** Payable earnings grouped by partner, with each booking's payment and commission for context. */
export async function payableSummary() {
  const rows = await EarningModel.find({ status: 'payable' }).sort({ createdAt: 1 }).lean();
  const byPartner = new Map<string, typeof rows>();
  for (const r of rows) byPartner.set(String(r.partnerUserId), [...(byPartner.get(String(r.partnerUserId)) ?? []), r]);
  const out = [];
  for (const [partnerUserId, items] of byPartner) {
    const user = await UserModel.findById(partnerUserId).select('firstName lastName phone email').lean();
    const bookingIds = items.map((i) => i.bookingId);
    const ledger = await LedgerEntryModel.find({ bookingId: { $in: bookingIds }, type: { $in: ['customer_payment', 'platform_commission', 'provider_fee'] } }).lean();
    out.push({
      partnerUserId,
      name: [user?.firstName, user?.lastName].filter(Boolean).join(' '),
      phone: user?.phone ?? null,
      payout: await payoutDetails(partnerUserId),
      totalRwf: items.reduce((s, i) => s + i.amountRwf, 0),
      earnings: items.map((i) => {
        const l = ledger.filter((e) => String(e.bookingId) === String(i.bookingId));
        const pick = (t: string) => l.filter((e) => e.type === t).reduce((s, e) => s + e.amount, 0);
        return { id: String(i._id), bookingRef: i.bookingRef, role: i.role, amountRwf: i.amountRwf, customerPaymentRwf: pick('customer_payment'), providerFeeRwf: pick('provider_fee'), commissionRwf: pick('platform_commission') };
      }),
    });
  }
  return out;
}

export interface PayoutInput {
  partnerUserId: string;
  earningIds: string[];
  amountRwf: number;
  method: 'momo' | 'bank';
  destination: string;
  transactionRef: string;
  idempotencyKey: string;
  note?: string | null;
}

/**
 * Record a payout made outside the platform. All or nothing: every earning must be
 * this partner's and payable, the amount must equal their sum exactly, and each
 * earning gets one payout ledger entry (unique key) so it can never be paid twice.
 * Repeating the same request (same idempotency key) returns the same payout.
 */
export async function confirmPayout(input: PayoutInput, confirmer: { id: string; roles: string[] }) {
  const again = await PayoutModel.findOne({ idempotencyKey: input.idempotencyKey }).lean();
  if (again) {
    if (String(again.partnerUserId) !== input.partnerUserId || again.amountRwf !== input.amountRwf) throw conflict('idempotency_conflict', 'This payout key was already used for a different payout.');
    return { payout: again, repeated: true };
  }
  if (!input.earningIds.length) throw badRequest('no_earnings', 'Select at least one payable earning.');
  const payout = await withTransaction(async (session) => {
    const earnings = await EarningModel.find({ _id: { $in: input.earningIds } }, null, { session }).lean();
    if (earnings.length !== new Set(input.earningIds).size) throw notFound('Some earnings were not found.');
    if (earnings.some((e) => String(e.partnerUserId) !== input.partnerUserId)) throw badRequest('wrong_partner', 'All earnings must belong to the selected partner.');
    const notPayable = earnings.filter((e) => e.status !== 'payable');
    if (notPayable.length) throw conflict('not_payable', `${notPayable.length} of the selected earnings are not payable (already paid, held or disputed).`);
    const total = earnings.reduce((s, e) => s + e.amountRwf, 0);
    if (total !== input.amountRwf) throw badRequest('amount_mismatch', `The amount must equal the selected earnings exactly: ${total} RWF.`);

    const [p] = await PayoutModel.create(
      [{ partnerUserId: input.partnerUserId, earningIds: input.earningIds, amountRwf: input.amountRwf, method: input.method, destination: input.destination, transactionRef: input.transactionRef, idempotencyKey: input.idempotencyKey, note: input.note ?? null, confirmedBy: confirmer.id, confirmedAt: new Date() }],
      { session },
    );
    const res = await EarningModel.updateMany(
      { _id: { $in: input.earningIds }, status: 'payable' },
      { $set: { status: 'paid', payoutId: p!._id }, $push: { history: { to: 'paid', at: new Date(), reason: `Payout ${input.transactionRef}` } } },
      { session },
    );
    if (res.modifiedCount !== input.earningIds.length) throw conflict('not_payable', 'Some earnings changed while recording the payout. Refresh and try again.');
    await postLedgerEntries(
      earnings.map((e) => ({
        type: 'payout' as const,
        party: e.role as 'driver' | 'vehicle_owner',
        partyUserId: e.partnerUserId,
        bookingId: e.bookingId,
        payoutId: p!._id,
        amount: e.amountRwf,
        externalRef: input.transactionRef,
        idempotencyKey: `payout:${String(e._id)}`,
        createdBy: confirmer.id,
      })),
      session,
    );
    await recordAudit(
      { actor: { type: 'user', id: confirmer.id, roles: confirmer.roles }, action: 'payout.confirmed', targetType: 'payout', targetId: String(p!._id), after: { partnerUserId: input.partnerUserId, amountRwf: input.amountRwf, method: input.method, transactionRef: input.transactionRef, earnings: input.earningIds.length } },
      session,
    );
    return p!;
  }).catch((err: { code?: number; keyPattern?: Record<string, unknown> }) => {
    if (err.code === 11000 && err.keyPattern?.transactionRef) throw conflict('duplicate_transaction', 'This transaction reference was already recorded for another payout.');
    if (err.code === 11000) throw conflict('duplicate_payout', 'This payout was already recorded.');
    throw err;
  });
  await notifyUser(input.partnerUserId, 'payout.recorded', { amount: input.amountRwf.toLocaleString('en-US'), ref: input.transactionRef }, { link: '/earnings' });
  return { payout, repeated: false };
}

// ---------------------------------------------------------------------------
// Partner view (read-only)
// ---------------------------------------------------------------------------

export async function partnerEarnings(partnerUserId: string) {
  const [earnings, payouts] = await Promise.all([
    EarningModel.find({ partnerUserId }).sort({ createdAt: -1 }).limit(500).lean(),
    PayoutModel.find({ partnerUserId }).sort({ confirmedAt: -1 }).limit(200).lean(),
  ]);
  const totals: Record<EarningStatus, number> = { pending: 0, held: 0, payable: 0, paid: 0, disputed: 0, reversed: 0 };
  for (const e of earnings) totals[e.status as EarningStatus] += e.amountRwf;
  return {
    totals,
    earnings: earnings.map((e) => ({ id: String(e._id), bookingRef: e.bookingRef, role: e.role, amountRwf: e.amountRwf, status: e.status, releaseAt: e.releaseAt, createdAt: e.createdAt })),
    payouts: payouts.map((p) => ({ id: String(p._id), amountRwf: p.amountRwf, method: p.method, transactionRef: p.transactionRef, confirmedAt: p.confirmedAt, earnings: p.earningIds.length })),
  };
}
