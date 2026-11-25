import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { API, auditActions, bearer, createActiveAdmin, lastSmsTo, signInAdmin, signInCustomer, testApp, type SignedIn, type TestAdmin } from './helpers.js';
import { approvedDriver, approvedVehicle, book, chauffeurRequest, inHours, quote, seedConfig } from './bookingFixtures.js';
import { loadEnv } from '../src/config/env.js';
import { notifyUser, resetNotificationAdapters, retryDueNotifications } from '../src/modules/notifications/notification.service.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { DeliveryError, type FetchLike, type SmsAdapter } from '../src/modules/notifications/adapters/types.js';
import { PindoSmsAdapter } from '../src/modules/notifications/adapters/pindo.js';
import { ResendEmailAdapter } from '../src/modules/notifications/adapters/resend.js';
import { OpsAlertModel } from '../src/modules/bookings/alerts.js';
import { financeCsv, kigaliDate, kigaliDayStart } from '../src/modules/dashboards/dashboard.service.js';

const app = testApp();
const db = () => mongoose.connection.db!;

afterEach(() => resetNotificationAdapters());

interface World {
  customer: SignedIn;
  ops: SignedIn;
  superAdmin: TestAdmin;
  sa: SignedIn;
  driver: Awaited<ReturnType<typeof approvedDriver>>;
  vehicle: Awaited<ReturnType<typeof approvedVehicle>>;
  bookingId: string;
}

/** A chauffeur booking quoted at 45,000 RWF and paid with the development provider. */
async function paid(): Promise<World> {
  await seedConfig();
  const customer = await signInCustomer(app, '0788900100');
  const ops = await signInAdmin(app, await createActiveAdmin('staff'));
  const superAdmin = await createActiveAdmin('super_admin');
  const sa = await signInAdmin(app, superAdmin);
  const driver = await approvedDriver('0788900101');
  const vehicle = await approvedVehicle('0788900102');
  const b = await book(app, customer, chauffeurRequest(inHours(1.5)));
  expect((await quote(app, ops, b.id, { amountRwf: 45_000, driverId: driver.userId, vehicleId: vehicle.vehicleId })).status).toBe(200);
  await request(app).post(`${API}/bookings/${b.id}/pay`).set(bearer(customer)).expect(200);
  return { customer, ops, superAdmin, sa, driver, vehicle, bookingId: b.id };
}

async function completed(w: World) {
  const d = await signInCustomer(app, w.driver.phone);
  const o = await signInCustomer(app, w.vehicle.ownerPhone);
  await request(app).post(`${API}/driver/trips/${w.bookingId}/accept`).set(bearer(d)).expect(200);
  await request(app).post(`${API}/owner/trips/${w.bookingId}/accept`).set(bearer(o)).expect(200);
  const pin = (await request(app).get(`${API}/bookings/${w.bookingId}`).set(bearer(w.customer))).body.tripPin;
  await request(app).post(`${API}/driver/trips/${w.bookingId}/start`).set(bearer(d)).send({ pin }).expect(200);
  await request(app).post(`${API}/driver/trips/${w.bookingId}/complete`).set(bearer(d)).expect(200);
  return { d, o, pin: pin as string };
}

/** Records the requests an adapter makes and answers with a scripted response. */
function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

// ===========================================================================
// Provider adapters
// ===========================================================================

