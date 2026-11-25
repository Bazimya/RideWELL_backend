import { Types } from 'mongoose';
import { BookingModel } from '../bookings/booking.model.js';
import { listRow } from '../bookings/booking.views.js';
import { OpsAlertModel } from '../bookings/alerts.js';
import { SafetyReportModel } from '../bookings/safety.js';
import { RatingModel, canRate, driverRatingSummary } from '../bookings/ratings.js';
import { DriverProfileModel, OwnerProfileModel, VehicleModel } from '../partners/partner.models.js';
import { DocumentModel } from '../documents/document.model.js';
import { EarningModel, PayoutModel, RefundModel } from '../finance/finance.models.js';
import { partnerEarnings } from '../finance/finance.service.js';
import { PaymentModel } from '../payments/payment.model.js';
import { LedgerEntryModel } from '../ledger/ledger.model.js';
import { SupportRequestModel } from '../support/support.js';
import { NotificationModel } from '../notifications/notification.model.js';
import { providerNames } from '../notifications/notification.service.js';
import { UserModel } from '../users/user.model.js';
import type { Permission } from '../users/permissions.js';
import type { Role } from '../users/roles.js';

/**
 * Dashboards and reports. Every number here is computed from the live records
 * (bookings, ledger, earnings, ratings): nothing is estimated, cached or seeded.
 */

const DAY = 86_400_000;
/** Kigali is UTC+2 all year (no daylight saving). */
const KIGALI_OFFSET = 2 * 3_600_000;

/** Start of the Kigali calendar day containing `d`, as a UTC instant. */
export function kigaliDayStart(d: Date): Date {
  const local = d.getTime() + KIGALI_OFFSET;
  return new Date(local - (local % DAY) - KIGALI_OFFSET);
}
/** YYYY-MM-DD of the Kigali day containing `d`. */
export const kigaliDate = (d: Date) => new Date(d.getTime() + KIGALI_OFFSET).toISOString().slice(0, 10);
/** UTC instant at which Kigali day `yyyy-mm-dd` starts. */
export const fromKigaliDate = (s: string) => new Date(Date.parse(`${s}T00:00:00Z`) - KIGALI_OFFSET);

const ACTIVE = ['requested', 'quoted', 'paid', 'assigned', 'in_progress'];
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const oid = (id: string) => new Types.ObjectId(id);

// ===========================================================================
// Customer and partner home
// ===========================================================================

async function expiringDocuments(userId: string, now: Date) {
  return DocumentModel.countDocuments({ ownerId: userId, status: 'approved', expiresAt: { $ne: null, $lte: new Date(now.getTime() + 30 * DAY) } });
}

