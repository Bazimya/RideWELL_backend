import { DocumentModel } from '../documents/document.model.js';
import { DriverProfileModel, VehicleModel } from './partner.models.js';
import { getCurrentConfig } from '../platformConfig/platformConfig.service.js';
import { notifyUser } from '../notifications/notification.service.js';
import { recordAudit } from '../audit/audit.service.js';
import type { JobDefinition } from '../jobs/scheduler.js';

const DOC_LABEL: Record<string, string> = { insurance: 'insurance', driving_licence: 'driving licence' };

async function subjectLabel(subjectType: string, subjectId: unknown): Promise<string> {
  if (subjectType === 'vehicle') {
    const v = await VehicleModel.findById(subjectId).select('plate').lean();
    return v ? `vehicle ${v.plate}` : 'your vehicle';
  }
  if (subjectType === 'driver') {
    const d = await DriverProfileModel.exists({ _id: subjectId });
    return d ? 'your driver account' : 'your account';
  }
  return 'your account';
}

/**
 * Warns owners and drivers before insurance or a licence expires (default 30 days,
 * Super Admin configurable) and tells them when it has expired. Each document is
 * warned once and notified of expiry once. Blocking does not depend on this job:
 * eligibility checks the expiry date live at assignment time.
 */
export async function runDocumentExpiryCheck(now = new Date()): Promise<{ warned: number; expired: number }> {
  const cfg = await getCurrentConfig();
  const warnDays = cfg?.values.insuranceExpiryWarningDays ?? 30;
  const horizon = new Date(now.getTime() + warnDays * 24 * 60 * 60_000);
  let warned = 0;
  let expired = 0;

  const expiring = await DocumentModel.find({
    kind: { $in: ['insurance', 'driving_licence'] },
    status: 'approved',
    expiresAt: { $gt: now, $lte: horizon },
    expiryWarningSentAt: null,
  }).lean();
  for (const d of expiring) {
    // Claim the warning first so two instances never both send it.
    const claimed = await DocumentModel.updateOne({ _id: d._id, expiryWarningSentAt: null }, { $set: { expiryWarningSentAt: now } });
    if (!claimed.modifiedCount) continue;
    await notifyUser(String(d.ownerId), 'document.expiring', {
      docLabel: DOC_LABEL[d.kind] ?? d.kind,
      subject: await subjectLabel(d.subjectType, d.subjectId),
      date: d.expiresAt!.toISOString().slice(0, 10),
    });
    warned++;
  }

  const lapsed = await DocumentModel.find({
    kind: { $in: ['insurance', 'driving_licence'] },
    status: 'approved',
    expiresAt: { $lte: now },
    expiredNoticeSentAt: null,
  }).lean();
  for (const d of lapsed) {
    const claimed = await DocumentModel.updateOne({ _id: d._id, expiredNoticeSentAt: null }, { $set: { expiredNoticeSentAt: now } });
    if (!claimed.modifiedCount) continue;
    await recordAudit({
      actor: { type: 'system', name: 'document-expiry' },
      action: 'document.expired',
      targetType: 'document',
      targetId: String(d._id),
      after: { kind: d.kind, subjectType: d.subjectType, subjectId: String(d.subjectId), expiresAt: d.expiresAt },
    });
    await notifyUser(String(d.ownerId), 'document.expired', {
      docLabel: DOC_LABEL[d.kind] ?? d.kind,
      subject: await subjectLabel(d.subjectType, d.subjectId),
    });
    expired++;
  }
  return { warned, expired };
}

export const documentExpiryJob: JobDefinition = {
  name: 'documents.expiry',
  intervalMs: 60 * 60_000,
  handler: async ({ now }) => {
    await runDocumentExpiryCheck(now);
  },
};
