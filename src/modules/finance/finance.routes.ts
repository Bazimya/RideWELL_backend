import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, requireFreshTotp, requirePermission, requireRole } from '../../middleware/auth.js';
import { validate, valid, objectIdSchema } from '../../lib/validate.js';
import { phoneSchema } from '../../lib/phone.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { EarningModel, PayoutModel, RefundModel, REFUND_STATUSES } from './finance.models.js';
import { approveRefund, bookingBalance, confirmPayout, partnerEarnings, payableSummary, rejectRefund, requestRefund, type PayoutInput } from './finance.service.js';
import { LedgerEntryModel, LEDGER_TYPES } from '../ledger/ledger.model.js';
import { PaymentModel } from '../payments/payment.model.js';
import { DriverProfileModel, OwnerProfileModel } from '../partners/partner.models.js';
import { auditContext, recordAudit } from '../audit/audit.service.js';
import type { JobDefinition } from '../jobs/scheduler.js';
import { releaseDueEarnings } from './finance.service.js';
import { confirmPayment } from '../payments/payment.service.js';

const idParam = z.strictObject({ id: objectIdSchema });
const staffOf = (req: Request) => ({ id: req.auth!.user.id, roles: req.auth!.user.roles });

function entryView(e: { _id: unknown; type: string; party: string; partyUserId?: unknown; bookingId?: unknown; amount: number; externalRef?: string | null; memo?: string | null; createdAt: Date; createdBy?: unknown; createdBySystem?: string | null; idempotencyKey: string }) {
  return {
    id: String(e._id),
    type: e.type,
    party: e.party,
    partyUserId: e.partyUserId ? String(e.partyUserId) : null,
    bookingId: e.bookingId ? String(e.bookingId) : null,
    amountRwf: e.amount,
    externalRef: e.externalRef ?? null,
    memo: e.memo ?? null,
    createdAt: e.createdAt,
    createdBy: e.createdBy ? String(e.createdBy) : (e.createdBySystem ?? null),
  };
}

// ===========================================================================
// Staff: /admin/finance
// ===========================================================================

