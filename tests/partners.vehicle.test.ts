import { describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { API, auditActions, bearer, createActiveAdmin, lastSmsTo, signInAdmin, signInCustomer, testApp, type SignedIn } from './helpers.js';
import { approveAllDocuments, inDays, pdf, submitCompleteOwner, submitCompleteVehicle, upload } from './fixtures.js';
import { vehicleEligibility } from '../src/modules/partners/requirements.js';
import { runDocumentExpiryCheck } from '../src/modules/partners/expiryJob.js';
import { readOutbox } from '../src/modules/notifications/adapters/outbox.js';

const app = testApp();
const ops = async () => signInAdmin(app, await createActiveAdmin('staff'));

async function approveOwner(a: SignedIn, ownerId: string) {
  await request(app).post(`${API}/admin/partners/owner/${ownerId}/start-review`).set(bearer(a)).expect(200);
  await approveAllDocuments(app, a, (await request(app).get(`${API}/admin/partners/owner/${ownerId}`).set(bearer(a))).body);
  await request(app).post(`${API}/admin/partners/owner/${ownerId}/decision`).set(bearer(a)).send({ decision: 'approve' }).expect(200);
}

async function approveVehicle(a: SignedIn, vehicleId: string) {
  await request(app).post(`${API}/admin/partners/vehicle/${vehicleId}/start-review`).set(bearer(a)).expect(200);
  await approveAllDocuments(app, a, (await request(app).get(`${API}/admin/partners/vehicle/${vehicleId}`).set(bearer(a))).body);
  await request(app).post(`${API}/admin/partners/vehicle/${vehicleId}/inspection`).set(bearer(a)).send({ result: 'passed', notes: 'Clean, tyres good' }).expect(200);
  const res = await request(app).post(`${API}/admin/partners/vehicle/${vehicleId}/decision`).set(bearer(a)).send({ decision: 'approve' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe('vehicle partner and vehicles', () => {
  it('a company owner needs company details and an RDB certificate', async () => {
    const s = await signInCustomer(app, '0788800001');
    await request(app).put(`${API}/partners/owner`).set(bearer(s)).send({ type: 'company' }).expect(200);
    const v = await request(app).get(`${API}/partners/owner`).set(bearer(s)).expect(200);
    const keys = v.body.submissionRequirements.map((r: { key: string }) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['company', 'doc:rdb_certificate', 'payout']));
  });

  it('validates payout details by method', async () => {
    const s = await signInCustomer(app, '0788800002');
    await request(app).put(`${API}/partners/owner`).set(bearer(s)).send({ payout: { method: 'bank', bankName: 'BK' } }).expect(400);
    await request(app).put(`${API}/partners/owner`).set(bearer(s)).send({ payout: { method: 'momo', momoPhone: '0788800002', momoName: 'Me', bankName: 'X' } }).expect(400);
  });

  it('runs the full flow: owner approved → vehicle reviewed, inspected, approved → assignable', async () => {
    const s = await signInCustomer(app, '0788800003');
    const owner = await submitCompleteOwner(app, s);
    const { vehicle } = await submitCompleteVehicle(app, s);
    expect(vehicle.status).toBe('applied');
    const a = await ops();

    // A vehicle cannot be approved before its owner.
    await request(app).post(`${API}/admin/partners/vehicle/${vehicle.id}/start-review`).set(bearer(a)).expect(200);
    await approveAllDocuments(app, a, (await request(app).get(`${API}/admin/partners/vehicle/${vehicle.id}`).set(bearer(a))).body);
    await request(app).post(`${API}/admin/partners/vehicle/${vehicle.id}/inspection`).set(bearer(a)).send({ result: 'passed' }).expect(200);
    const early = await request(app).post(`${API}/admin/partners/vehicle/${vehicle.id}/decision`).set(bearer(a)).send({ decision: 'approve' }).expect(400);
    expect(early.body.error.details.map((d: { key: string }) => d.key)).toEqual(['owner']);

    await approveOwner(a, owner.profile.id);
    expect((await request(app).get(`${API}/me`).set(bearer(s))).body.user.roles).toContain('vehicle_partner');
    await request(app).post(`${API}/admin/partners/vehicle/${vehicle.id}/decision`).set(bearer(a)).send({ decision: 'approve' }).expect(200);
    expect(await lastSmsTo('0788800003')).toMatch(/vehicle RAB123C is approved/);

    expect((await vehicleEligibility(vehicle.id)).reasons).toEqual(['not_accepting_trips']);
    await request(app).put(`${API}/partners/vehicles/${vehicle.id}/availability`).set(bearer(s)).send({ acceptingTrips: true, unavailable: [] }).expect(200);
    expect(await vehicleEligibility(vehicle.id)).toEqual({ assignable: true, reasons: [] });
    expect(await auditActions()).toEqual(expect.arrayContaining(['vehicle.created', 'vehicle.applied', 'vehicle.inspection_passed', 'vehicle.approved']));
  });

  it('expired insurance blocks assignment immediately, and a renewal keeps the old cover until approved', async () => {
    const s = await signInCustomer(app, '0788800004');
    const owner = await submitCompleteOwner(app, s);
    const { vehicle } = await submitCompleteVehicle(app, s, 'RAC 777 D');
    const a = await ops();
    await approveOwner(a, owner.profile.id);
    await approveVehicle(a, vehicle.id);
    await request(app).put(`${API}/partners/vehicles/${vehicle.id}/availability`).set(bearer(s)).send({ acceptingTrips: true, unavailable: [] }).expect(200);

    // A trip ending after the insurance expiry date is refused.
    expect((await vehicleEligibility(vehicle.id, inDays(400))).reasons).toContain('insurance_expired_or_missing');

    // Renewal: the new file is pending, the approved one still counts.
    expect((await upload(app, s, `/partners/vehicles/${vehicle.id}/documents`, 'insurance', pdf(), 'renewal.pdf')).status).toBe(201);
    expect((await vehicleEligibility(vehicle.id)).assignable).toBe(true);
    // Approved vehicles cannot swap other documents themselves.
    expect((await upload(app, s, `/partners/vehicles/${vehicle.id}/documents`, 'registration_certificate', pdf(), 'r.pdf')).status).toBe(409);

    // The approved insurance lapses.
    await mongoose.connection.db!.collection('documents').updateMany(
      { kind: 'insurance', status: 'approved' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await vehicleEligibility(vehicle.id)).reasons).toContain('insurance_expired_or_missing');
  });

  it('warns once 30 days before insurance expires and notifies once when it expires', async () => {
    const s = await signInCustomer(app, '0788800005');
    const owner = await submitCompleteOwner(app, s);
    const { vehicle } = await submitCompleteVehicle(app, s, 'RAD 555 E');
    const a = await ops();
    await approveOwner(a, owner.profile.id);
    await approveVehicle(a, vehicle.id);
    const ins = { kind: 'insurance', status: 'approved' };
    const docsCol = mongoose.connection.db!.collection('documents');

    await docsCol.updateMany(ins, { $set: { expiresAt: inDays(20) } });
    expect(await runDocumentExpiryCheck()).toEqual({ warned: 1, expired: 0 });
    expect(await runDocumentExpiryCheck()).toEqual({ warned: 0, expired: 0 }); // only once
    expect(await lastSmsTo('0788800005')).toMatch(/insurance for vehicle RAD555E expires on/);

    await docsCol.updateMany(ins, { $set: { expiresAt: inDays(-1) } });
    expect(await runDocumentExpiryCheck()).toEqual({ warned: 0, expired: 1 });
    expect(await runDocumentExpiryCheck()).toEqual({ warned: 0, expired: 0 });
    expect(await lastSmsTo('0788800005')).toMatch(/has expired/);
    expect(await auditActions()).toContain('document.expired');
  });

  it('normalises plates and refuses a plate registered by someone else', async () => {
    const s = await signInCustomer(app, '0788800006');
    const body = { make: 'Toyota', model: 'Corolla', year: 2019, colour: 'White', category: 'sedan', seats: 4 };
    const one = await request(app).post(`${API}/partners/vehicles`).set(bearer(s)).send({ ...body, plate: 'rab 999-z' }).expect(201);
    expect(one.body.vehicle.plate).toBe('RAB999Z');
    const other = await signInCustomer(app, '0788800007');
    const dup = await request(app).post(`${API}/partners/vehicles`).set(bearer(other)).send({ ...body, plate: 'RAB 999 Z' }).expect(409);
    expect(dup.body.error.code).toBe('plate_taken');
  });

  it('an owner can only see and change their own vehicles', async () => {
    const s = await signInCustomer(app, '0788800008');
    const created = await request(app)
      .post(`${API}/partners/vehicles`)
      .set(bearer(s))
      .send({ make: 'Toyota', model: 'Hiace', year: 2018, plate: 'RAE 100 A', colour: 'Silver', category: 'van', seats: 14 })
      .expect(201);
    const id = created.body.vehicle.id;
    const other = await signInCustomer(app, '0788800009');
    await request(app).get(`${API}/partners/vehicles/${id}`).set(bearer(other)).expect(404);
    await request(app).put(`${API}/partners/vehicles/${id}`).set(bearer(other)).send({ colour: 'Red' }).expect(404);
    expect((await upload(app, other, `/partners/vehicles/${id}/documents`, 'insurance', pdf(), 'x.pdf')).status).toBe(404);
  });

  it('needs at least 4 real photos before a vehicle can be submitted', async () => {
    const s = await signInCustomer(app, '0788800010');
    await submitCompleteOwner(app, s);
    const created = await request(app)
      .post(`${API}/partners/vehicles`)
      .set(bearer(s))
      .send({ make: 'Lexus', model: 'RX', year: 2022, plate: 'RAF 200 B', colour: 'Grey', category: 'executive', seats: 4, insurer: 'Sanlam', insuranceExpiry: inDays(90).toISOString(), proposedRates: { hourlyRwf: 15000 } })
      .expect(201);
    const res = await request(app).post(`${API}/partners/vehicles/${created.body.vehicle.id}/submit`).set(bearer(s)).expect(400);
    expect(res.body.error.details.map((d: { key: string }) => d.key)).toContain('doc:vehicle_photo');
    // No notification is sent for vehicle drafts.
    expect((await readOutbox(process.env.OUTBOX_DIR!, 'sms')).filter((m) => (m.text ?? '').includes('RAF200B'))).toHaveLength(0);
  });
});