export async function myDashboard(userId: string, roles: Role[], now = new Date()) {
  const out: Record<string, unknown> = {};

  // ---- customer -----------------------------------------------------------
  const mine = await BookingModel.find({ customerId: userId }).sort({ startAt: -1 }).limit(200);
  const upcoming = mine.filter((b) => ACTIVE.includes(b.status)).sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const completed = mine.filter((b) => b.status === 'completed');
  const rated = new Set((await RatingModel.find({ bookingId: { $in: completed.map((b) => b._id) } }).select('bookingId').lean()).map((r) => String(r.bookingId)));
  const actions: Array<{ kind: 'pay_quote' | 'rate_driver'; bookingId: string; ref: string; until: Date | null }> = [];
  for (const b of mine) {
    if (b.status === 'quoted' && b.quote && b.quote.validUntil > now) actions.push({ kind: 'pay_quote', bookingId: String(b._id), ref: b.ref, until: b.quote.validUntil });
    if (canRate(b, now) && !rated.has(String(b._id))) actions.push({ kind: 'rate_driver', bookingId: String(b._id), ref: b.ref, until: new Date(b.endedAt!.getTime() + 14 * DAY) });
  }
  out.customer = {
    upcoming: upcoming.slice(0, 5).map(listRow),
    actions,
    totals: { bookings: mine.length, completed: completed.length, active: upcoming.length },
    openSupport: await SupportRequestModel.countDocuments({ userId, status: 'open' }),
  };

  // ---- driver -------------------------------------------------------------
  if (roles.includes('driver_partner')) {
    const profile = await DriverProfileModel.findOne({ userId }).select('status availability safetyHold').lean();
    const trips = await BookingModel.find({ driverId: userId, status: { $in: ['paid', 'assigned', 'in_progress', 'completed'] } }).sort({ startAt: 1 }).limit(500);
    const offers = trips.filter((b) => b.status === 'paid' && !b.acceptance?.driverAcceptedAt);
    const next = trips.find((b) => (b.status === 'assigned' || b.status === 'in_progress') && b.endAt > now);
    const monthStart = fromKigaliDate(`${kigaliDate(now).slice(0, 7)}-01`);
    const earnings = await partnerEarnings(userId);
    out.driver = {
      profileStatus: profile?.status ?? 'draft',
      acceptingTrips: Boolean(profile?.availability?.acceptingTrips),
      onSafetyHold: Boolean((profile as { safetyHold?: { active?: boolean } } | null)?.safetyHold?.active),
      offers: offers.map((b) => ({ id: String(b._id), ref: b.ref, startAt: b.startAt, deadline: b.acceptance?.deadline ?? null })),
      next: next ? { id: String(next._id), ref: next.ref, status: next.status, startAt: next.startAt, service: next.service } : null,
      upcomingCount: trips.filter((b) => b.status === 'assigned' && b.startAt > now).length,
      completedThisMonth: trips.filter((b) => b.status === 'completed' && b.endedAt && b.endedAt >= monthStart).length,
      completedAllTime: trips.filter((b) => b.status === 'completed').length,
      earnings: earnings.totals,
      rating: await driverRatingSummary(userId).then((r) => ({ average: r.average, count: r.count })),
      expiringDocuments: await expiringDocuments(userId, now),
    };
  }

  // ---- vehicle owner ------------------------------------------------------
  if (roles.includes('vehicle_partner')) {
    const profile = await OwnerProfileModel.findOne({ userId }).select('status').lean();
    const vehicles = await VehicleModel.find({ ownerUserId: userId }).select('make model plate status').lean();
    const trips = await BookingModel.find({ vehicleOwnerId: userId, status: { $in: ['paid', 'assigned', 'in_progress', 'completed'] } }).sort({ startAt: 1 }).limit(500);
    const earnings = await partnerEarnings(userId);
    out.owner = {
      profileStatus: profile?.status ?? 'draft',
      vehicles: vehicles.map((v) => ({ id: String(v._id), label: `${v.make} ${v.model} · ${v.plate}`, status: v.status })),
      offers: trips.filter((b) => b.status === 'paid' && !b.acceptance?.vehicleAcceptedAt).map((b) => ({ id: String(b._id), ref: b.ref, startAt: b.startAt, deadline: b.acceptance?.deadline ?? null })),
      inProgress: trips.filter((b) => b.status === 'in_progress').length,
      upcomingCount: trips.filter((b) => b.status === 'assigned' && b.startAt > now).length,
      completedAllTime: trips.filter((b) => b.status === 'completed').length,
      earnings: earnings.totals,
      expiringDocuments: await expiringDocuments(userId, now),
    };
  }
  return out;
}

// ===========================================================================
// Staff overview: what needs doing now. Each section only with its permission.
// ===========================================================================