export function adminFinanceRouter(): Router {
  const r = Router();
  r.use(authenticate, (req, _res, next) => (req.auth!.sessionKind === 'admin' ? next() : next(forbidden())));

  r.get('/summary', requirePermission('finance.view'), async (_req, res) => {
    const sum = async (type: string) => (await LedgerEntryModel.aggregate([{ $match: { type } }, { $group: { _id: null, t: { $sum: '$amount' } } }]))[0]?.t ?? 0;
    const byStatus = await EarningModel.aggregate([{ $group: { _id: '$status', t: { $sum: '$amountRwf' }, n: { $sum: 1 } } }]);
    const commission = (await sum('platform_commission')) + (await LedgerEntryModel.aggregate([{ $match: { party: 'platform', type: { $in: ['adjustment', 'reversal'] } } }, { $group: { _id: null, t: { $sum: '$amount' } } }]))[0]?.t;
    res.json({
      customerPaymentsRwf: await sum('customer_payment'),
      refundsRwf: await sum('refund'),
      providerFeesRwf: await sum('provider_fee'),
      platformNetRwf: commission ?? 0,
      payoutsRwf: await sum('payout'),
      earnings: Object.fromEntries(byStatus.map((s) => [s._id, { amountRwf: s.t, count: s.n }])),
      openRefunds: await RefundModel.countDocuments({ status: 'requested' }),
      developmentPayments: await PaymentModel.countDocuments({ isDevelopment: true, status: 'successful' }),
    });
  });

  r.get(
    '/ledger',
    requirePermission('finance.view'),
    validate({
      query: z.strictObject({
        bookingId: objectIdSchema.optional(),
        partyUserId: objectIdSchema.optional(),
        type: z.enum(LEDGER_TYPES).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: objectIdSchema.optional(),
      }),
    }),
    async (req, res) => {
      const q = valid<{ bookingId?: string; partyUserId?: string; type?: string; limit: number; before?: string }>(req, 'query');
      const filter: Record<string, unknown> = {};
      if (q.bookingId) filter.bookingId = q.bookingId;
      if (q.partyUserId) filter.partyUserId = q.partyUserId;
      if (q.type) filter.type = q.type;
      if (q.before) filter._id = { $lt: q.before };
      const rows = await LedgerEntryModel.find(filter).sort({ _id: -1 }).limit(q.limit).lean();
      res.json({ entries: rows.map(entryView), nextBefore: rows.length === q.limit ? String(rows[rows.length - 1]!._id) : null });
    },
  );

  r.get('/bookings/:id', requirePermission('finance.view', 'refunds.request', 'refunds.approve'), validate({ params: idParam }), async (req, res) => {
    const { id } = valid<{ id: string }>(req, 'params');
    const [entries, earnings, refunds] = await Promise.all([
      LedgerEntryModel.find({ bookingId: id }).sort({ _id: 1 }).lean(),
      EarningModel.find({ bookingId: id }).sort({ createdAt: 1 }).lean(),
      RefundModel.find({ bookingId: id }).sort({ createdAt: 1 }).lean(),
    ]);
    res.json({
      balance: await bookingBalance(id),
      entries: entries.map(entryView),
      earnings: earnings.map((e) => ({ id: String(e._id), role: e.role, partnerUserId: String(e.partnerUserId), amountRwf: e.amountRwf, status: e.status, releaseAt: e.releaseAt, history: e.history })),
      refunds: refunds.map((x) => ({ id: String(x._id), amountRwf: x.amountRwf, status: x.status, source: x.source, reason: x.reason, requestedBy: x.requestedBy ? String(x.requestedBy) : null, decisionNote: x.decisionNote, createdAt: x.createdAt })),
    });
  });

  // ---- refunds ------------------------------------------------------------------

  r.get(
    '/refunds',
    requirePermission('finance.view', 'refunds.request', 'refunds.approve'),
    validate({ query: z.strictObject({ status: z.enum(REFUND_STATUSES).default('requested') }) }),
    async (req, res) => {
      const rows = await RefundModel.find({ status: valid<{ status: string }>(req, 'query').status }).sort({ createdAt: 1 }).limit(200).lean();
      res.json({
        refunds: rows.map((x) => ({
          id: String(x._id),
          bookingId: String(x.bookingId),
          bookingRef: x.bookingRef,
          amountRwf: x.amountRwf,
          reason: x.reason,
          source: x.source,
          status: x.status,
          requestedBy: x.requestedBy ? String(x.requestedBy) : null,
          isDevelopment: x.isDevelopment,
          providerRef: x.providerRef,
          decisionNote: x.decisionNote,
          createdAt: x.createdAt,
        })),
      });
    },
  );

  r.post(
    '/refunds',
    requirePermission('refunds.request'),
    validate({ body: z.strictObject({ bookingId: objectIdSchema, amountRwf: z.number().int().min(1).max(100_000_000), reason: z.string().trim().min(3).max(500) }) }),
    async (req, res) => {
      const b = valid<{ bookingId: string; amountRwf: number; reason: string }>(req, 'body');
      const refund = await requestRefund(b.bookingId, b.amountRwf, b.reason, staffOf(req));
      res.status(201).json({ id: String(refund._id), status: refund.status });
    },
  );

  r.post('/refunds/:id/approve', requirePermission('refunds.approve'), requireFreshTotp, validate({ params: idParam, body: z.strictObject({ note: z.string().trim().max(500).nullable().optional() }) }), async (req, res) => {
    const out = await approveRefund(valid<{ id: string }>(req, 'params').id, staffOf(req), valid<{ note?: string | null }>(req, 'body').note ?? null);
    res.json({ status: out?.status, providerRef: out?.providerRef, isDevelopment: out?.isDevelopment });
  });

  r.post('/refunds/:id/reject', requirePermission('refunds.approve'), requireFreshTotp, validate({ params: idParam, body: z.strictObject({ note: z.string().trim().min(3).max(500) }) }), async (req, res) => {
    await rejectRefund(valid<{ id: string }>(req, 'params').id, staffOf(req), valid<{ note: string }>(req, 'body').note);
    res.status(204).end();
  });

  // ---- payouts ------------------------------------------------------------------

  r.get('/payables', requirePermission('payouts.confirm', 'finance.view'), async (_req, res) => {
    res.json({ partners: await payableSummary() });
  });

  r.get('/payouts', requirePermission('finance.view', 'payouts.confirm'), async (_req, res) => {
    const rows = await PayoutModel.find({}).sort({ confirmedAt: -1 }).limit(200).lean();
    res.json({
      payouts: rows.map((p) => ({ id: String(p._id), partnerUserId: String(p.partnerUserId), amountRwf: p.amountRwf, method: p.method, destination: p.destination, transactionRef: p.transactionRef, earnings: p.earningIds.length, confirmedAt: p.confirmedAt, confirmedBy: String(p.confirmedBy) })),
    });
  });

  r.post(
    '/payouts',
    requirePermission('payouts.confirm'),
    requireFreshTotp,
    validate({
      body: z.strictObject({
        partnerUserId: objectIdSchema,
        earningIds: z.array(objectIdSchema).min(1).max(500),
        amountRwf: z.number().int().min(1).max(1_000_000_000),
        method: z.enum(['momo', 'bank']),
        destination: z.string().trim().min(3).max(200),
        transactionRef: z.string().trim().min(4).max(100),
        idempotencyKey: z.string().trim().min(8).max(100),
        note: z.string().trim().max(500).nullable().optional(),
      }),
    }),
    async (req, res) => {
      const result = await confirmPayout(valid<PayoutInput>(req, 'body'), staffOf(req));
      res.status(result.repeated ? 200 : 201).json({ id: String(result.payout._id), repeated: result.repeated });
    },
  );

  return r;
}

