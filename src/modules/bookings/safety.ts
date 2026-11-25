import { Schema, model, type Types } from 'mongoose';
import { BookingModel } from './booking.model.js';
import { canReportSafety } from './booking.views.js';
import { alertOps } from './alerts.js';
import { notifyUser } from '../notifications/notification.service.js';
import { DriverProfileModel } from '../partners/partner.models.js';
import { withTransaction } from '../../db/transaction.js';
import { recordAudit } from '../audit/audit.service.js';
import { conflict, notFound } from '../../lib/errors.js';
import { disputeBooking, undisputeBooking } from '../finance/finance.service.js';
import { holdLocationPoints, releaseLocationHold } from '../tracking/tracking.service.js';

const safetyReportSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    bookingRef: { type: String, required: true },
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reporterRole: { type: String, enum: ['customer', 'driver'], required: true },
    message: { type: String, required: true, maxlength: 2000 },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    resolution: { type: String, maxlength: 2000, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    driverReleased: { type: Boolean, default: null },
  },
  { timestamps: true, versionKey: false },
);
safetyReportSchema.index({ status: 1, createdAt: -1 });
safetyReportSchema.index({ bookingId: 1 });
export const SafetyReportModel = model('SafetyReport', safetyReportSchema, 'safetyReports');

/**
 * A customer or the assigned driver reports a safety problem on an active or
 * recent trip. Operations are alerted at once by SMS and email. A report by the
 * customer pauses the driver until a staff member reviews it (spec "Trip safety").
 */
export async function reportSafety(bookingId: string, reporter: { id: string; role: 'customer' | 'driver' }, message: string) {
  const report = await withTransaction(async (session) => {
    const b = await BookingModel.findById(bookingId, null, { session });
    if (!b) throw notFound('Booking not found.');
    const isParty = reporter.role === 'customer' ? String(b.customerId) === reporter.id : String(b.driverId) === reporter.id;
    if (!isParty) throw notFound('Booking not found.');
    if (!canReportSafety(b)) throw conflict('not_reportable', 'Safety reports can be made on active trips and up to 24 hours after a trip.');
    const [r] = await SafetyReportModel.create([{ bookingId: b._id, bookingRef: b.ref, reporterId: reporter.id, reporterRole: reporter.role, message }], { session });
    b.hasOpenSafetyReport = true;
    await b.save({ session });
    // Spec: an open report blocks the release of earnings on this booking.
    await disputeBooking(String(b._id), session);
    // Spec: location points are kept while a safety report is open.
    await holdLocationPoints(String(b._id), session);
    if (reporter.role === 'customer' && b.driverId) {
      await DriverProfileModel.updateOne(
        { userId: b.driverId },
        { $set: { 'safetyHold.active': true, 'safetyHold.since': new Date(), 'safetyHold.reportId': r!._id } },
        { session },
      );
    }
    await recordAudit(
      { actor: { type: 'user', id: reporter.id, roles: [reporter.role] }, action: 'safety.reported', targetType: 'booking', targetId: String(b._id), after: { reportId: String(r!._id), reporterRole: reporter.role } },
      session,
    );
    return r!;
  });
  await alertOps({
    type: 'safety_report',
    bookingId: report.bookingId,
    bookingRef: report.bookingRef,
    message: `${report.bookingRef}: SAFETY REPORT from the ${report.reporterRole}. Open the safety reports now.`,
    severity: 'high',
  });
  await notifyUser(String(report.reporterId), 'safety.received', { ref: report.bookingRef }, { dedupeKey: `safety.received/${report._id}` });
  return report;
}

export async function resolveSafetyReport(reportId: string, staffId: string, staffRoles: string[], resolution: string, releaseDriver: boolean) {
  await withTransaction(async (session) => {
    const r = await SafetyReportModel.findById(reportId, null, { session });
    if (!r) throw notFound('Report not found.');
    if (r.status === 'resolved') throw conflict('already_resolved', 'This report is already resolved.');
    r.status = 'resolved';
    r.resolution = resolution;
    r.resolvedBy = staffId as unknown as Types.ObjectId;
    r.resolvedAt = new Date();
    r.driverReleased = releaseDriver;
    await r.save({ session });
    const openLeft = await SafetyReportModel.countDocuments({ bookingId: r.bookingId, status: 'open' }, { session });
    if (!openLeft) {
      await BookingModel.updateOne({ _id: r.bookingId }, { $set: { hasOpenSafetyReport: false } }, { session });
      await undisputeBooking(String(r.bookingId), session);
      await releaseLocationHold(String(r.bookingId), session);
    }
    if (releaseDriver) {
      await DriverProfileModel.updateOne({ 'safetyHold.reportId': r._id }, { $set: { 'safetyHold.active': false, 'safetyHold.reportId': null } }, { session });
    }
    await recordAudit(
      { actor: { type: 'user', id: staffId, roles: staffRoles }, action: 'safety.resolved', targetType: 'booking', targetId: String(r.bookingId), after: { reportId, releaseDriver }, reason: resolution },
      session,
    );
  });
}