describe('Pindo SMS adapter (request shape from docs.pindo.ai)', () => {
  it('posts {to, text, sender} with a bearer token, never the token in the URL, and returns sms_id', async () => {
    const f = fakeFetch(201, { sms_id: 'out_sms_01H7DJEJ1YZKTNT8EDXY2C7YG9', status: 'sent', to: '+250788000001' });
    const res = await new PindoSmsAdapter('tok_secret', 'RideWELL', f.impl).send({ to: '+250788000001', text: 'hello' });
    expect(res.providerMessageId).toBe('out_sms_01H7DJEJ1YZKTNT8EDXY2C7YG9');
    expect(f.calls[0]!.url).toBe('https://api.pindo.io/v1/sms/');
    expect(f.calls[0]!.url).not.toContain('tok_secret');
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer tok_secret');
    expect(f.calls[0]!.body).toEqual({ to: '+250788000001', text: 'hello', sender: 'RideWELL' });
  });

  it('a refused number (409) or bad token (401) is permanent; 5xx and network errors are retried', async () => {
    for (const [status, retryable] of [[409, false], [401, false], [500, true], [429, true]] as const) {
      const err = await new PindoSmsAdapter('t', 'RideWELL', fakeFetch(status, {}).impl).send({ to: '+250788000001', text: 'x' }).catch((e) => e);
      expect(err, String(status)).toBeInstanceOf(DeliveryError);
      expect(err.retryable, String(status)).toBe(retryable);
    }
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const err = await new PindoSmsAdapter('t', 'RideWELL', down).send({ to: '+250788000001', text: 'x' }).catch((e) => e);
    expect(err.retryable).toBe(true);
  });
});