export async function staffDashboard(permissions: readonly Permission[], now = new Date()) {
  const can = (p: Permission) => permissions.includes(p);
  const out: Record<string, unknown> = { generatedAt: now };

  if (can('bookings.view')) {
    const dayStart = kigaliDayStart(now);
    const dayEnd = new Date(dayStart.getTime() + DAY);
    const [requested, quoted, awaitingAcceptance, needsReassignment, inProgress, today, openAlerts, recentAlerts] = await Promise.all([
      BookingModel.countDocuments({ status: 'requested' }),
      BookingModel.countDocuments({ status: 'quoted', 'quote.validUntil': { $gt: now } }),
      BookingModel.countDocuments({ status: 'paid', 'attention.needsReassignment': { $ne: true } }),
      BookingModel.countDocuments({ status: { $in: ['paid', 'assigned'] }, 'attention.needsReassignment': true }),
      BookingModel.countDocuments({ status: 'in_progress' }),
      BookingModel.find({ startAt: { $gte: dayStart, $lt: dayEnd }, status: { $in: ['paid', 'assigned', 'in_progress', 'completed'] } }).sort({ startAt: 1 }).limit(50),
      OpsAlertModel.countDocuments({ resolvedAt: null }),
      OpsAlertModel.find({ resolvedAt: null }).sort({ createdAt: -1 }).limit(5).lean(),
    ]);
    out.bookings = {
      awaitingQuote: requested,
      awaitingPayment: quoted,
      awaitingAcceptance,
      needsReassignment,
      inProgress,
      today: today.map(listRow),
      openAlerts,
      recentAlerts: recentAlerts.map((a) => ({ id: String(a._id), type: a.type, severity: a.severity, bookingId: a.bookingId ? String(a.bookingId) : null, bookingRef: a.bookingRef ?? null, message: a.message, createdAt: a.createdAt })),
    };
  }
  if (can('safety.handle')) out.safety = { openReports: await SafetyReportModel.countDocuments({ status: 'open' }) };
  if (can('support.handle')) {
    const oldest = await SupportRequestModel.findOne({ status: 'open' }).sort({ createdAt: 1 }).select('createdAt').lean();
    out.support = { open: await SupportRequestModel.countDocuments({ status: 'open' }), oldestOpenAt: oldest?.createdAt ?? null };
  }
  if (can('partners.view')) {
    const waiting = { status: { $in: ['applied', 'under_review'] } };
    const [drivers, owners, vehicles, pendingDocs, expiring] = await Promise.all([
      DriverProfileModel.countDocuments(waiting),
      OwnerProfileModel.countDocuments(waiting),
      VehicleModel.countDocuments(waiting),
      DocumentModel.countDocuments({ status: 'pending' }),
      DocumentModel.countDocuments({ status: 'approved', expiresAt: { $ne: null, $gte: now, $lte: new Date(now.getTime() + 30 * DAY) } }),
    ]);
    out.partners = { applications: { drivers, owners, vehicles }, documentsToReview: pendingDocs, documentsExpiring30Days: expiring };
  }
  if (can('finance.view') || can('refunds.approve') || can('payouts.confirm')) {
    const [refunds, payable, dev] = await Promise.all([
      RefundModel.countDocuments({ status: 'requested' }),
      EarningModel.aggregate([{ $match: { status: 'payable' } }, { $group: { _id: '$partnerUserId', t: { $sum: '$amountRwf' } } }]),
      PaymentModel.countDocuments({ isDevelopment: true, status: 'successful' }),
    ]);
    out.finance = { refundsAwaitingApproval: refunds, payableRwf: payable.reduce((s, p) => s + p.t, 0), payablePartners: payable.length, developmentPayments: dev };
  }
  if (can('notifications.view')) {
    const since = new Date(now.getTime() - 7 * DAY);
    out.notifications = {
      providers: providerNames(),
      failedLast7Days: await NotificationModel.countDocuments({ status: 'failed', createdAt: { $gte: since } }),
      pending: await NotificationModel.countDocuments({ status: 'pending' }),
    };
  }
  return out;
}

// ===========================================================================
// Reports over a Kigali date range [from, to] inclusive.
// ===========================================================================

export interface Range {
  from: string;
  to: string;
}
function bounds(r: Range) {
  return { start: fromKigaliDate(r.from), end: new Date(fromKigaliDate(r.to).getTime() + DAY) };
}
function days(r: Range): string[] {
  const out: string[] = [];
  const { start, end } = bounds(r);
  for (let t = start.getTime(); t < end.getTime(); t += DAY) out.push(kigaliDate(new Date(t)));
  return out;
}
const countBy = <T>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {});

