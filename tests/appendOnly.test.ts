import { describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { AuditLogModel } from '../src/modules/audit/audit.model.js';
import { recordAudit } from '../src/modules/audit/audit.service.js';
import { LedgerEntryModel } from '../src/modules/ledger/ledger.model.js';
import { PlatformConfigModel } from '../src/modules/platformConfig/platformConfig.model.js';
import { AppendOnlyViolation } from '../src/db/appendOnly.js';
import { postLedgerEntries } from '../src/modules/ledger/ledger.service.js';
import { withTransaction } from '../src/db/transaction.js';
import { API, bearer, createActiveAdmin, signInAdmin, testApp } from './helpers.js';

const app = testApp();

async function seedEntries() {
  await recordAudit({ actor: { type: 'system', name: 'test' }, action: 'test.event', targetType: 'test', targetId: '1' });
  await withTransaction((session) =>
    postLedgerEntries([{ type: 'customer_payment', party: 'customer', amount: 1000, idempotencyKey: 'k1', createdBySystem: 'test' }], session),
  );
}

describe('append-only collections', () => {
  const models = [
    ['auditLogs', AuditLogModel],
    ['ledger', LedgerEntryModel],
    ['platformConfigs', PlatformConfigModel],
  ] as const;

  for (const [name, Model] of models) {
    it(`${name}: refuses every kind of update and delete through the model`, async () => {
      await seedEntries();
      const M = Model as unknown as mongoose.Model<Record<string, unknown>>;
      const ops: Array<() => Promise<unknown>> = [
        () => M.updateOne({}, { $set: { memo: 'x' } }),
        () => M.updateMany({}, { $set: { memo: 'x' } }),
        () => M.findOneAndUpdate({}, { $set: { memo: 'x' } }),
        () => M.replaceOne({}, {}),
        () => M.findOneAndReplace({}, {}),
        () => M.deleteOne({}),
        () => M.deleteMany({}),
        () => M.findOneAndDelete({}),
        () => M.bulkWrite([{ deleteMany: { filter: {} } }]),
      ];
      for (const op of ops) await expect(op()).rejects.toBeInstanceOf(AppendOnlyViolation);
    });
  }

  it('refuses saving an existing audit document', async () => {
    await seedEntries();
    const doc = await AuditLogModel.findOne();
    doc!.action = 'tampered';
    await expect(doc!.save()).rejects.toBeInstanceOf(AppendOnlyViolation);
    await expect(doc!.deleteOne()).rejects.toBeInstanceOf(AppendOnlyViolation);
    expect((await AuditLogModel.findOne())!.action).toBe('test.event');
  });

  it('exposes no HTTP route that modifies or deletes audit entries, even for a Super Admin', async () => {
    await seedEntries();
    const sa = await createActiveAdmin('super_admin');
    const s = await signInAdmin(app, sa);
    const entry = await AuditLogModel.findOne().lean();
    for (const method of ['put', 'patch', 'delete', 'post'] as const) {
      const res = await request(app)[method](`${API}/admin/audit-logs/${String(entry!._id)}`).set(bearer(s)).send({});
      expect(res.status, method).toBe(404);
    }
    const list = await request(app).get(`${API}/admin/audit-logs`).set(bearer(s)).expect(200);
    expect(list.body.entries.length).toBeGreaterThan(0);
  });

  it('never copies secrets into audit entries', async () => {
    await recordAudit({
      actor: { type: 'system', name: 'test' },
      action: 'test.secrets',
      targetType: 'user',
      before: { passwordHash: '$2b$12$abc', nested: { secretEnc: 'xyz', ok: 1 } },
    });
    const e = await AuditLogModel.findOne({ action: 'test.secrets' }).lean();
    expect(e!.before).toEqual({ passwordHash: '[redacted]', nested: { secretEnc: '[redacted]', ok: 1 } });
  });
});