describe('Resend email adapter (request shape from resend.com/docs)', () => {
  it('posts from/to/subject/text/reply_to with a bearer key and an Idempotency-Key, and returns id', async () => {
    const f = fakeFetch(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
    const res = await new ResendEmailAdapter('re_secret', 'RideWELL <no-reply@ridewell.rw>', 'help@ridewell.rw', f.impl).send({ to: 'a@example.com', subject: 'S', text: 'T', idempotencyKey: 'notification/abc' });
    expect(res.providerMessageId).toBe('49a3999c-0ce1-4ea6-ab68-afcd6dc2e794');
    expect(f.calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer re_secret');
    expect(f.calls[0]!.headers['Idempotency-Key']).toBe('notification/abc');
    expect(f.calls[0]!.body).toEqual({ from: 'RideWELL <no-reply@ridewell.rw>', to: ['a@example.com'], subject: 'S', text: 'T', reply_to: 'help@ridewell.rw' });
  });

  it('classifies errors: unverified domain (403) permanent; rate limit and concurrent idempotent request retried', async () => {
    const cases: Array<[number, unknown, boolean]> = [
      [403, { name: 'validation_error' }, false],
      [422, { name: 'invalid_parameter' }, false],
      [429, { name: 'rate_limit_exceeded' }, true],
      [409, { name: 'concurrent_idempotent_requests' }, true],
      [409, { name: 'invalid_idempotent_request' }, false],
      [503, { name: 'service_unavailable' }, true],
    ];
    for (const [status, body, retryable] of cases) {
      const err = await new ResendEmailAdapter('k', 'a@b.c', undefined, fakeFetch(status, body).impl).send({ to: 'x@y.z', subject: 's', text: 't' }).catch((e) => e);
      expect(err.retryable, `${status} ${JSON.stringify(body)}`).toBe(retryable);
    }
  });
});

describe('notification provider configuration', () => {
  const base = { NODE_ENV: 'development', MONGODB_URI: 'mongodb://x', JWT_ACCESS_SECRET: 'x'.repeat(64), HASH_PEPPER: 'y'.repeat(64), DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') };
  it('pindo needs a token; resend needs a key and a From address', () => {
    expect(() => loadEnv({ ...base, SMS_PROVIDER: 'pindo' })).toThrow(/PINDO_API_TOKEN/);
    expect(() => loadEnv({ ...base, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' })).toThrow(/EMAIL_FROM/);
    expect(loadEnv({ ...base, SMS_PROVIDER: 'pindo', PINDO_API_TOKEN: 't', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', EMAIL_FROM: 'RideWELL <a@b.rw>' }).SMS_PROVIDER).toBe('pindo');
  });
});

// ===========================================================================
// Inbox and delivery
// ===========================================================================

describe('notification inbox', () => {
  it('each event is in the recipient’s inbox with a link; nobody else can read it; mark as read', async () => {
    await seedConfig();
    const c = await signInCustomer(app, '0788900200');
    const other = await signInCustomer(app, '0788900201');
    const b = await book(app, c, chauffeurRequest(inHours(30)));
    const inbox = (await request(app).get(`${API}/me/notifications`).set(bearer(c)).expect(200)).body;
    expect(inbox.unread).toBe(1);
    expect(inbox.notifications[0]).toMatchObject({ key: 'booking.received', title: 'We received your booking request', link: `/bookings/${b.id}`, readAt: null });
    expect(inbox.notifications[0].body).toContain(b.ref);
    expect((await request(app).get(`${API}/me/notifications`).set(bearer(other)).expect(200)).body.notifications).toHaveLength(0);
    // Marking someone else's id does nothing.
    await request(app).post(`${API}/me/notifications/read`).set(bearer(other)).send({ ids: [inbox.notifications[0].id] }).expect(204);
    expect((await request(app).get(`${API}/me/notifications`).set(bearer(c))).body.unread).toBe(1);
    await request(app).post(`${API}/me/notifications/read`).set(bearer(c)).send({}).expect(204);
    expect((await request(app).get(`${API}/me/notifications`).set(bearer(c))).body.unread).toBe(0);
    // Delivered by SMS through the outbox, logged as sent.
    const n = await NotificationModel.findOne({ key: 'booking.received' }).lean();
    expect(n).toMatchObject({ channel: 'sms', status: 'sent', provider: 'outbox', attempts: 1 });
    expect(n!.toMasked).not.toContain('900200');
  });

  it('the trip PIN reaches the customer by SMS but is masked in the stored copy and never resent from it', async () => {
    const w = await paid();
    const d = await signInCustomer(app, w.driver.phone);
    const o = await signInCustomer(app, w.vehicle.ownerPhone);
    await request(app).post(`${API}/driver/trips/${w.bookingId}/accept`).set(bearer(d)).expect(200);
    await request(app).post(`${API}/owner/trips/${w.bookingId}/accept`).set(bearer(o)).expect(200);
    const pin = (await request(app).get(`${API}/bookings/${w.bookingId}`).set(bearer(w.customer))).body.tripPin as string;
    expect(await lastSmsTo('+250788900100')).toContain(pin);
    const n = await NotificationModel.findOne({ key: 'trip.assigned' }).lean();
    expect(n!.body).not.toContain(pin);
    expect(n!.body).toContain('••••');
    expect(n!.resendable).toBe(false);
  });

  it('a retryable failure is retried by the job with back-off and then sent; a permanent one fails at once', async () => {
    const c = await signInCustomer(app, '0788900300');
    let fail = true;
    const flaky: SmsAdapter = { name: 'flaky', send: async () => { if (fail) throw new DeliveryError('pindo: HTTP 503', true, 503); return { providerMessageId: 'out_sms_1' }; } };
    resetNotificationAdapters({ sms: flaky });
    await notifyUser(c.userId, 'support.received', { ref: 'S-TEST01' });
    let n = await NotificationModel.findOne({ key: 'support.received' }).lean();
    expect(n).toMatchObject({ status: 'pending', attempts: 1, lastError: 'pindo: HTTP 503' });
    // Not yet due: nothing happens.
    expect(await retryDueNotifications(new Date())).toBe(0);
    fail = false;
    expect(await retryDueNotifications(new Date(Date.now() + 61_000))).toBe(1);
    n = await NotificationModel.findOne({ key: 'support.received' }).lean();
    expect(n).toMatchObject({ status: 'sent', attempts: 2, provider: 'flaky', providerMessageId: 'out_sms_1', lastError: null });

    resetNotificationAdapters({ sms: { name: 'refusing', send: async () => { throw new DeliveryError('pindo: number refused', false, 409); } } });
    await notifyUser(c.userId, 'support.answered', { ref: 'S-TEST01' });
    expect(await NotificationModel.findOne({ key: 'support.answered' }).lean()).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('gives up after the last attempt; staff can resend a failed message, but not one that held a secret', async () => {
    const c = await signInCustomer(app, '0788900400');
    const ops = await signInAdmin(app, await createActiveAdmin('staff'));
    resetNotificationAdapters({ sms: { name: 'down', send: async () => { throw new DeliveryError('network error: TimeoutError', true); } } });
    await notifyUser(c.userId, 'support.received', { ref: 'S-TEST02' });
    for (let i = 1; i <= 3; i++) await retryDueNotifications(new Date(Date.now() + i * 3_600_000));
    const n = await NotificationModel.findOne({ key: 'support.received' }).lean();
    expect(n).toMatchObject({ status: 'failed', attempts: 4 });

    const log = (await request(app).get(`${API}/admin/notifications?status=failed`).set(bearer(ops)).expect(200)).body;
    expect(log.providers).toMatchObject({ sms: 'outbox', email: 'outbox', isDevelopment: true });
    expect(log.notifications[0]).toMatchObject({ key: 'support.received', status: 'failed', lastError: 'network error: TimeoutError', resendable: true });

    resetNotificationAdapters();
    const resent = await request(app).post(`${API}/admin/notifications/${String(n!._id)}/resend`).set(bearer(ops)).expect(200);
    expect(resent.body.status).toBe('sent');
    expect(await auditActions()).toContain('notification.resent');
    await request(app).post(`${API}/admin/notifications/${String(n!._id)}/resend`).set(bearer(ops)).expect(409);

    resetNotificationAdapters({ sms: { name: 'down', send: async () => { throw new DeliveryError('x', true); } } });
    await notifyUser(c.userId, 'trip.assigned', { ref: 'RW-1', driverName: 'Eric', vehicle: '', pin: '1234' });
    const secret = await NotificationModel.findOne({ key: 'trip.assigned' }).lean();
    expect(secret).toMatchObject({ status: 'failed', resendable: false });
    const refused = await request(app).post(`${API}/admin/notifications/${String(secret!._id)}/resend`).set(bearer(ops)).expect(409);
    expect(refused.body.error.code).toBe('not_resendable');
  });

  it('the same event notifies once (dedupe key)', async () => {
    const c = await signInCustomer(app, '0788900500');
    await notifyUser(c.userId, 'support.received', { ref: 'S-1' }, { dedupeKey: 'support.received/x' });
    await notifyUser(c.userId, 'support.received', { ref: 'S-1' }, { dedupeKey: 'support.received/x' });
    expect(await NotificationModel.countDocuments({ key: 'support.received' })).toBe(1);
  });

  it('an email-only account is notified by email', async () => {
    const res = await request(app).post(`${API}/auth/email/register`).send({ email: 'emailonly@example.com', password: 'Quiet-harbour-lantern-58', firstName: 'Ema', lastName: 'Mukamana' });
    expect(res.status).toBe(201);
    const userId = res.body.user.id as string;
    await notifyUser(userId, 'support.received', { ref: 'S-2' });
    expect(await NotificationModel.findOne({ userId }).lean()).toMatchObject({ channel: 'email', status: 'sent', title: 'We received your support request' });
  });
});

// ===========================================================================
// Ratings
// ===========================================================================

describe('rating the driver', () => {
  it('only after completion, once, by the booking’s customer; low ratings alert operations', async () => {
    const w = await paid();
    await request(app).post(`${API}/bookings/${w.bookingId}/rating`).set(bearer(w.customer)).send({ stars: 5 }).expect(409); // not completed yet
    const { d } = await completed(w);
    let view = (await request(app).get(`${API}/bookings/${w.bookingId}`).set(bearer(w.customer))).body;
    expect(view).toMatchObject({ canRate: true, rating: null });

    const stranger = await signInCustomer(app, '0788900199');
    await request(app).post(`${API}/bookings/${w.bookingId}/rating`).set(bearer(stranger)).send({ stars: 1 }).expect(404);
    await request(app).post(`${API}/bookings/${w.bookingId}/rating`).set(bearer(w.customer)).send({ stars: 6 }).expect(400);
    await request(app).post(`${API}/bookings/${w.bookingId}/rating`).set(bearer(w.customer)).send({ stars: 2.5 }).expect(400);

    view = (await request(app).post(`${API}/bookings/${w.bookingId}/rating`).set(bearer(w.customer)).send({ stars: 2, comment: 'Late and rushed' }).expect(201)).body;
    expect(view).toMatchObject({ canRate: false, rating: { stars: 2, comment: 'Late and rushed' } });
    await request(app).post(`${API}/bookings/${w.bookingId}/rating`).set(bearer(w.customer)).send({ stars: 5 }).expect(409);
    expect(await OpsAlertModel.countDocuments({ type: 'low_rating', bookingId: new mongoose.Types.ObjectId(w.bookingId) })).toBe(1);

    // The driver sees the average and the comment, without who wrote it or which booking.
    const mine = (await request(app).get(`${API}/driver/ratings`).set(bearer(d)).expect(200)).body;
    expect(mine).toMatchObject({ count: 1, average: 2, distribution: { 2: 1 }, recent: [{ stars: 2, comment: 'Late and rushed' }] });
    expect(JSON.stringify(mine)).not.toMatch(/RW-|0788900100|customer/i);
    // Staff see it on the booking.
    expect((await request(app).get(`${API}/admin/bookings/${w.bookingId}`).set(bearer(w.ops))).body.rating).toMatchObject({ stars: 2 });
  });

  it('closes 14 days after the trip', async () => {
    const w = await paid();
    await completed(w);
    await db().collection('bookings').updateOne({ _id: new mongoose.Types.ObjectId(w.bookingId) }, { $set: { endedAt: new Date(Date.now() - 15 * 86_400_000) } });
    await request(app).post(`${API}/bookings/${w.bookingId}/rating`).set(bearer(w.customer)).send({ stars: 4 }).expect(409);
  });
});

// ===========================================================================
// Support
// ===========================================================================

describe('support requests', () => {
  it('a customer asks, operations answer, the customer reads the reply; others see nothing', async () => {
    const w = await paid();
    const req = await request(app).post(`${API}/support`).set(bearer(w.customer)).send({ category: 'booking', message: 'Can the driver wait 15 minutes?', bookingId: w.bookingId }).expect(201);
    expect(req.body.request).toMatchObject({ status: 'open', category: 'booking', reply: null });
    expect(req.body.request.ref).toMatch(/^S-[0-9A-F]{6}$/);

    const stranger = await signInCustomer(app, '0788900198');
    expect((await request(app).get(`${API}/support`).set(bearer(stranger))).body.requests).toHaveLength(0);
    // Not a party to the booking: refused.
    await request(app).post(`${API}/support`).set(bearer(stranger)).send({ category: 'booking', message: 'About that booking', bookingId: w.bookingId }).expect(404);
    // The driver of the booking may ask about it.
    const d = await signInCustomer(app, w.driver.phone);
    await request(app).post(`${API}/support`).set(bearer(d)).send({ category: 'partner', message: 'Where is the pickup gate?', bookingId: w.bookingId }).expect(201);

    const queue = (await request(app).get(`${API}/admin/support`).set(bearer(w.ops)).expect(200)).body.requests;
    expect(queue).toHaveLength(2);
    const id = queue.find((q: { category: string }) => q.category === 'booking').id;
    await request(app).post(`${API}/admin/support/${id}/resolve`).set(bearer(w.ops)).send({ reply: 'Yes, 15 minutes of waiting is included.' }).expect(200);
    await request(app).post(`${API}/admin/support/${id}/resolve`).set(bearer(w.ops)).send({ reply: 'again' }).expect(409);

    const mine = (await request(app).get(`${API}/support`).set(bearer(w.customer))).body.requests;
    expect(mine[0]).toMatchObject({ status: 'resolved', reply: 'Yes, 15 minutes of waiting is included.' });
    const inbox = (await request(app).get(`${API}/me/notifications`).set(bearer(w.customer))).body.notifications;
    expect(inbox.map((n: { key: string }) => n.key)).toEqual(expect.arrayContaining(['support.received', 'support.answered']));
    expect(await auditActions()).toEqual(expect.arrayContaining(['support.requested', 'support.resolved']));
  });

  it('limits open requests per person and refuses staff sessions', async () => {
    const c = await signInCustomer(app, '0788900600');
    for (let i = 0; i < 5; i++) await request(app).post(`${API}/support`).set(bearer(c)).send({ category: 'other', message: `Question ${i}` }).expect(201);
    const sixth = await request(app).post(`${API}/support`).set(bearer(c)).send({ category: 'other', message: 'One more' }).expect(409);
    expect(sixth.body.error.code).toBe('too_many_open');
    const staff = await signInAdmin(app, await createActiveAdmin('staff'));
    await request(app).post(`${API}/support`).set(bearer(staff)).send({ category: 'other', message: 'hello' }).expect(403);
  });

  it('a safety report sends the reporter a receipt', async () => {
    const w = await paid();
    const d = await signInCustomer(app, w.driver.phone);
    const o = await signInCustomer(app, w.vehicle.ownerPhone);
    await request(app).post(`${API}/driver/trips/${w.bookingId}/accept`).set(bearer(d)).expect(200);
    await request(app).post(`${API}/owner/trips/${w.bookingId}/accept`).set(bearer(o)).expect(200);
    await request(app).post(`${API}/bookings/${w.bookingId}/safety-report`).set(bearer(w.customer)).send({ message: 'Driver is unwell' }).expect(201);
    expect(await NotificationModel.countDocuments({ userId: new mongoose.Types.ObjectId(w.customer.userId), key: 'safety.received' })).toBe(1);
  });
});

// ===========================================================================
// Dashboards and reports
// ===========================================================================

describe('customer and partner dashboards', () => {
  it('show real next steps: pay the quote, then rate the driver; partner offers, next trip, earnings and rating', async () => {
    await seedConfig();
    const customer = await signInCustomer(app, '0788900700');
    const ops = await signInAdmin(app, await createActiveAdmin('staff'));
    const driver = await approvedDriver('0788900701');
    const vehicle = await approvedVehicle('0788900702');
    const b = await book(app, customer, chauffeurRequest(inHours(1.5)));
    let dash = (await request(app).get(`${API}/me/dashboard`).set(bearer(customer)).expect(200)).body;
    expect(dash.customer).toMatchObject({ totals: { bookings: 1, active: 1, completed: 0 }, actions: [] });
    expect(dash.customer.upcoming[0]).toMatchObject({ id: b.id, status: 'requested' });
    expect(dash.driver).toBeUndefined();

    await quote(app, ops, b.id, { amountRwf: 45_000, driverId: driver.userId, vehicleId: vehicle.vehicleId });
    dash = (await request(app).get(`${API}/me/dashboard`).set(bearer(customer))).body;
    expect(dash.customer.actions).toEqual([expect.objectContaining({ kind: 'pay_quote', bookingId: b.id })]);

    await request(app).post(`${API}/bookings/${b.id}/pay`).set(bearer(customer)).expect(200);
    const d = await signInCustomer(app, driver.phone);
    let dd = (await request(app).get(`${API}/me/dashboard`).set(bearer(d)).expect(200)).body.driver;
    expect(dd).toMatchObject({ profileStatus: 'approved', acceptingTrips: true, offers: [expect.objectContaining({ id: b.id })], next: null, rating: { average: null, count: 0 } });

    const o = await signInCustomer(app, vehicle.ownerPhone);
    await request(app).post(`${API}/driver/trips/${b.id}/accept`).set(bearer(d)).expect(200);
    dd = (await request(app).get(`${API}/me/dashboard`).set(bearer(d))).body.driver;
    expect(dd.offers).toHaveLength(0);
    const od = (await request(app).get(`${API}/me/dashboard`).set(bearer(o)).expect(200)).body.owner;
    expect(od).toMatchObject({ profileStatus: 'approved', offers: [expect.objectContaining({ id: b.id })], vehicles: [expect.objectContaining({ status: 'approved' })] });
    await request(app).post(`${API}/owner/trips/${b.id}/accept`).set(bearer(o)).expect(200);
    dd = (await request(app).get(`${API}/me/dashboard`).set(bearer(d))).body.driver;
    expect(dd.next).toMatchObject({ id: b.id, status: 'assigned' });
    expect(dd.earnings.pending).toBe(13_500);

    const pin = (await request(app).get(`${API}/bookings/${b.id}`).set(bearer(customer))).body.tripPin;
    await request(app).post(`${API}/driver/trips/${b.id}/start`).set(bearer(d)).send({ pin }).expect(200);
    await request(app).post(`${API}/driver/trips/${b.id}/complete`).set(bearer(d)).expect(200);
    dash = (await request(app).get(`${API}/me/dashboard`).set(bearer(customer))).body;
    expect(dash.customer.actions).toEqual([expect.objectContaining({ kind: 'rate_driver', bookingId: b.id })]);
    await request(app).post(`${API}/bookings/${b.id}/rating`).set(bearer(customer)).send({ stars: 5 }).expect(201);
    expect((await request(app).get(`${API}/me/dashboard`).set(bearer(customer))).body.customer.actions).toEqual([]);
    dd = (await request(app).get(`${API}/me/dashboard`).set(bearer(d))).body.driver;
    expect(dd).toMatchObject({ completedAllTime: 1, next: null, rating: { average: 5, count: 1 } });
    expect(dd.earnings.held).toBe(13_500);
  });
});

describe('staff overview', () => {
  it('each section appears only with its permission, with live counts', async () => {
    await seedConfig();
    const c = await signInCustomer(app, '0788900800');
    await book(app, c, chauffeurRequest(inHours(30)));
    await request(app).post(`${API}/support`).set(bearer(c)).send({ category: 'other', message: 'Hello there' }).expect(201);

    const none = (await request(app).get(`${API}/admin/dashboard`).set(bearer(await signInAdmin(app, await createActiveAdmin('staff', [])))).expect(200)).body;
    expect(Object.keys(none)).toEqual(['generatedAt']);

    const ops = (await request(app).get(`${API}/admin/dashboard`).set(bearer(await signInAdmin(app, await createActiveAdmin('staff')))).expect(200)).body;
    expect(ops.bookings).toMatchObject({ awaitingQuote: 1, awaitingPayment: 0, inProgress: 0 });
    expect(ops.support).toMatchObject({ open: 1 });
    expect(ops.safety).toMatchObject({ openReports: 0 });
    expect(ops.notifications.providers.isDevelopment).toBe(true);
    expect(ops.partners).toBeDefined();
    expect(ops.finance).toBeUndefined(); // operations cannot see money

    const sa = (await request(app).get(`${API}/admin/dashboard`).set(bearer(await signInAdmin(app, await createActiveAdmin('super_admin')))).expect(200)).body;
    expect(sa.finance).toMatchObject({ refundsAwaitingApproval: 0, payableRwf: 0, developmentPayments: 0 });
  });
});

describe('reports', () => {
  it('operational report counts the real funnel, trips, drivers and ratings for the range', async () => {
    const w = await paid();
    await completed(w);
    await request(app).post(`${API}/bookings/${w.bookingId}/rating`).set(bearer(w.customer)).send({ stars: 4 }).expect(201);
    await book(app, w.customer, chauffeurRequest(inHours(50)));

    const r = (await request(app).get(`${API}/admin/reports/operations`).set(bearer(w.ops)).expect(200)).body;
    expect(r.range.to).toBe(kigaliDate(new Date()));
    expect(r.series).toHaveLength(30);
    expect(r.requests).toMatchObject({ total: 2, byService: { chauffeur: 2 }, byChannel: { web: 2 } });
    expect(r.funnel).toMatchObject({ requested: 2, quoted: 1, paid: 1, assigned: 1, completed: 1, cancelled: 0 });
    expect(r.trips.completed).toBe(1);
    expect(r.ratings).toMatchObject({ count: 1, average: 4, low: 0 });
    expect(r.drivers).toEqual([expect.objectContaining({ id: w.driver.userId, name: 'Eric Driver', completed: 1, averageRating: 4 })]);
    expect(r.series.at(-1)).toMatchObject({ requests: 2, completed: 1 });

    // An empty range in the past finds nothing.
    const past = (await request(app).get(`${API}/admin/reports/operations?from=2025-01-01&to=2025-01-31`).set(bearer(w.ops)).expect(200)).body;
    expect(past.requests.total).toBe(0);
    await request(app).get(`${API}/admin/reports/operations?from=2026-02-01&to=2026-01-01`).set(bearer(w.ops)).expect(400);
    await request(app).get(`${API}/admin/reports/operations?from=2024-01-01&to=2026-01-01`).set(bearer(w.ops)).expect(400);
    await request(app).get(`${API}/admin/reports/operations?from=2026-13-45`).set(bearer(w.ops)).expect(400);
  });

  it('financial report keeps development payments apart from real money, and exports the ledger as CSV', async () => {
    const w = await paid();
    await completed(w);
    const r = (await request(app).get(`${API}/admin/reports/finance`).set(bearer(w.sa)).expect(200)).body;
    expect(r.real).toMatchObject({ customerPaymentsRwf: 0, platformNetRwf: 0 });
    expect(r.development).toMatchObject({ customerPaymentsRwf: 45_000, platformCommissionRwf: 9_000, driverEarningsRwf: 13_500, vehicleOwnerEarningsRwf: 22_500, platformNetRwf: 9_000 });
    expect(r.developmentBookings).toBe(1);
    expect(r.owedToPartnersNow.held).toBe(36_000);
    expect(r.rows.every((row: { development: boolean }) => row.development)).toBe(true);

    const csv = await request(app).get(`${API}/admin/reports/finance?format=csv`).set(bearer(w.sa)).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="ridewell-ledger-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toBe('date_kigali,at_utc,type,party,amount_rwf,booking_ref,service,external_ref,memo,development_no_money_moved');
    expect(lines.length).toBe(1 + r.entries);
    expect(lines.find((l) => l.includes('"customer_payment"'))).toContain('"45000"');
    expect(await auditActions()).toContain('finance.exported');
    await request(app).get(`${API}/admin/reports/finance`).set(bearer(w.ops)).expect(403);
  });

  it('CSV cells cannot smuggle spreadsheet formulas', () => {
    const csv = financeCsv({ rows: [{ at: new Date('2026-01-01T00:00:00Z'), type: 'adjustment', party: 'platform', amountRwf: -500, bookingRef: null, service: null, externalRef: '=HYPERLINK("http://x")', memo: '+cmd', development: false }] } as never);
    expect(csv).toContain('"\'=HYPERLINK(""http://x"")"');
    expect(csv).toContain('"\'+cmd"');
    expect(csv).toContain('"-500"');
  });

  it('Kigali day boundaries are UTC+2', () => {
    expect(kigaliDayStart(new Date('2026-03-10T21:30:00Z')).toISOString()).toBe('2026-03-09T22:00:00.000Z');
    expect(kigaliDate(new Date('2026-03-10T22:30:00Z'))).toBe('2026-03-11');
  });
});
