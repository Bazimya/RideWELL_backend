import { describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { API, auditActions, bearer, createActiveAdmin, lastSmsTo, signInAdmin, signInCustomer, testApp, type SignedIn } from './helpers.js';
import { approveAllDocuments, inDays, jpegWithGps, submitCompleteDriver, upload } from './fixtures.js';
import { driverEligibility } from '../src/modules/partners/requirements.js';

const app = testApp();

async function ops(): Promise<SignedIn> {
  return signInAdmin(app, await createActiveAdmin('staff'));
}
const adminView = (a: SignedIn, id: string) => request(app).get(`${API}/admin/partners/driver/${id}`).set(bearer(a));

async function passAllChecks(a: SignedIn, id: string) {
  for (const check of ['interview', 'drivingTest', 'references']) {
    await request(app).post(`${API}/admin/partners/driver/${id}/checks`).set(bearer(a)).send({ check, result: 'passed', notes: 'ok' }).expect(200);
  }
}

describe('driver partner application', () => {
  it('lists exactly what is missing and refuses an incomplete submission', async () => {
    const s = await signInCustomer(app, '0788700001');
    const view = await request(app).get(`${API}/partners/driver`).set(bearer(s)).expect(200);
    expect(view.body.profile.status).toBe('draft');
    expect(view.body.submissionRequirements.every((r: { done: boolean; key: string }) => !r.done || r.key === 'contactPhone')).toBe(true);
    const res = await request(app).post(`${API}/partners/driver/submit`).set(bearer(s)).expect(400);
    expect(res.body.error.code).toBe('incomplete_application');
    expect(res.body.error.details.map((d: { key: string }) => d.key)).toContain('doc:driving_licence');
  });

  it('runs the full flow: apply → review → documents → checks → approve → role granted → availability', async () => {
    const s = await signInCustomer(app, '0788700002');
    const submitted = await submitCompleteDriver(app, s);
    expect(submitted.profile.status).toBe('applied');
    expect(await lastSmsTo('0788700002')).toMatch(/received your driver partner application/);

    // Locked while under review.
    await request(app).put(`${API}/partners/driver`).set(bearer(s)).send({ experienceYears: 9 }).expect(409);

    const a = await ops();
    const queue = await request(app).get(`${API}/admin/partners/applications?kind=driver`).set(bearer(a)).expect(200);
    expect(queue.body.applications.map((x: { id: string }) => x.id)).toContain(submitted.profile.id);

    const id = submitted.profile.id;
    // Checks cannot be recorded before the review starts.
    await request(app).post(`${API}/admin/partners/driver/${id}/checks`).set(bearer(a)).send({ check: 'interview', result: 'passed' }).expect(409);
    await request(app).post(`${API}/admin/partners/driver/${id}/start-review`).set(bearer(a)).expect(200);

    // Approval refused until every requirement is met.
    const early = await request(app).post(`${API}/admin/partners/driver/${id}/decision`).set(bearer(a)).send({ decision: 'approve' }).expect(400);
    expect(early.body.error.code).toBe('requirements_not_met');

    const view = (await adminView(a, id).expect(200)).body;
    // The licence needs a confirmed, future expiry date.
    const licence = view.documents.find((d: { kind: string }) => d.kind === 'driving_licence');
    await request(app).post(`${API}/admin/partners/documents/${licence.id}/review`).set(bearer(a)).send({ decision: 'approved' }).expect(400);
    await request(app)
      .post(`${API}/admin/partners/documents/${licence.id}/review`)
      .set(bearer(a))
      .send({ decision: 'approved', expiresAt: inDays(-1).toISOString() })
      .expect(400);
    await approveAllDocuments(app, a, view);
    await passAllChecks(a, id);

    const done = await request(app).post(`${API}/admin/partners/driver/${id}/decision`).set(bearer(a)).send({ decision: 'approve' }).expect(200);
    expect(done.body.profile.status).toBe('approved');
    expect(await lastSmsTo('0788700002')).toMatch(/application is approved/);
    const me = await request(app).get(`${API}/me`).set(bearer(s)).expect(200);
    expect(me.body.user.roles).toEqual(['customer', 'driver_partner']);

    // Not assignable until the driver says they are accepting trips.
    expect((await driverEligibility(s.userId)).reasons).toEqual(['not_accepting_trips']);
    await request(app)
      .put(`${API}/partners/driver/availability`)
      .set(bearer(s))
      .send({ acceptingTrips: true, unavailable: [{ from: inDays(3).toISOString(), to: inDays(4).toISOString(), note: 'family' }] })
      .expect(200);
    expect(await driverEligibility(s.userId)).toEqual({ assignable: true, reasons: [] });
    // A trip ending after the licence expires is not allowed.
    expect((await driverEligibility(s.userId, inDays(400))).reasons).toContain('licence_expired_or_missing');

    expect(await auditActions()).toEqual(
      expect.arrayContaining(['driver.applied', 'driver.under_review', 'document.approved', 'driver.check_passed', 'driver.approved', 'user.role_granted']),
    );
  });

  it('rejects with a reason; the driver fixes a document and resubmits', async () => {
    const s = await signInCustomer(app, '0788700003');
    const { profile } = await submitCompleteDriver(app, s);
    const a = await ops();
    await request(app).post(`${API}/admin/partners/driver/${profile.id}/start-review`).set(bearer(a)).expect(200);
    const view = (await adminView(a, profile.id)).body;
    const photo = view.documents.find((d: { kind: string }) => d.kind === 'profile_photo');
    await request(app).post(`${API}/admin/partners/documents/${photo.id}/review`).set(bearer(a)).send({ decision: 'rejected' }).expect(400); // reason required
    await request(app).post(`${API}/admin/partners/documents/${photo.id}/review`).set(bearer(a)).send({ decision: 'rejected', note: 'Face not visible' }).expect(200);

    // During review the driver may replace only the rejected file.
    expect((await upload(app, s, '/partners/driver/documents', 'id_document', await jpegWithGps())).status).toBe(409);
    expect((await upload(app, s, '/partners/driver/documents', 'profile_photo', await jpegWithGps(9))).status).toBe(201);

    await request(app).post(`${API}/admin/partners/driver/${profile.id}/decision`).set(bearer(a)).send({ decision: 'reject' }).expect(400);
    const rej = await request(app)
      .post(`${API}/admin/partners/driver/${profile.id}/decision`)
      .set(bearer(a))
      .send({ decision: 'reject', reason: 'Please add a second reference we can reach.' })
      .expect(200);
    expect(rej.body.profile.status).toBe('rejected');
    expect(await lastSmsTo('0788700003')).toMatch(/needs changes: Please add a second reference/);

    const mine = await request(app).get(`${API}/partners/driver`).set(bearer(s)).expect(200);
    expect(mine.body.profile.decisionReason).toMatch(/second reference/);
    await request(app).put(`${API}/partners/driver`).set(bearer(s)).send({ experienceYears: 7 }).expect(200);
    const again = await request(app).post(`${API}/partners/driver/submit`).set(bearer(s)).expect(200);
    expect(again.body.profile.status).toBe('applied');
  });

  it('suspending an approved driver ends their sessions and blocks assignment; reinstating restores it', async () => {
    const s = await signInCustomer(app, '0788700004');
    const { profile } = await submitCompleteDriver(app, s);
    const a = await ops();
    await request(app).post(`${API}/admin/partners/driver/${profile.id}/start-review`).set(bearer(a)).expect(200);
    await approveAllDocuments(app, a, (await adminView(a, profile.id)).body);
    await passAllChecks(a, profile.id);
    await request(app).post(`${API}/admin/partners/driver/${profile.id}/decision`).set(bearer(a)).send({ decision: 'approve' }).expect(200);
    await request(app).put(`${API}/partners/driver/availability`).set(bearer(s)).send({ acceptingTrips: true, unavailable: [] }).expect(200);

    await request(app).post(`${API}/admin/partners/driver/${profile.id}/suspend`).set(bearer(a)).send({ reason: 'Safety report under investigation' }).expect(200);
    await request(app).get(`${API}/me`).set(bearer(s)).expect(401);
    expect((await driverEligibility(s.userId)).reasons).toContain('driver_suspended');

    await request(app).post(`${API}/admin/partners/driver/${profile.id}/reinstate`).set(bearer(a)).send({ reason: 'Cleared' }).expect(200);
    expect((await driverEligibility(s.userId)).assignable).toBe(true);
  });

  it('keeps partner review away from customers, partners and admin accounts applying', async () => {
    const s = await signInCustomer(app, '0788700005');
    const { profile } = await submitCompleteDriver(app, s);
    await request(app).get(`${API}/admin/partners/applications?kind=driver`).set(bearer(s)).expect(403);
    await request(app).post(`${API}/admin/partners/driver/${profile.id}/decision`).set(bearer(s)).send({ decision: 'approve' }).expect(403);
    const a = await ops();
    await request(app).get(`${API}/partners/driver`).set(bearer(a)).expect(403);
  });

  it('one person can hold both partner roles, each approved separately', async () => {
    const s = await signInCustomer(app, '0788700006');
    await submitCompleteDriver(app, s);
    const owner = await request(app).get(`${API}/partners/owner`).set(bearer(s)).expect(200);
    expect(owner.body.profile.status).toBe('draft');
    const count = await mongoose.connection.db!.collection('driverProfiles').countDocuments({ userId: new mongoose.Types.ObjectId(s.userId) });
    expect(count).toBe(1);
  });
});
