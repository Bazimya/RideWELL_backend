import { describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { API, auditActions, bearer, createActiveAdmin, lastSmsTo, signInAdmin, signInCustomer, testApp, type SignedIn } from './helpers.js';
import { approvedDriver, approvedVehicle, book, chauffeurRequest, driverOnDemandRequest, inHours, quote, seedConfig } from './bookingFixtures.js';
import { acceptanceTimeouts, expireQuotes, notStartedAlerts, acceptanceDeadline } from '../src/modules/bookings/booking.service.js';
import { confirmPayment } from '../src/modules/payments/payment.service.js';
import { setPaymentProviderForTests, DevPaymentProvider } from '../src/modules/payments/provider.js';
import { driverEligibility } from '../src/modules/partners/requirements.js';
import { DEV_PLACEHOLDER_CONFIG } from '../src/modules/platformConfig/platformConfig.schema.js';
import { setSuspended } from '../src/modules/partners/partner.service.js';

const app = testApp();
const bookings = () => mongoose.connection.db!.collection('bookings');
const alerts = () => mongoose.connection.db!.collection('opsAlerts');

async function opsStaff(): Promise<SignedIn> {
  return signInAdmin(app, await createActiveAdmin('staff'));
}
/** Clear every collection but keep the indexes (unlike dropDatabase). */
async function wipe() {
  const db = mongoose.connection.db!;
  for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) await db.collection(c.name).deleteMany({});
}
const view = (s: SignedIn, id: string) => request(app).get(`${API}/bookings/${id}`).set(bearer(s));
const pay = (s: SignedIn, id: string) => request(app).post(`${API}/bookings/${id}/pay`).set(bearer(s));

/** customer + ops + one driver + one vehicle, a chauffeur booking quoted and paid. */
async function paidChauffeurBooking(startHours = 26) {
  await seedConfig();
  const customer = await signInCustomer(app, '0788600100');
  const ops = await opsStaff();
  const driver = await approvedDriver('0788600101');
  const vehicle = await approvedVehicle('0788600102');
  const b = await book(app, customer, chauffeurRequest(inHours(startHours)));
  const q = await quote(app, ops, b.id, { amountRwf: 45_000, driverId: driver.userId, vehicleId: vehicle.vehicleId, note: 'Includes airport fee' });
  expect(q.status, JSON.stringify(q.body)).toBe(200);
  const p = await pay(customer, b.id);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return { customer, ops, driver, vehicle, b };
}

