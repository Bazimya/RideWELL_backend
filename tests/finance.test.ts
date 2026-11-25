import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { API, auditActions, bearer, createActiveAdmin, freshTotp, lastSmsTo, signInAdmin, signInCustomer, testApp, type SignedIn, type TestAdmin } from './helpers.js';
import { approvedDriver, approvedVehicle, book, chauffeurRequest, inHours, quote, seedConfig } from './bookingFixtures.js';
import { bookingBalance, releaseDueEarnings } from '../src/modules/finance/finance.service.js';
import { confirmPayment } from '../src/modules/payments/payment.service.js';
import { DevPaymentProvider, setPaymentProviderForTests } from '../src/modules/payments/provider.js';
import { withTransaction } from '../src/db/transaction.js';
import { saveConfigVersion } from '../src/modules/platformConfig/platformConfig.service.js';
import { DEV_PLACEHOLDER_CONFIG } from '../src/modules/platformConfig/platformConfig.schema.js';

const app = testApp();
const db = () => mongoose.connection.db!;
const ledger = (bookingId: string) => db().collection('ledger').find({ bookingId: new mongoose.Types.ObjectId(bookingId) }).sort({ _id: 1 }).toArray();
const earnings = (bookingId: string) => db().collection('earnings').find({ bookingId: new mongoose.Types.ObjectId(bookingId) }).sort({ _id: 1 }).toArray();

interface World {
  customer: SignedIn;
  ops: SignedIn;
  superAdmin: TestAdmin;
  sa: SignedIn;
  driver: Awaited<ReturnType<typeof approvedDriver>>;
  vehicle: Awaited<ReturnType<typeof approvedVehicle>>;
  bookingId: string;
}

/** A chauffeur booking paid at 45,000 RWF (split 9,000 / 13,500 / 22,500). */
async function paid(startHours = 1.5, configOverrides: Partial<typeof DEV_PLACEHOLDER_CONFIG> = {}): Promise<World> {
  if (Object.keys(configOverrides).length) {
    await withTransaction((s) => saveConfigVersion({ values: { ...DEV_PLACEHOLDER_CONFIG, ...configOverrides }, isPlaceholder: true, createdBySystem: 'test' }, s));
  } else await seedConfig();
  const customer = await signInCustomer(app, '0788700100');
  const ops = await signInAdmin(app, await createActiveAdmin('staff'));
  const superAdmin = await createActiveAdmin('super_admin');
  const sa = await signInAdmin(app, superAdmin);
  const driver = await approvedDriver('0788700101');
  const vehicle = await approvedVehicle('0788700102');
  const b = await book(app, customer, chauffeurRequest(inHours(startHours)));
  expect((await quote(app, ops, b.id, { amountRwf: 45_000, driverId: driver.userId, vehicleId: vehicle.vehicleId })).status).toBe(200);
  await request(app).post(`${API}/bookings/${b.id}/pay`).set(bearer(customer)).expect(200);
  return { customer, ops, superAdmin, sa, driver, vehicle, bookingId: b.id };
}

async function acceptAndRun(w: World, { complete = true } = {}) {
  const d = await signInCustomer(app, w.driver.phone);
  const o = await signInCustomer(app, w.vehicle.ownerPhone);
  await request(app).post(`${API}/driver/trips/${w.bookingId}/accept`).set(bearer(d)).expect(200);
  await request(app).post(`${API}/owner/trips/${w.bookingId}/accept`).set(bearer(o)).expect(200);
  const pin = (await request(app).get(`${API}/bookings/${w.bookingId}`).set(bearer(w.customer))).body.tripPin;
  await request(app).post(`${API}/driver/trips/${w.bookingId}/start`).set(bearer(d)).send({ pin }).expect(200);
  if (complete) await request(app).post(`${API}/driver/trips/${w.bookingId}/complete`).set(bearer(d)).expect(200);
  return { d, o };
}

async function makePayable(bookingId: string) {
  await db().collection('earnings').updateMany({ bookingId: new mongoose.Types.ObjectId(bookingId), status: 'held' }, { $set: { releaseAt: new Date(Date.now() - 1000) } });
  return releaseDueEarnings();
}