// ===========================================================================
// Partners: /partners/earnings (read-only) and payout details
// ===========================================================================

export function partnerFinanceRouter(): Router {
  const r = Router();
  const partnerOnly = [authenticate, requireRole('driver_partner', 'vehicle_partner')];

  r.get('/earnings', ...partnerOnly, async (req, res) => {
    res.json(await partnerEarnings(req.auth!.user.id));
  });

  // Payout details can be updated at any time (not only during the application), except while suspended.
  r.put(
    '/payout-details',
    authenticate,
    validate({
      body: z.strictObject({
        role: z.enum(['driver', 'owner']),
        payout: z.discriminatedUnion('method', [
          z.strictObject({ method: z.literal('momo'), momoPhone: phoneSchema, momoName: z.string().trim().min(1).max(120) }),
          z.strictObject({ method: z.literal('bank'), bankName: z.string().trim().min(1).max(120), accountName: z.string().trim().min(1).max(120), accountNumber: z.string().trim().regex(/^[0-9A-Za-z-]{5,40}$/) }),
        ]),
      }),
    }),
    async (req, res) => {
      if (req.auth!.sessionKind !== 'user') throw forbidden();
      const body = valid<{ role: 'driver' | 'owner'; payout: Record<string, string> }>(req, 'body');
      const Model = (body.role === 'driver' ? DriverProfileModel : OwnerProfileModel) as unknown as typeof DriverProfileModel;
      const profile = await Model.findOne({ userId: req.auth!.user.id });
      if (!profile) throw notFound('Apply as a partner first.');
      if (profile.status === 'suspended') throw conflict('suspended', 'Payout details cannot be changed while the account is paused.');
      profile.set('payout', body.payout);
      await profile.save();
      await recordAudit({
        actor: { type: 'user', id: req.auth!.user.id, roles: req.auth!.user.roles },
        action: 'partner.payout_details_changed',
        targetType: body.role,
        targetId: String(profile._id),
        after: { method: body.payout.method },
        ...auditContext(req),
      });
      res.json({ payout: profile.get('payout') });
    },
  );

  return r;
}

// ===========================================================================
// Jobs
// ===========================================================================

export const financeJobs: JobDefinition[] = [
  { name: 'finance.release-earnings', intervalMs: 5 * 60_000, handler: async ({ now }) => void (await releaseDueEarnings(now)) },
  {
    // Brief §4.7: re-check payments stuck in pending for more than 15 minutes.
    name: 'payments.recheck-pending',
    intervalMs: 5 * 60_000,
    handler: async ({ now }) => {
      const stuck = await PaymentModel.find({ status: 'pending', createdAt: { $lte: new Date(now.getTime() - 15 * 60_000) } }).limit(100).lean();
      for (const p of stuck) await confirmPayment(p.providerRef, 'stuck-recheck').catch(() => undefined);
    },
  },
];