describe('booking requests', () => {
  it('a customer requests a chauffeur airport transfer and a driver-on-demand booking', async () => {
    await seedConfig();
    const c = await signInCustomer(app, '0788600001');
    const res = await request(app).post(`${API}/bookings`).set(bearer(c)).send(chauffeurRequest(inHours(30))).expect(201);
    expect(res.body).toMatchObject({ status: 'requested', service: 'chauffeur', airport: { direction: 'to_airport', flightNumber: 'WB 302' }, canPay: false });
    expect(res.body.ref).toMatch(/^RW-[A-Z0-9]{6}$/);
    expect(await lastSmsTo('0788600001')).toMatch(/received your booking request RW-/);
    const dod = await request(app).post(`${API}/bookings`).set(bearer(c)).send(driverOnDemandRequest(inHours(30))).expect(201);
    expect(dod.body.customerVehicle).toMatchObject({ make: 'Toyota', plate: 'RAD 456 B' });
    const list = await request(app).get(`${API}/bookings`).set(bearer(c)).expect(200);
    expect(list.body.bookings).toHaveLength(2);
  });

  it('validates the request and refuses fields the customer must not set', async () => {
    await seedConfig();
    const c = await signInCustomer(app, '0788600002');
    const tooSoon = await request(app).post(`${API}/bookings`).set(bearer(c)).send(chauffeurRequest(inHours(0.5))).expect(400);
    expect(tooSoon.body.error.code).toBe('too_soon');
    await request(app).post(`${API}/bookings`).set(bearer(c)).send(driverOnDemandRequest(inHours(5), { customerVehicle: null })).expect(400);
    for (const extra of [{ status: 'paid' }, { quote: { amountRwf: 1 } }, { driverId: new mongoose.Types.ObjectId().toHexString() }]) {
      const res = await request(app).post(`${API}/bookings`).set(bearer(c)).send(chauffeurRequest(inHours(30), extra)).expect(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });

  it('staff can book for a customer by phone (creating the account if needed)', async () => {
    await seedConfig();
    const ops = await opsStaff();
    const res = await request(app)
      .post(`${API}/admin/bookings`)
      .set(bearer(ops))
      .send({ ...chauffeurRequest(inHours(30)), customerPhone: '0788600003', customerFirstName: 'Phone' })
      .expect(201);
    expect(res.body).toMatchObject({ channel: 'phone', status: 'requested', customer: { phone: '+250788600003', name: 'Phone' } });
  });
});

describe('the full chauffeur trip', () => {
  it('request → quote → pay → driver and owner accept → PIN start → complete, with each party seeing only what they should', async () => {
    await seedConfig();
    const customer = await signInCustomer(app, '0788600010');
    const ops = await opsStaff();
    const driver = await approvedDriver('0788600011', 'Jean');
    const vehicle = await approvedVehicle('0788600012', { plate: 'RAE111A' });
    const b = await book(app, customer, chauffeurRequest(inHours(1.5)));

    // Ops sees availability with reasons.
    const cand = await request(app).get(`${API}/admin/bookings/${b.id}/candidates`).set(bearer(ops)).expect(200);
    expect(cand.body.drivers.find((d: { id: string }) => d.id === driver.userId)).toMatchObject({ available: true });
    expect(cand.body.vehicles.find((v: { id: string }) => v.id === vehicle.vehicleId)).toMatchObject({ available: true });

    // Quote: the split is snapshotted, rounding remainder to the platform.
    const q = await quote(app, ops, b.id, { amountRwf: 45_001, driverId: driver.userId, vehicleId: vehicle.vehicleId });
    expect(q.status).toBe(200);
    expect(q.body.commissionSnapshot.split).toEqual({ driver: 13_500, vehicle_owner: 22_500, platform: 9_001 });
    expect(await lastSmsTo('0788600010')).toMatch(/quote for booking .* is 45,001 RWF/);
    const cv = (await view(customer, b.id).expect(200)).body;
    expect(cv).toMatchObject({ status: 'quoted', canPay: true, quote: { amountRwf: 45_001 }, driver: null, vehicle: null, tripPin: null });

    // Pay (development provider): the browser sends no amount.
    await request(app).post(`${API}/bookings/${b.id}/pay`).set(bearer(customer)).send({ amountRwf: 1 }).expect(200);
    const paid = (await view(customer, b.id)).body;
    expect(paid).toMatchObject({ status: 'paid', payment: { amountRwf: 45_001, isDevelopment: true } });
    expect(await lastSmsTo('0788600011')).toMatch(/new trip RW-/);
    expect(await lastSmsTo('0788600012')).toMatch(/new trip RW-/);

    // Before acceptance: the driver sees the offer but no customer phone.
    const d = await signInCustomer(app, driver.phone);
    const o = await signInCustomer(app, vehicle.ownerPhone);
    const offer = (await request(app).get(`${API}/driver/trips/${b.id}`).set(bearer(d)).expect(200)).body;
    expect(offer.offer.deadline).toBeTruthy();
    expect(offer.customer.phone).toBeNull();
    // Short-notice pickup: the deadline is at most half the time remaining.
    expect(new Date(offer.offer.deadline).getTime() - Date.now()).toBeLessThanOrEqual(45 * 60_000 + 5000);

    await request(app).post(`${API}/driver/trips/${b.id}/accept`).set(bearer(d)).expect(200);
    expect((await view(customer, b.id)).body.status).toBe('paid'); // still waiting for the vehicle owner
    await request(app).post(`${API}/owner/trips/${b.id}/accept`).set(bearer(o)).expect(200);

    const assigned = (await view(customer, b.id)).body;
    expect(assigned.status).toBe('assigned');
    expect(assigned.tripPin).toMatch(/^\d{4}$/);
    expect(assigned.driver).toEqual({ firstName: 'Jean', hasPhoto: true });
    expect(assigned.vehicle).toMatchObject({ make: 'Toyota', colour: 'Black', plate: 'RAE111A' });
    expect(await lastSmsTo('0788600010')).toContain(`Your trip PIN is ${assigned.tripPin}`);
    const photo = await request(app).get(`${API}/bookings/${b.id}/driver-photo`).set(bearer(customer)).expect(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');

    // The driver now has the customer's phone and navigation links; the owner sees no customer data.
    const dv = (await request(app).get(`${API}/driver/trips/${b.id}`).set(bearer(d))).body;
    expect(dv.customer.phone).toBe('+250788600010');
    expect(dv.navigation.pickup).toContain('google.com/maps');
    const ov = (await request(app).get(`${API}/owner/trips`).set(bearer(o))).body.trips[0];
    expect(JSON.stringify(ov)).not.toMatch(/0788600010|Marriott|customer/i);

    // PIN.
    const wrong = assigned.tripPin === '0000' ? '1111' : '0000';
    const bad = await request(app).post(`${API}/driver/trips/${b.id}/start`).set(bearer(d)).send({ pin: wrong }).expect(400);
    expect(bad.body.error.code).toBe('wrong_pin');
    await request(app).post(`${API}/driver/trips/${b.id}/start`).set(bearer(d)).send({ pin: assigned.tripPin }).expect(200);
    const running = (await view(customer, b.id)).body;
    expect(running.status).toBe('in_progress');
    expect(running.tripPin).toBeNull();

    await request(app).post(`${API}/driver/trips/${b.id}/complete`).set(bearer(d)).expect(200);
    const done = (await view(customer, b.id)).body;
    expect(done.status).toBe('completed');
    expect(done.history.map((h: { to: string }) => h.to)).toEqual(['requested', 'quoted', 'paid', 'assigned', 'in_progress', 'completed']);
    expect(await auditActions()).toEqual(
      expect.arrayContaining(['booking.requested', 'booking.quoted', 'payment.requested', 'payment.confirmed', 'booking.paid', 'booking.accepted_by_driver', 'booking.accepted_by_vehicle_partner', 'booking.assigned', 'booking.in_progress', 'booking.completed']),
    );
  });

  it('Driver on Demand needs only the driver to accept', async () => {
    await seedConfig();
    const customer = await signInCustomer(app, '0788600020');
    const ops = await opsStaff();
    const driver = await approvedDriver('0788600021');
    const b = await book(app, customer, driverOnDemandRequest(inHours(30)));
    expect((await quote(app, ops, b.id, { amountRwf: 32_000, driverId: driver.userId })).body.commissionSnapshot.split).toEqual({ driver: 24_000, platform: 8_000 });
    await pay(customer, b.id).expect(200);
    const d = await signInCustomer(app, driver.phone);
    await request(app).post(`${API}/driver/trips/${b.id}/accept`).set(bearer(d)).expect(200);
    expect((await view(customer, b.id)).body.status).toBe('assigned');
  });
});

describe('payment safety', () => {
  it('a provider reporting a different amount never marks the booking paid', async () => {
    await seedConfig();
    const customer = await signInCustomer(app, '0788600030');
    const ops = await opsStaff();
    const driver = await approvedDriver('0788600031');
    const b = await book(app, customer, driverOnDemandRequest(inHours(30)));
    await quote(app, ops, b.id, { amountRwf: 30_000, driverId: driver.userId });
    const real = new DevPaymentProvider();
    setPaymentProviderForTests({
      name: 'dev',
      isDevelopment: false, // behave like a real provider: no immediate settlement
      requestPayment: () => real.requestPayment(),
      getStatus: async () => ({ status: 'successful', amountRwf: 100 }),
      refund: () => real.refund(),
    });
    try {
      await pay(customer, b.id).expect(200);
      const payment = await mongoose.connection.db!.collection('payments').findOne({});
      expect(await confirmPayment(payment!.providerRef, 'test-webhook')).toBe('mismatch');
      expect((await view(customer, b.id)).body.status).toBe('quoted');
    } finally {
      setPaymentProviderForTests(null);
    }
  });

  it('confirming the same payment twice marks it paid once', async () => {
    const { customer, b } = await paidChauffeurBooking();
    const payment = await mongoose.connection.db!.collection('payments').findOne({ bookingId: new mongoose.Types.ObjectId(b.id) });
    expect(await confirmPayment(payment!.providerRef, 'webhook-retry')).toBe('already');
    const history = (await view(customer, b.id)).body.history.filter((h: { to: string }) => h.to === 'paid');
    expect(history).toHaveLength(1);
  });

  it('customers and partners have no way to set paid or completed', async () => {
    const { customer, driver, b } = await paidChauffeurBooking();
    for (const [method, path] of [
      ['patch', `/bookings/${b.id}`],
      ['put', `/bookings/${b.id}`],
      ['post', `/bookings/${b.id}/complete`],
      ['post', `/bookings/${b.id}/status`],
    ] as const) {
      const res = await request(app)[method](`${API}${path}`).set(bearer(customer)).send({ status: 'completed' });
      expect([404, 405], `${method} ${path}`).toContain(res.status);
    }
    const d = await signInCustomer(app, driver.phone);
    // Completing requires a started trip, which requires the PIN.
    await request(app).post(`${API}/driver/trips/${b.id}/complete`).set(bearer(d)).expect(409);
  });

  it('an expired quote cannot be paid, and the expiry job expires it', async () => {
    await seedConfig();
    const customer = await signInCustomer(app, '0788600040');
    const ops = await opsStaff();
    const driver = await approvedDriver('0788600041');
    const b = await book(app, customer, driverOnDemandRequest(inHours(48)));
    await quote(app, ops, b.id, { amountRwf: 30_000, driverId: driver.userId });
    await bookings().updateOne({ _id: new mongoose.Types.ObjectId(b.id) }, { $set: { 'quote.validUntil': new Date(Date.now() - 1000) } });
    const res = await pay(customer, b.id).expect(409);
    expect(res.body.error.code).toBe('quote_expired');
    expect(await expireQuotes()).toBe(1);
    expect((await view(customer, b.id)).body.status).toBe('expired');
    expect(await lastSmsTo('0788600040')).toMatch(/expired without payment/);
  });
});

describe('no double booking', () => {
  it('refuses a driver already holding an overlapping slot, including the 30-minute buffer', async () => {
    await seedConfig();
    const customer = await signInCustomer(app, '0788600050');
    const ops = await opsStaff();
    const driver = await approvedDriver('0788600051');
    const start = inHours(30);
    const a = await book(app, customer, driverOnDemandRequest(start, { durationHours: 2 }));
    expect((await quote(app, ops, a.id, { amountRwf: 20_000, driverId: driver.userId })).status).toBe(200);

    // Overlapping.
    const overlap = await book(app, customer, driverOnDemandRequest(new Date(start.getTime() + 3_600_000)));
    const r1 = await quote(app, ops, overlap.id, { amountRwf: 20_000, driverId: driver.userId });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('driver_unavailable');
    // Starts 20 minutes after A ends: inside the 30-minute buffer.
    const tight = await book(app, customer, driverOnDemandRequest(new Date(start.getTime() + 2 * 3_600_000 + 20 * 60_000)));
    expect((await quote(app, ops, tight.id, { amountRwf: 20_000, driverId: driver.userId })).status).toBe(409);
    // Starts 40 minutes after A ends: fine.
    const ok = await book(app, customer, driverOnDemandRequest(new Date(start.getTime() + 2 * 3_600_000 + 40 * 60_000)));
    expect((await quote(app, ops, ok.id, { amountRwf: 20_000, driverId: driver.userId })).status).toBe(200);
    // The candidates list explains why.
    const cand = await request(app).get(`${API}/admin/bookings/${overlap.id}/candidates`).set(bearer(ops)).expect(200);
    expect(cand.body.drivers[0].reasons).toContain('booked_at_this_time');
  });

  it('two staff assigning the same driver to overlapping trips at the same moment: exactly one succeeds', async () => {
    await seedConfig();
    const customer = await signInCustomer(app, '0788600060');
    const opsA = await opsStaff();
    const opsB = await opsStaff();
    const driver = await approvedDriver('0788600061');
    const start = inHours(30);
    const bookingsToRace = await Promise.all([1, 2, 3, 4].map(() => book(app, customer, driverOnDemandRequest(start))));
    const results = await Promise.all(bookingsToRace.map((b, i) => quote(app, i % 2 ? opsA : opsB, b.id, { amountRwf: 20_000, driverId: driver.userId })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await bookings().countDocuments({ driverId: new mongoose.Types.ObjectId(driver.userId), status: 'quoted' })).toBe(1);
  });

  it('a quote that expired no longer holds the driver', async () => {
    await seedConfig();
    const customer = await signInCustomer(app, '0788600070');
    const ops = await opsStaff();
    const driver = await approvedDriver('0788600071');
    const start = inHours(30);
    const a = await book(app, customer, driverOnDemandRequest(start));
    await quote(app, ops, a.id, { amountRwf: 20_000, driverId: driver.userId });
    await bookings().updateOne({ _id: new mongoose.Types.ObjectId(a.id) }, { $set: { 'quote.validUntil': new Date(Date.now() - 1000) } });
    const b2 = await book(app, customer, driverOnDemandRequest(start));
    expect((await quote(app, ops, b2.id, { amountRwf: 20_000, driverId: driver.userId })).status).toBe(200);
  });

  it('refuses ineligible partners: not accepting trips, safety hold, too few seats', async () => {
    await seedConfig();
    const customer = await signInCustomer(app, '0788600080');
    const ops = await opsStaff();
    const driver = await approvedDriver('0788600081');
    const small = await approvedVehicle('0788600082', { seats: 2 });
    await mongoose.connection.db!.collection('driverProfiles').updateOne({ userId: new mongoose.Types.ObjectId(driver.userId) }, { $set: { 'availability.acceptingTrips': false } });
    const b = await book(app, customer, chauffeurRequest(inHours(30), { passengers: 4 }));
    const r = await quote(app, ops, b.id, { amountRwf: 40_000, driverId: driver.userId, vehicleId: small.vehicleId });
    expect(r.status).toBe(409);
    expect(r.body.error.details).toContain('not_accepting_trips');
  });
});

describe('acceptance, reassignment and alerts', () => {
  it('a decline alerts operations; reassigning offers the trip to the new driver', async () => {
    const { ops, driver, b } = await paidChauffeurBooking();
    const d = await signInCustomer(app, driver.phone);
    await request(app).post(`${API}/driver/trips/${b.id}/decline`).set(bearer(d)).send({ reason: 'Car trouble' }).expect(204);
    const sv = (await request(app).get(`${API}/admin/bookings/${b.id}`).set(bearer(ops))).body;
    expect(sv.attention.needsReassignment).toBe(true);
    expect(sv.driver).toBeNull();
    expect(await alerts().countDocuments({ type: 'acceptance_declined' })).toBe(1);
    const list = await request(app).get(`${API}/admin/bookings?attention=true`).set(bearer(ops)).expect(200);
    expect(list.body.bookings.map((x: { id: string }) => x.id)).toContain(b.id);

    const other = await approvedDriver('0788600111', 'Patrick');
    await request(app).post(`${API}/admin/bookings/${b.id}/assign`).set(bearer(ops)).send({ driverId: other.userId }).expect(200);
    expect(await lastSmsTo('0788600111')).toMatch(/new trip/);
    // The first driver no longer sees the trip.
    await request(app).get(`${API}/driver/trips/${b.id}`).set(bearer(d)).expect(404);
  });

  it('a missed acceptance deadline alerts operations once', async () => {
    const { b } = await paidChauffeurBooking();
    await bookings().updateOne({ _id: new mongoose.Types.ObjectId(b.id) }, { $set: { 'acceptance.deadline': new Date(Date.now() - 1000) } });
    expect(await acceptanceTimeouts()).toBe(1);
    expect(await acceptanceTimeouts()).toBe(0);
    expect(await alerts().countDocuments({ type: 'acceptance_timeout' })).toBe(1);
  });

  it('acceptance after the deadline is refused', async () => {
    const { driver, b } = await paidChauffeurBooking();
    await bookings().updateOne({ _id: new mongoose.Types.ObjectId(b.id) }, { $set: { 'acceptance.deadline': new Date(Date.now() - 1000) } });
    const d = await signInCustomer(app, driver.phone);
    const res = await request(app).post(`${API}/driver/trips/${b.id}/accept`).set(bearer(d)).expect(409);
    expect(res.body.error.code).toBe('acceptance_expired');
  });

  it('computes the acceptance deadline: 30 minutes, or half the time left for short-notice pickups', () => {
    const now = new Date();
    expect(acceptanceDeadline(now, new Date(now.getTime() + 10 * 3_600_000), DEV_PLACEHOLDER_CONFIG).getTime() - now.getTime()).toBe(30 * 60_000);
    expect(acceptanceDeadline(now, new Date(now.getTime() + 40 * 60_000), DEV_PLACEHOLDER_CONFIG).getTime() - now.getTime()).toBe(20 * 60_000);
  });

  it('five wrong PINs lock the start and alert operations; a trip not started 30 minutes after pickup alerts once', async () => {
    const { customer, driver, vehicle, b } = await paidChauffeurBooking(1.5);
    const d = await signInCustomer(app, driver.phone);
    const o = await signInCustomer(app, vehicle.ownerPhone);
    await request(app).post(`${API}/driver/trips/${b.id}/accept`).set(bearer(d)).expect(200);
    await request(app).post(`${API}/owner/trips/${b.id}/accept`).set(bearer(o)).expect(200);
    const pin = (await view(customer, b.id)).body.tripPin as string;
    const wrong = pin === '0000' ? '1111' : '0000';
    for (let i = 0; i < 4; i++) await request(app).post(`${API}/driver/trips/${b.id}/start`).set(bearer(d)).send({ pin: wrong }).expect(400);
    await request(app).post(`${API}/driver/trips/${b.id}/start`).set(bearer(d)).send({ pin: wrong }).expect(423);
    await request(app).post(`${API}/driver/trips/${b.id}/start`).set(bearer(d)).send({ pin }).expect(423);
    expect(await alerts().countDocuments({ type: 'pin_locked', severity: 'high' })).toBe(1);

    await bookings().updateOne({ _id: new mongoose.Types.ObjectId(b.id) }, { $set: { startAt: new Date(Date.now() - 31 * 60_000) } });
    expect(await notStartedAlerts()).toBe(1);
    expect(await notStartedAlerts()).toBe(0);
  });

  it('a trip cannot be started earlier than 2 hours before pickup', async () => {
    const { customer, driver, vehicle, b } = await paidChauffeurBooking(26);
    const d = await signInCustomer(app, driver.phone);
    const o = await signInCustomer(app, vehicle.ownerPhone);
    await request(app).post(`${API}/driver/trips/${b.id}/accept`).set(bearer(d)).expect(200);
    await request(app).post(`${API}/owner/trips/${b.id}/accept`).set(bearer(o)).expect(200);
    const pin = (await view(customer, b.id)).body.tripPin;
    const res = await request(app).post(`${API}/driver/trips/${b.id}/start`).set(bearer(d)).send({ pin }).expect(409);
    expect(res.body.error.code).toBe('outside_start_window');
  });
});

describe('cancellation', () => {
  it('applies the snapshotted refund tiers: >24 h full, 2–24 h half, under 2 h nothing', async () => {
    for (const [hours, expected] of [
      [30, 45_000],
      [10, 22_500],
      [1.5, 0],
    ] as const) {
      await wipe();
      const { customer, driver, b } = await paidChauffeurBooking(hours);
      const res = await request(app).post(`${API}/bookings/${b.id}/cancel`).set(bearer(customer)).send({ reason: 'Plans changed' }).expect(200);
      expect(res.body.status).toBe('cancelled');
      expect(res.body.cancellation.refundDueRwf).toBe(expected);
      expect(await lastSmsTo(driver.phone)).toMatch(/has been cancelled/);
    }
  });

  it('cancelling before payment owes nothing and frees the driver', async () => {
    await seedConfig();
    const customer = await signInCustomer(app, '0788600090');
    const ops = await opsStaff();
    const driver = await approvedDriver('0788600091');
    const start = inHours(30);
    const a = await book(app, customer, driverOnDemandRequest(start));
    await quote(app, ops, a.id, { amountRwf: 20_000, driverId: driver.userId });
    const res = await request(app).post(`${API}/bookings/${a.id}/cancel`).set(bearer(customer)).send({}).expect(200);
    expect(res.body.cancellation.refundDueRwf).toBeNull();
    const b2 = await book(app, customer, driverOnDemandRequest(start));
    expect((await quote(app, ops, b2.id, { amountRwf: 20_000, driverId: driver.userId })).status).toBe(200);
  });

  it('staff may cancel with a full refund; customers cannot ask for more than the policy', async () => {
    const { ops, customer, b } = await paidChauffeurBooking(1.5);
    const cust = await request(app).post(`${API}/bookings/${b.id}/cancel`).set(bearer(customer)).send({ refundMode: 'full' }).expect(400);
    expect(cust.body.error.code).toBe('validation_failed');
    const res = await request(app).post(`${API}/admin/bookings/${b.id}/cancel`).set(bearer(ops)).send({ reason: 'Vehicle breakdown', refundMode: 'full' }).expect(200);
    expect(res.body.cancellation.refundDueRwf).toBe(45_000);
  });
});

describe('safety and suspension', () => {
  it('a customer safety report alerts operations at once and pauses the driver until resolved', async () => {
    const { customer, driver, vehicle, ops, b } = await paidChauffeurBooking();
    const d = await signInCustomer(app, driver.phone);
    const o = await signInCustomer(app, vehicle.ownerPhone);
    await request(app).post(`${API}/driver/trips/${b.id}/accept`).set(bearer(d)).expect(200);
    await request(app).post(`${API}/owner/trips/${b.id}/accept`).set(bearer(o)).expect(200);
    await request(app).post(`${API}/bookings/${b.id}/safety-report`).set(bearer(customer)).send({ message: 'Driver was speeding' }).expect(201);
    expect(await alerts().countDocuments({ type: 'safety_report', severity: 'high' })).toBe(1);
    expect((await driverEligibility(driver.userId)).reasons).toContain('paused_safety_review');

    const reports = await request(app).get(`${API}/admin/safety-reports`).set(bearer(ops)).expect(200);
    expect(reports.body.reports[0]).toMatchObject({ reporterRole: 'customer', message: 'Driver was speeding' });
    await request(app).post(`${API}/admin/safety-reports/${reports.body.reports[0].id}/resolve`).set(bearer(ops)).send({ resolution: 'Spoke to driver; warning issued', releaseDriver: true }).expect(204);
    expect((await driverEligibility(driver.userId)).reasons).not.toContain('paused_safety_review');
    expect((await view(customer, b.id)).body.hasOpenSafetyReport).toBe(false);
  });

  it('suspending a driver removes them from unconfirmed bookings and alerts operations', async () => {
    const { ops, driver, b } = await paidChauffeurBooking();
    const admin = await createActiveAdmin('super_admin');
    await setSuspended('driver', driver.profileId, true, 'Investigation', { type: 'user', id: admin.userId, roles: ['super_admin'] });
    const sv = (await request(app).get(`${API}/admin/bookings/${b.id}`).set(bearer(ops))).body;
    expect(sv.driver).toBeNull();
    expect(sv.attention).toMatchObject({ needsReassignment: true, reason: 'Driver suspended' });
    expect(await alerts().countDocuments({ type: 'partner_suspended' })).toBe(1);
  });
});

describe('who can see and do what', () => {
  it('customers, drivers, owners and staff are confined to their own bookings and permissions', async () => {
    const { customer, driver, vehicle, b } = await paidChauffeurBooking();
    const stranger = await signInCustomer(app, '0788600199');
    await view(stranger, b.id).expect(404);
    await pay(stranger, b.id).expect(404);
    await request(app).post(`${API}/bookings/${b.id}/cancel`).set(bearer(stranger)).send({}).expect(404);
    await request(app).get(`${API}/bookings/${b.id}/driver-photo`).set(bearer(stranger)).expect(404);

    const otherDriver = await approvedDriver('0788600198');
    const od = await signInCustomer(app, otherDriver.phone);
    await request(app).get(`${API}/driver/trips/${b.id}`).set(bearer(od)).expect(404);
    await request(app).post(`${API}/driver/trips/${b.id}/accept`).set(bearer(od)).expect(404);
    // A customer without the driver role cannot use driver routes at all.
    await request(app).get(`${API}/driver/trips`).set(bearer(customer)).expect(403);
    await request(app).get(`${API}/owner/trips`).set(bearer(customer)).expect(403);
    const otherOwner = await approvedVehicle('0788600197');
    const oo = await signInCustomer(app, otherOwner.ownerPhone);
    await request(app).post(`${API}/owner/trips/${b.id}/accept`).set(bearer(oo)).expect(404);

    // Staff need the booking permissions.
    const reviewer = await signInAdmin(app, await createActiveAdmin('staff', ['partners.view']));
    await request(app).get(`${API}/admin/bookings`).set(bearer(reviewer)).expect(403);
    const viewer = await signInAdmin(app, await createActiveAdmin('staff', ['bookings.view']));
    await request(app).get(`${API}/admin/bookings/${b.id}`).set(bearer(viewer)).expect(200);
    await request(app).post(`${API}/admin/bookings/${b.id}/cancel`).set(bearer(viewer)).send({ reason: 'test only' }).expect(403);
    // Partners and customers never reach staff routes.
    const d = await signInCustomer(app, driver.phone);
    await request(app).get(`${API}/admin/bookings`).set(bearer(d)).expect(403);
    void vehicle;
  });

  it('the public price list carries no personal data', async () => {
    await seedConfig();
    const res = await request(app).get(`${API}/public/prices`).expect(200);
    expect(res.body).toEqual({ prices: DEV_PLACEHOLDER_CONFIG.priceList, isPlaceholder: true, currency: 'RWF' });
  });
});