/** Operational report (brief: Operations Admin "operational reports"). */
export async function operationsReport(range: Range) {
  const { start, end } = bounds(range);
  const created = await BookingModel.find({ createdAt: { $gte: start, $lt: end } }).select('ref service channel status statusHistory createdAt cancellation declines').lean();
  const completed = await BookingModel.find({ status: 'completed', endedAt: { $gte: start, $lt: end } }).select('service driverId startedAt endedAt').lean();

  const reached = (b: (typeof created)[number], s: string) => b.statusHistory.some((h) => h.to === s);
  const firstAt = (b: (typeof created)[number], s: string) => b.statusHistory.find((h) => h.to === s)?.at;
  const minutes = (a?: Date | null, b?: Date | null) => (a && b ? Math.round((b.getTime() - a.getTime()) / 60_000) : null);
  const toQuote = created.map((b) => minutes(b.createdAt, firstAt(b, 'quoted'))).filter((m): m is number => m !== null);
  const toAssign = created.map((b) => minutes(firstAt(b, 'paid'), firstAt(b, 'assigned'))).filter((m): m is number => m !== null);
  const cancelled = created.filter((b) => reached(b, 'cancelled'));

  const [alerts, safety, ratings] = await Promise.all([
    OpsAlertModel.aggregate([{ $match: { createdAt: { $gte: start, $lt: end } } }, { $group: { _id: '$type', n: { $sum: 1 } } }]),
    SafetyReportModel.countDocuments({ createdAt: { $gte: start, $lt: end } }),
    RatingModel.find({ createdAt: { $gte: start, $lt: end } }).select('stars toUserId').lean(),
  ]);

  // Per driver: completed trips and hours in range, declines in range, average rating in range.
  const drivers = new Map<string, { completed: number; hours: number; declines: number; stars: number[] }>();
  const row = (id: string) => drivers.get(id) ?? (drivers.set(id, { completed: 0, hours: 0, declines: 0, stars: [] }), drivers.get(id)!);
  for (const b of completed) {
    if (!b.driverId) continue;
    const d = row(String(b.driverId));
    d.completed++;
    if (b.startedAt && b.endedAt) d.hours += (b.endedAt.getTime() - b.startedAt.getTime()) / 3_600_000;
  }
  const declined = await BookingModel.find({ 'declines.at': { $gte: start, $lt: end }, 'declines.role': 'driver' }).select('declines').lean();
  for (const b of declined) for (const d of b.declines) if (d.role === 'driver' && d.by && d.at && d.at >= start && d.at < end) row(String(d.by)).declines++;
  for (const r of ratings) row(String(r.toUserId)).stars.push(r.stars);
  const names = await UserModel.find({ _id: { $in: [...drivers.keys()].map(oid) } }).select('firstName lastName').lean();
  const nameOf = new Map(names.map((u) => [String(u._id), [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Driver']));

  const series = days(range).map((date) => ({ date, requests: 0, completed: 0 }));
  const idx = new Map(series.map((s, i) => [s.date, i]));
  for (const b of created) {
    const i = idx.get(kigaliDate(b.createdAt));
    if (i !== undefined) series[i]!.requests++;
  }
  for (const b of completed) {
    const i = idx.get(kigaliDate(b.endedAt!));
    if (i !== undefined) series[i]!.completed++;
  }
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

  return {
    range,
    requests: {
      total: created.length,
      byService: countBy(created, (b) => b.service),
      byChannel: countBy(created, (b) => b.channel),
      byCurrentStatus: countBy(created, (b) => b.status),
    },
    // Of the requests made in the range, how many reached each stage (so far).
    funnel: {
      requested: created.length,
      quoted: created.filter((b) => reached(b, 'quoted')).length,
      paid: created.filter((b) => reached(b, 'paid')).length,
      assigned: created.filter((b) => reached(b, 'assigned')).length,
      completed: created.filter((b) => reached(b, 'completed')).length,
      cancelled: cancelled.length,
      expired: created.filter((b) => reached(b, 'expired')).length,
    },
    medianMinutes: { requestToQuote: median(toQuote), paymentToAssigned: median(toAssign) },
    cancellationsBy: countBy(cancelled, (b) => b.cancellation?.actorType ?? 'unknown'),
    trips: {
      completed: completed.length,
      byService: countBy(completed, (b) => b.service),
      hours: Math.round(completed.reduce((s, b) => s + (b.startedAt && b.endedAt ? (b.endedAt.getTime() - b.startedAt.getTime()) / 3_600_000 : 0), 0) * 10) / 10,
    },
    alerts: Object.fromEntries(alerts.map((a) => [a._id, a.n])),
    safetyReports: safety,
    ratings: { count: ratings.length, average: avg(ratings.map((r) => r.stars)), low: ratings.filter((r) => r.stars <= 2).length },
    drivers: [...drivers.entries()]
      .map(([id, d]) => ({ id, name: nameOf.get(id) ?? 'Driver', completed: d.completed, hours: Math.round(d.hours * 10) / 10, declines: d.declines, ratings: d.stars.length, averageRating: avg(d.stars) }))
      .sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name)),
    series,
  };
}

/**
 * Financial report (Super Admin "financial reports"), from the ledger. Amounts are
 * split into real money and development payments, which moved no money.
 */
export async function financeReport(range: Range) {
  const { start, end } = bounds(range);
  const entries = await LedgerEntryModel.find({ createdAt: { $gte: start, $lt: end } }).sort({ createdAt: 1 }).lean();
  // Payout entries carry no booking: reach their bookings through the earnings they paid.
  const payoutIds = entries.filter((e) => e.type === 'payout' && e.payoutId).map((e) => e.payoutId!);
  const payouts = payoutIds.length ? await PayoutModel.find({ _id: { $in: payoutIds } }).select('earningIds').lean() : [];
  const paidEarnings = payouts.length ? await EarningModel.find({ _id: { $in: payouts.flatMap((p) => p.earningIds) } }).select('bookingId').lean() : [];
  const earningBooking = new Map(paidEarnings.map((e) => [String(e._id), String(e.bookingId)]));
  const payoutBookings = new Map(payouts.map((p) => [String(p._id), p.earningIds.map((id) => earningBooking.get(String(id))).filter((b): b is string => Boolean(b))]));

  const bookingIds = [...new Set([...entries.filter((e) => e.bookingId).map((e) => String(e.bookingId)), ...[...payoutBookings.values()].flat()])];
  const [bookings, devPayments] = await Promise.all([
    BookingModel.find({ _id: { $in: bookingIds.map(oid) } }).select('ref service').lean(),
    PaymentModel.find({ bookingId: { $in: bookingIds.map(oid) }, isDevelopment: true, status: 'successful' }).select('bookingId').lean(),
  ]);
  const bookingOf = new Map(bookings.map((b) => [String(b._id), b]));
  const devBookings = new Set(devPayments.map((p) => String(p.bookingId)));
  // Development = the money came from a development payment. A payout is development when every earning it paid was.
  const isDev = (e: (typeof entries)[number]) => {
    if (e.bookingId) return devBookings.has(String(e.bookingId));
    if (e.type === 'payout' && e.payoutId) {
      const bs = payoutBookings.get(String(e.payoutId)) ?? [];
      return bs.length > 0 && bs.every((b) => devBookings.has(b));
    }
    return false;
  };

  const blank = () => ({ customerPaymentsRwf: 0, refundsRwf: 0, providerFeesRwf: 0, platformCommissionRwf: 0, platformAdjustmentsRwf: 0, driverEarningsRwf: 0, vehicleOwnerEarningsRwf: 0, partnerAdjustmentsRwf: 0, payoutsRwf: 0, platformNetRwf: 0 });
  type Totals = ReturnType<typeof blank>;
  const add = (t: Totals, e: (typeof entries)[number]) => {
    switch (e.type) {
      case 'customer_payment': t.customerPaymentsRwf += e.amount; break;
      case 'refund': t.refundsRwf += e.amount; break;
      case 'provider_fee': t.providerFeesRwf += e.amount; break;
      case 'platform_commission': t.platformCommissionRwf += e.amount; break;
      case 'driver_earning': t.driverEarningsRwf += e.amount; break;
      case 'vehicle_owner_earning': t.vehicleOwnerEarningsRwf += e.amount; break;
      case 'payout': t.payoutsRwf += e.amount; break;
      case 'adjustment':
      case 'reversal':
        if (e.party === 'platform') t.platformAdjustmentsRwf += e.amount;
        else if (e.party === 'driver' || e.party === 'vehicle_owner') t.partnerAdjustmentsRwf += e.amount;
        break;
    }
    t.platformNetRwf = t.platformCommissionRwf + t.platformAdjustmentsRwf;
  };
  const real = blank();
  const development = blank();
  const byService: Record<string, Totals> = {};
  const series = days(range).map((date) => ({ date, paymentsRwf: 0, refundsRwf: 0, platformNetRwf: 0 }));
  const idx = new Map(series.map((s, i) => [s.date, i]));
  for (const e of entries) {
    const dev = isDev(e);
    add(dev ? development : real, e);
    if (dev) continue; // service split and daily series show real money only
    const svc = e.bookingId ? (bookingOf.get(String(e.bookingId))?.service ?? 'unknown') : 'none';
    add((byService[svc] ??= blank()), e);
    const i = idx.get(kigaliDate(e.createdAt));
    if (i === undefined) continue;
    if (e.type === 'customer_payment') series[i]!.paymentsRwf += e.amount;
    if (e.type === 'refund') series[i]!.refundsRwf += e.amount;
    if (e.type === 'platform_commission' || ((e.type === 'adjustment' || e.type === 'reversal') && e.party === 'platform')) series[i]!.platformNetRwf += e.amount;
  }
  delete byService.none;

  // Snapshot now (not range-bound): what is owed to partners.
  const owed = await EarningModel.aggregate([{ $match: { status: { $in: ['pending', 'held', 'payable', 'disputed'] } } }, { $group: { _id: '$status', t: { $sum: '$amountRwf' } } }]);

  return {
    range,
    real,
    development,
    developmentBookings: devBookings.size,
    byService,
    owedToPartnersNow: Object.fromEntries(['pending', 'held', 'payable', 'disputed'].map((s) => [s, owed.find((o) => o._id === s)?.t ?? 0])),
    entries: entries.length,
    series,
    rows: entries.map((e) => ({
      at: e.createdAt,
      type: e.type,
      party: e.party,
      amountRwf: e.amount,
      bookingRef: e.bookingId ? (bookingOf.get(String(e.bookingId))?.ref ?? null) : null,
      service: e.bookingId ? (bookingOf.get(String(e.bookingId))?.service ?? null) : null,
      externalRef: e.externalRef ?? null,
      memo: e.memo ?? null,
      development: isDev(e),
    })),
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formulas (CSV injection) and quote everything.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+$/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** Accountant export: one row per ledger entry in the range. */
export function financeCsv(report: Awaited<ReturnType<typeof financeReport>>): string {
  const head = ['date_kigali', 'at_utc', 'type', 'party', 'amount_rwf', 'booking_ref', 'service', 'external_ref', 'memo', 'development_no_money_moved'];
  const lines = report.rows.map((r) => [kigaliDate(r.at), r.at, r.type, r.party, r.amountRwf, r.bookingRef, r.service, r.externalRef, r.memo, r.development ? 'yes' : 'no'].map(csvCell).join(','));
  return `${head.join(',')}\r\n${lines.join('\r\n')}${lines.length ? '\r\n' : ''}`;
}