describe('ledger at payment', () => {
  it('posts the payment, commission and partner earnings, which add up exactly', async () => {
    const w = await paid();
    const rows = await ledger(w.bookingId);
    expect(rows.map((r) => [r.type, r.amount])).toEqual([
      ['customer_payment', 45_000],
      ['platform_commission', 9_000],
      ['driver_earning', 13_500],
      ['vehicle_owner_earning', 22_500],
    ]);
    const e = await earnings(w.bookingId);
    expect(e.map((x) => [x.role, x.amountRwf, x.status])).toEqual([
      ['driver', 13_500, 'pending'],
      ['vehicle_owner', 22_500, 'pending'],
    ]);
    expect(await bookingBalance(w.bookingId)).toMatchObject({ paid: 45_000, allocations: 45_000, balanced: true });
  });

  it('handles the provider fee for both fee policies', async () => {
    const real = new DevPaymentProvider();
    const feeProvider = (fee: number) => ({
      name: 'dev' as const,
      isDevelopment: true,
      requestPayment: () => real.requestPayment(),
      getStatus: async (ref: string) => ({ ...(await real.getStatus(ref)), feeRwf: fee }),
      refund: () => real.refund(),
    });
    try {
      setPaymentProviderForTests(feeProvider(450));
      const a = await paid(1.5, { providerFeeBearer: 'platform' });
      const ra = await ledger(a.bookingId);
      expect(ra.find((r) => r.type === 'provider_fee')!.amount).toBe(450);
      expect(ra.find((r) => r.type === 'adjustment')!.amount).toBe(-450); // platform absorbs it
      expect(ra.find((r) => r.type === 'driver_earning')!.amount).toBe(13_500); // partners unaffected
      expect((await bookingBalance(a.bookingId)).balanced).toBe(true);

      // Clear documents but keep indexes (unique keys matter here).
      for (const c of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(c.name).deleteMany({});
      setPaymentProviderForTests(feeProvider(1_000));
      const b = await paid(1.5, { providerFeeBearer: 'deducted_before_split' });
      const rb = await ledger(b.bookingId);
      // Split of 44,000 after the fee: 8,800 / 13,200 / 22,000.
      expect(rb.filter((r) => r.type !== 'customer_payment').map((r) => [r.type, r.amount])).toEqual([
        ['provider_fee', 1_000],
        ['platform_commission', 8_800],
        ['driver_earning', 13_200],
        ['vehicle_owner_earning', 22_000],
      ]);
      expect((await bookingBalance(b.bookingId)).balanced).toBe(true);
    } finally {
      setPaymentProviderForTests(null);
    }
  });

  it('a repeated confirmation never posts twice', async () => {
    const w = await paid();
    const p = await db().collection('payments').findOne({});
    expect(await confirmPayment(p!.providerRef, 'webhook-retry')).toBe('already');
    expect((await ledger(w.bookingId)).filter((r) => r.type === 'customer_payment')).toHaveLength(1);
  });
});

describe('earnings lifecycle', () => {
  it('pending → held (started) → held with release date (completed) → payable only after the release period', async () => {
    const w = await paid();
    expect(await releaseDueEarnings()).toBe(0); // never released just because payment was received
    const { d } = await acceptAndRun(w, { complete: false });
    expect((await earnings(w.bookingId)).every((e) => e.status === 'held')).toBe(true);
    await request(app).post(`${API}/driver/trips/${w.bookingId}/complete`).set(bearer(d)).expect(200);
    const held = await earnings(w.bookingId);
    const hours = ((held[0]!.releaseAt as Date).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(await releaseDueEarnings()).toBe(0); // not yet
    expect(await makePayable(w.bookingId)).toBe(2);
    expect((await earnings(w.bookingId)).map((e) => e.status)).toEqual(['payable', 'payable']);
    expect(await auditActions()).toContain('earning.payable');
  });

  it('an open safety report blocks release; resolving it lets the earnings through', async () => {
    const w = await paid();
    await acceptAndRun(w);
    await request(app).post(`${API}/bookings/${w.bookingId}/safety-report`).set(bearer(w.customer)).send({ message: 'Rude driver' }).expect(201);
    expect((await earnings(w.bookingId)).map((e) => e.status)).toEqual(['disputed', 'disputed']);
    expect(await makePayable(w.bookingId)).toBe(0);
    const report = (await request(app).get(`${API}/admin/safety-reports`).set(bearer(w.ops))).body.reports[0];
    await request(app).post(`${API}/admin/safety-reports/${report.id}/resolve`).set(bearer(w.ops)).send({ resolution: 'Checked; no issue', releaseDriver: true }).expect(204);
    expect((await earnings(w.bookingId)).map((e) => e.status)).toEqual(['held', 'held']);
    expect(await makePayable(w.bookingId)).toBe(2);
  });

  it('a decline reverses the earning; reassignment allocates it to the new driver; the books stay balanced', async () => {
    const w = await paid(26);
    const d = await signInCustomer(app, w.driver.phone);
    await request(app).post(`${API}/driver/trips/${w.bookingId}/decline`).set(bearer(d)).send({}).expect(204);
    const other = await approvedDriver('0788700111', 'Patrick');
    await request(app).post(`${API}/admin/bookings/${w.bookingId}/assign`).set(bearer(w.ops)).send({ driverId: other.userId }).expect(200);
    const e = await earnings(w.bookingId);
    const drivers = e.filter((x) => x.role === 'driver');
    expect(drivers.map((x) => [String(x.partnerUserId), x.status, x.amountRwf])).toEqual([
      [w.driver.userId, 'reversed', 13_500],
      [other.userId, 'pending', 13_500],
    ]);
    expect((await bookingBalance(w.bookingId)).balanced).toBe(true);
  });
});

describe('refunds: requested by one person, approved by another', () => {
  it('a cancellation reverses the split, keeps the policy share, and creates the refund request; a super admin approves it', async () => {
    const w = await paid(10); // 2–24 h before pickup: 50% back
    await request(app).post(`${API}/bookings/${w.bookingId}/cancel`).set(bearer(w.customer)).send({ reason: 'Plans changed' }).expect(200);
    const after = await ledger(w.bookingId);
    expect(after.filter((r) => r.type === 'reversal').map((r) => r.amount).sort((a, b) => a - b)).toEqual([-22_500, -13_500, -9_000]);
    expect(after.find((r) => r.type === 'adjustment')!.amount).toBe(22_500); // kept by the platform
    expect((await earnings(w.bookingId)).every((e) => e.status === 'reversed')).toBe(true);
    expect(await bookingBalance(w.bookingId)).toMatchObject({ paid: 45_000, refunded: 0, allocations: 22_500, balanced: false }); // refund still owed

    const list = await request(app).get(`${API}/admin/finance/refunds`).set(bearer(w.ops)).expect(200);
    const refund = list.body.refunds[0];
    expect(refund).toMatchObject({ amountRwf: 22_500, source: 'cancellation_policy', status: 'requested' });

    // Operations cannot approve; the approval needs a fresh authenticator code.
    await request(app).post(`${API}/admin/finance/refunds/${refund.id}/approve`).set(bearer(w.ops)).send({}).expect(403);
    await request(app).post(`${API}/admin/finance/refunds/${refund.id}/approve`).set(bearer(w.sa)).send({}).expect(401);
    const ok = await request(app).post(`${API}/admin/finance/refunds/${refund.id}/approve`).set(bearer(w.sa)).set('X-2FA-Code', await freshTotp(w.superAdmin)).send({ note: 'Policy refund' }).expect(200);
    expect(ok.body).toMatchObject({ status: 'completed', isDevelopment: true });

    const final = await ledger(w.bookingId);
    expect(final.find((r) => r.type === 'refund')!.amount).toBe(22_500);
    expect(await bookingBalance(w.bookingId)).toMatchObject({ paid: 45_000, refunded: 22_500, allocations: 22_500, balanced: true });
    expect((await request(app).get(`${API}/bookings/${w.bookingId}`).set(bearer(w.customer))).body.status).toBe('refunded');
    expect(await lastSmsTo('0788700100')).toMatch(/refund of 22,500 RWF/);
    // Approving twice does nothing.
    await request(app).post(`${API}/admin/finance/refunds/${refund.id}/approve`).set(bearer(w.sa)).set('X-2FA-Code', await freshTotp(w.superAdmin)).send({}).expect(409);
    expect(await auditActions()).toEqual(expect.arrayContaining(['refund.requested', 'refund.approved', 'refund.completed', 'booking.refunded']));
  });

  it('a rejected policy refund stays with the platform and the books balance', async () => {
    const w = await paid(30); // > 24 h: full refund due
    await request(app).post(`${API}/bookings/${w.bookingId}/cancel`).set(bearer(w.customer)).send({}).expect(200);
    const refund = (await request(app).get(`${API}/admin/finance/refunds`).set(bearer(w.sa))).body.refunds[0];
    await request(app).post(`${API}/admin/finance/refunds/${refund.id}/reject`).set(bearer(w.sa)).set('X-2FA-Code', await freshTotp(w.superAdmin)).send({ note: 'Duplicate booking abuse' }).expect(204);
    expect(await bookingBalance(w.bookingId)).toMatchObject({ refunded: 0, balanced: true });
  });

  it('a goodwill refund is capped, cannot be approved by its requester, and is absorbed by the platform', async () => {
    const w = await paid();
    await acceptAndRun(w);
    // Someone with both permissions still cannot approve their own request.
    const both = await createActiveAdmin('staff', ['refunds.request', 'refunds.approve', 'finance.view']);
    const bs = await signInAdmin(app, both);
    await request(app).post(`${API}/admin/finance/refunds`).set(bearer(bs)).send({ bookingId: w.bookingId, amountRwf: 50_000, reason: 'Too much' }).expect(400);
    const created = await request(app).post(`${API}/admin/finance/refunds`).set(bearer(bs)).send({ bookingId: w.bookingId, amountRwf: 5_000, reason: 'Late pickup' }).expect(201);
    const self = await request(app).post(`${API}/admin/finance/refunds/${created.body.id}/approve`).set(bearer(bs)).set('X-2FA-Code', await freshTotp(both)).send({}).expect(403);
    expect(self.body.error.message).toMatch(/you requested/);
    await request(app).post(`${API}/admin/finance/refunds/${created.body.id}/approve`).set(bearer(w.sa)).set('X-2FA-Code', await freshTotp(w.superAdmin)).send({}).expect(200);
    expect(await bookingBalance(w.bookingId)).toMatchObject({ paid: 45_000, refunded: 5_000, allocations: 40_000, balanced: true });
    // Partner earnings are untouched by a goodwill refund.
    expect((await earnings(w.bookingId)).map((e) => e.amountRwf)).toEqual([13_500, 22_500]);
  });
});

describe('manual payouts', () => {
  async function payableWorld() {
    const w = await paid();
    await acceptAndRun(w);
    await makePayable(w.bookingId);
    const driverEarning = (await earnings(w.bookingId)).find((e) => e.role === 'driver')!;
    return { w, earningId: String(driverEarning._id) };
  }

  it('a super admin records a payout with the real transaction reference; it cannot be paid twice', async () => {
    const { w, earningId } = await payableWorld();
    const summary = (await request(app).get(`${API}/admin/finance/payables`).set(bearer(w.sa)).expect(200)).body.partners;
    const driverRow = summary.find((p: { partnerUserId: string }) => p.partnerUserId === w.driver.userId);
    expect(driverRow).toMatchObject({ totalRwf: 13_500, earnings: [{ amountRwf: 13_500, customerPaymentRwf: 45_000, commissionRwf: 9_000 }] });

    const key = crypto.randomUUID();
    const body = { partnerUserId: w.driver.userId, earningIds: [earningId], amountRwf: 13_500, method: 'momo', destination: '+250788700101', transactionRef: 'MP241124.1234.A56789', idempotencyKey: key };
    await request(app).post(`${API}/admin/finance/payouts`).set(bearer(w.ops)).set('X-2FA-Code', '000000').send(body).expect(403); // operations cannot
    await request(app).post(`${API}/admin/finance/payouts`).set(bearer(w.sa)).send(body).expect(401); // needs a fresh code
    const ok = await request(app).post(`${API}/admin/finance/payouts`).set(bearer(w.sa)).set('X-2FA-Code', await freshTotp(w.superAdmin)).send(body).expect(201);
    expect(ok.body.repeated).toBe(false);

    // The same request again (e.g. a double click): same payout, nothing new.
    const again = await request(app).post(`${API}/admin/finance/payouts`).set(bearer(w.sa)).set('X-2FA-Code', await freshTotp(w.superAdmin)).send(body).expect(200);
    expect(again.body).toEqual({ id: ok.body.id, repeated: true });
    // A new key for the same earnings: refused.
    const dup = await request(app).post(`${API}/admin/finance/payouts`).set(bearer(w.sa)).set('X-2FA-Code', await freshTotp(w.superAdmin)).send({ ...body, idempotencyKey: crypto.randomUUID(), transactionRef: 'OTHER-REF-1' }).expect(409);
    expect(dup.body.error.code).toBe('not_payable');

    expect((await db().collection('payouts').countDocuments())).toBe(1);
    expect((await ledger(w.bookingId)).filter((r) => r.type === 'payout').map((r) => r.amount)).toEqual([13_500]);
    expect((await earnings(w.bookingId)).find((e) => e.role === 'driver')!.status).toBe('paid');
    expect(await lastSmsTo(w.driver.phone)).toMatch(/paid you 13,500 RWF/);
    expect(await auditActions()).toContain('payout.confirmed');
  });

  it('refuses a wrong amount, another partner’s earnings, unpayable earnings and a reused transaction reference', async () => {
    const { w, earningId } = await payableWorld();
    const ownerEarning = String((await earnings(w.bookingId)).find((e) => e.role === 'vehicle_owner')!._id);
    const base = { partnerUserId: w.driver.userId, method: 'momo', destination: '+250788700101', transactionRef: 'REF-0001', note: null };
    const post = async (extra: object) =>
      request(app).post(`${API}/admin/finance/payouts`).set(bearer(w.sa)).set('X-2FA-Code', await freshTotp(w.superAdmin)).send({ ...base, idempotencyKey: crypto.randomUUID(), ...extra });
    expect((await post({ earningIds: [earningId], amountRwf: 13_000 })).body.error.code).toBe('amount_mismatch');
    expect((await post({ earningIds: [earningId, ownerEarning], amountRwf: 36_000 })).body.error.code).toBe('wrong_partner');
    expect((await post({ earningIds: [earningId], amountRwf: 13_500 })).status).toBe(201);
    // Owner payout reusing the same MoMo transaction reference: refused.
    const reuse = await post({ partnerUserId: w.vehicle.ownerUserId, earningIds: [ownerEarning], amountRwf: 22_500 });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('duplicate_transaction');
  });

  it('held (not yet released) earnings cannot be paid', async () => {
    const w = await paid();
    await acceptAndRun(w);
    const e = (await earnings(w.bookingId))[0]!;
    const res = await request(app)
      .post(`${API}/admin/finance/payouts`)
      .set(bearer(w.sa))
      .set('X-2FA-Code', await freshTotp(w.superAdmin))
      .send({ partnerUserId: String(e.partnerUserId), earningIds: [String(e._id)], amountRwf: e.amountRwf, method: 'momo', destination: 'x12345', transactionRef: 'REF-HELD-1', idempotencyKey: crypto.randomUUID() })
      .expect(409);
    expect(res.body.error.code).toBe('not_payable');
  });
});

describe('partners and permissions', () => {
  it('partners see their own earnings read-only, and cannot change earnings, payouts or the ledger', async () => {
    const w = await paid();
    const { d } = await acceptAndRun(w);
    const mine = (await request(app).get(`${API}/partners/earnings`).set(bearer(d)).expect(200)).body;
    expect(mine.totals.held).toBe(13_500);
    expect(mine.earnings).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toContain('22500'); // the owner's share is not shown to the driver
    for (const [method, path] of [
      ['patch', `/partners/earnings/${mine.earnings[0].id}`],
      ['post', '/partners/earnings'],
      ['post', '/admin/finance/payouts'],
      ['get', '/admin/finance/ledger'],
      ['get', '/admin/finance/payables'],
    ] as const) {
      const res = await request(app)[method](`${API}${path}`).set(bearer(d)).send({});
      expect([403, 404], `${method} ${path}`).toContain(res.status);
    }
    // Ledger and audit have no change routes even for super admins.
    const entry = (await ledger(w.bookingId))[0]!;
    for (const m of ['put', 'patch', 'delete'] as const) {
      expect((await request(app)[m](`${API}/admin/finance/ledger/${String(entry._id)}`).set(bearer(w.sa)).send({})).status).toBe(404);
    }
    // A plain customer has no earnings view.
    await request(app).get(`${API}/partners/earnings`).set(bearer(w.customer)).expect(403);
  });

  it('partners keep payout details up to date, audited without the account number', async () => {
    const w = await paid();
    const d = await signInCustomer(app, w.driver.phone);
    await request(app).put(`${API}/partners/payout-details`).set(bearer(d)).send({ role: 'driver', payout: { method: 'momo', momoPhone: '0788700101', momoName: 'Eric Driver' } }).expect(200);
    const audit = await db().collection('auditLogs').findOne({ action: 'partner.payout_details_changed' });
    expect(audit!.after).toEqual({ method: 'momo' });
    const payables = (await request(app).get(`${API}/admin/finance/payables`).set(bearer(w.sa))).body;
    expect(payables.partners).toEqual([]); // nothing payable yet
  });

  it('staff need finance.view to read the ledger', async () => {
    const w = await paid();
    await request(app).get(`${API}/admin/finance/ledger?bookingId=${w.bookingId}`).set(bearer(w.ops)).expect(403);
    const fin = await signInAdmin(app, await createActiveAdmin('staff', ['finance.view']));
    const res = await request(app).get(`${API}/admin/finance/ledger?bookingId=${w.bookingId}`).set(bearer(fin)).expect(200);
    expect(res.body.entries).toHaveLength(4);
    const summary = await request(app).get(`${API}/admin/finance/summary`).set(bearer(fin)).expect(200);
    expect(summary.body).toMatchObject({ customerPaymentsRwf: 45_000, developmentPayments: 1 });
  });
});
