import { describe, expect, it, afterEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { API, auditActions, bearer, createActiveAdmin, lastSmsTo, signInAdmin, signInCustomer, testApp, type SignedIn } from './helpers.js';
import { approvedDriver, approvedVehicle, book, chauffeurRequest, inHours, quote } from './bookingFixtures.js';
import { withTransaction } from '../src/db/transaction.js';
import { saveConfigVersion } from '../src/modules/platformConfig/platformConfig.service.js';
import { DEV_PLACEHOLDER_CONFIG, type PlatformConfigValues } from '../src/modules/platformConfig/platformConfig.schema.js';
import { attachTrackingSocket, TRACKING_WS_PATH } from '../src/modules/tracking/tracking.ws.js';
import { GoogleMapsProvider } from '../src/modules/maps/maps.provider.js';
import { OpsAlertModel } from '../src/modules/bookings/alerts.js';

const app = testApp();
const db = () => mongoose.connection.db!;
const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** Kigali Marriott (pickup), a point ~6 km away, and one ~300 m away. */
const PICKUP = { address: 'Kigali Marriott Hotel, KN 3 Ave', lat: -1.9536, lng: 30.0605 };
const FAR = { lat: -1.99, lng: 30.1 };
const NEAR = { lat: -1.9555, lng: 30.0625 };

interface Trip {
  customer: SignedIn;
  driver: SignedIn;
  owner: SignedIn;
  bookingId: string;
  driverPhone: string;
  customerPhone: string;
}

let n = 0;
/** An assigned chauffeur trip. The tracking window is widened so the trip is inside it (bookings need 60 min notice). */
async function assignedTrip(opts: { startHours?: number; durationHours?: number; config?: Partial<PlatformConfigValues> } = {}): Promise<Trip> {
  await withTransaction((s) =>
    saveConfigVersion({ values: { ...DEV_PLACEHOLDER_CONFIG, trackingWindowBeforePickupMinutes: 120, ...opts.config }, isPlaceholder: true, createdBySystem: 'test' }, s),
  );
  n++;
  const customerPhone = `07887${String(n).padStart(2, '0')}100`;
  const customer = await signInCustomer(app, customerPhone);
  const ops = await signInAdmin(app, await createActiveAdmin('staff'));
  const d = await approvedDriver(`07887${String(n).padStart(2, '0')}101`);
  const v = await approvedVehicle(`07887${String(n).padStart(2, '0')}102`);
  const b = await book(app, customer, chauffeurRequest(inHours(opts.startHours ?? 1.5), { pickup: PICKUP, durationHours: opts.durationHours ?? 2 }));
  expect((await quote(app, ops, b.id, { amountRwf: 45_000, driverId: d.userId, vehicleId: v.vehicleId, durationHours: opts.durationHours ?? 2 })).status).toBe(200);
  await request(app).post(`${API}/bookings/${b.id}/pay`).set(bearer(customer)).expect(200);
  const driver = await signInCustomer(app, d.phone);
  const owner = await signInCustomer(app, v.ownerPhone);
  await request(app).post(`${API}/driver/trips/${b.id}/accept`).set(bearer(driver)).expect(200);
  await request(app).post(`${API}/owner/trips/${b.id}/accept`).set(bearer(owner)).expect(200);
  return { customer, driver, owner, bookingId: b.id, driverPhone: d.phone, customerPhone };
}

const send = (t: Trip, p: { lat: number; lng: number }, extra: object = {}) =>
  request(app).post(`${API}/driver/trips/${t.bookingId}/location`).set(bearer(t.driver)).send({ ...p, accuracyM: 12, recordedAt: new Date().toISOString(), ...extra });
/** Let the next point through the per-interval throttle. */
const ageLastPoint = (t: Trip) => db().collection('bookings').updateOne({ _id: oid(t.bookingId) }, { $set: { 'tracking.lastPoint.receivedAt': new Date(Date.now() - 60_000) } });
const startTrip = async (t: Trip) => {
  const pin = (await request(app).get(`${API}/bookings/${t.bookingId}`).set(bearer(t.customer))).body.tripPin;
  await request(app).post(`${API}/driver/trips/${t.bookingId}/start`).set(bearer(t.driver)).send({ pin }).expect(200);
};
const points = (t: Trip) => db().collection('locationPoints').find({ bookingId: oid(t.bookingId) }).toArray();

describe('location sharing and viewing', () => {
  it('opens only inside the window: nothing before, nothing shown to the customer', async () => {
    const t = await assignedTrip({ startHours: 5 });
    const res = await send(t, FAR).expect(409);
    expect(res.body.error.code).toBe('tracking_not_open');
    const view = (await request(app).get(`${API}/bookings/${t.bookingId}/tracking`).set(bearer(t.customer)).expect(200)).body;
    expect(view.state).toBe('not_yet');
    expect(view.driverLocation).toBeNull();
    expect(await points(t)).toHaveLength(0);
  });

  it('the driver shares; the customer sees the point with its time and accuracy and a labelled straight-line distance', async () => {
    const t = await assignedTrip();
    expect((await send(t, FAR).expect(200)).body).toMatchObject({ accepted: true, nextInSeconds: 10 });
    // Faster than half the interval: acknowledged, not stored.
    expect((await send(t, FAR).expect(200)).body).toMatchObject({ accepted: false, reason: 'too_soon' });
    expect(await points(t)).toHaveLength(1);

    const view = (await request(app).get(`${API}/bookings/${t.bookingId}/tracking`).set(bearer(t.customer)).expect(200)).body;
    expect(view.state).toBe('open');
    expect(view.driverLocation).toMatchObject({ lat: FAR.lat, lng: FAR.lng, accuracyM: 12 });
    expect(view.driverLocation.recordedAt).toBeTruthy();
    // Development maps: distance as the crow flies, no invented travel time.
    expect(view.estimate).toMatchObject({ to: 'pickup', kind: 'straight_line', durationS: null });
    expect(view.estimate.distanceM).toBeGreaterThan(4000);
    expect(view.provider).toBe('dev');
  });

  it('refuses timestamps in the future or too old', async () => {
    const t = await assignedTrip();
    expect((await send(t, FAR, { recordedAt: new Date(Date.now() + 5 * 60_000).toISOString() })).body.error.code).toBe('bad_timestamp');
    expect((await send(t, FAR, { recordedAt: new Date(Date.now() - 30 * 60_000).toISOString() })).body.error.code).toBe('stale_point');
  });

  it('"driver approaching" is texted once, when the driver comes within 2 km of pickup', async () => {
    const t = await assignedTrip();
    await send(t, FAR).expect(200);
    await expect(lastSmsTo(t.customerPhone)).resolves.not.toMatch(/less than/);
    await ageLastPoint(t);
    await send(t, NEAR).expect(200);
    expect(await lastSmsTo(t.customerPhone)).toMatch(/less than 2 km from your pickup/);
    await ageLastPoint(t);
    await send(t, NEAR).expect(200);
    const sms = (await db().collection('bookings').findOne({ _id: oid(t.bookingId) }))!;
    expect(sms.tracking.approachingNotifiedAt).toBeTruthy();
    // Exactly one approaching message.
    const { readOutbox } = await import('../src/modules/notifications/adapters/outbox.js');
    const count = (await readOutbox(process.env.OUTBOX_DIR!, 'sms')).filter((m) => /less than 2 km/.test(m.text ?? '') && (m.text ?? '').includes(String(sms.ref))).length;
    expect(count).toBe(1);
  });

  it('nobody else can send or see it: other customers, other drivers, short-hire owners, anonymous callers', async () => {
    const t = await assignedTrip();
    await send(t, FAR).expect(200);
    const stranger = await signInCustomer(app, '0788799001');
    await request(app).get(`${API}/bookings/${t.bookingId}/tracking`).set(bearer(stranger)).expect(404);
    const otherDriver = await approvedDriver('0788799002');
    const od = await signInCustomer(app, otherDriver.phone);
    await request(app).post(`${API}/driver/trips/${t.bookingId}/location`).set(bearer(od)).send({ ...FAR, accuracyM: 5, recordedAt: new Date().toISOString() }).expect(404);
    await request(app).get(`${API}/driver/trips/${t.bookingId}/tracking`).set(bearer(od)).expect(404);
    // The customer cannot send points.
    await request(app).post(`${API}/driver/trips/${t.bookingId}/location`).set(bearer(t.customer)).send({ ...FAR, accuracyM: 5, recordedAt: new Date().toISOString() }).expect(403);
    // A 2-hour hire: the vehicle owner sees no live location (even during the trip) and no customer addresses.
    await startTrip(t);
    const ov = (await request(app).get(`${API}/owner/trips/${t.bookingId}/tracking`).set(bearer(t.owner)).expect(200)).body;
    expect(ov).toMatchObject({ state: 'closed', driverLocation: null, pickup: null, dropoff: null });
    for (const path of [`/bookings/${t.bookingId}/tracking`, `/driver/trips/${t.bookingId}/tracking`, `/owner/trips/${t.bookingId}/tracking`, `/admin/bookings/${t.bookingId}/tracking`]) {
      await request(app).get(`${API}${path}`).expect(401);
    }
    await request(app).post(`${API}/driver/trips/${t.bookingId}/location`).send({ ...FAR, accuracyM: 5, recordedAt: new Date().toISOString() }).expect(401);
    // No location in any public endpoint.
    const pub = await request(app).get(`${API}/public/prices`);
    expect(JSON.stringify(pub.body)).not.toMatch(/lat/);
  });

  it('owners of multi-day hires see their vehicle while the trip is in progress, without the customer addresses', async () => {
    const t = await assignedTrip({ durationHours: 30, config: { vehiclePartnerLiveTrackingMinHours: 24 } });
    await send(t, FAR).expect(200);
    expect((await request(app).get(`${API}/owner/trips/${t.bookingId}/tracking`).set(bearer(t.owner))).body.reason).toBe('not_in_progress');
    await startTrip(t);
    await ageLastPoint(t);
    await send(t, NEAR).expect(200);
    const ov = (await request(app).get(`${API}/owner/trips/${t.bookingId}/tracking`).set(bearer(t.owner)).expect(200)).body;
    expect(ov.state).toBe('open');
    expect(ov.driverLocation).toMatchObject(NEAR);
    expect(ov.pickup).toBeNull();
    expect(ov.dropoff).toBeNull();
  });

  it('stops on trip end: no more points, nothing shown, and points are scheduled for deletion 30 days after the end', async () => {
    const t = await assignedTrip();
    await send(t, FAR).expect(200);
    await startTrip(t);
    await request(app).post(`${API}/driver/trips/${t.bookingId}/complete`).set(bearer(t.driver)).expect(200);
    await ageLastPoint(t);
    expect((await send(t, NEAR).expect(409)).body.error.code).toBe('tracking_closed');
    const view = (await request(app).get(`${API}/bookings/${t.bookingId}/tracking`).set(bearer(t.customer)).expect(200)).body;
    expect(view).toMatchObject({ state: 'closed', driverLocation: null });
    const b = (await db().collection('bookings').findOne({ _id: oid(t.bookingId) }))!;
    for (const p of await points(t)) expect(Math.abs(p.purgeAt.getTime() - (b.endedAt.getTime() + 30 * 86_400_000))).toBeLessThan(1000);
    const idx = await db().collection('locationPoints').indexes();
    expect(idx.find((i) => i.key.purgeAt === 1)?.expireAfterSeconds).toBe(0);
  });

  it('stops on cancellation', async () => {
    const t = await assignedTrip();
    await send(t, FAR).expect(200);
    await request(app).post(`${API}/bookings/${t.bookingId}/cancel`).set(bearer(t.customer)).send({ reason: 'plans changed' }).expect(200);
    await ageLastPoint(t);
    expect((await send(t, NEAR).expect(409)).body.error.code).toBe('tracking_closed');
    expect((await points(t))[0]!.purgeAt).toBeInstanceOf(Date);
  });

  it('a new driver never inherits the previous driver’s position', async () => {
    const t = await assignedTrip();
    await send(t, FAR).expect(200);
    const ops = await signInAdmin(app, await createActiveAdmin('staff'));
    const d2 = await approvedDriver('0788799010', 'Jean');
    await request(app).post(`${API}/admin/bookings/${t.bookingId}/assign`).set(bearer(ops)).send({ driverId: d2.userId }).expect(200);
    const b = (await db().collection('bookings').findOne({ _id: oid(t.bookingId) }))!;
    expect(b.tracking.lastPoint.lat).toBeNull();
    expect(b.tracking.approachingNotifiedAt).toBeNull();
  });
});

describe('retention while a safety report is open', () => {
  it('keeps points while the report is open and puts them back on schedule when it is resolved', async () => {
    const t = await assignedTrip();
    await send(t, FAR).expect(200);
    await startTrip(t);
    await request(app).post(`${API}/bookings/${t.bookingId}/safety-report`).set(bearer(t.customer)).send({ message: 'Driver took a strange route' }).expect(201);
    await request(app).post(`${API}/driver/trips/${t.bookingId}/complete`).set(bearer(t.driver)).expect(200);
    for (const p of await points(t)) expect(p.purgeAt).toBeNull();
    const sa = await signInAdmin(app, await createActiveAdmin('super_admin'));
    const report = (await request(app).get(`${API}/admin/safety-reports`).set(bearer(sa))).body.reports.find((r: { bookingId: string }) => r.bookingId === t.bookingId);
    await request(app).post(`${API}/admin/safety-reports/${report.id}/resolve`).set(bearer(sa)).send({ resolution: 'Route checked with the driver: road works.', releaseDriver: true }).expect(204);
    for (const p of await points(t)) expect(p.purgeAt).toBeInstanceOf(Date);
  });
});

describe('staff break-glass access', () => {
  it('needs the permission, an open safety report or trip-not-started alert, and a reason; every access is logged', async () => {
    const t = await assignedTrip();
    await send(t, FAR).expect(200);
    const staff = await signInAdmin(app, await createActiveAdmin('staff', ['bookings.view', 'tracking.emergency']));
    const noPerm = await signInAdmin(app, await createActiveAdmin('staff', ['bookings.view', 'safety.handle']));

    // No emergency: nothing to open.
    expect((await request(app).get(`${API}/admin/bookings/${t.bookingId}/tracking`).set(bearer(staff)).expect(200)).body).toMatchObject({ eligible: false, access: null });
    expect((await request(app).post(`${API}/admin/bookings/${t.bookingId}/tracking-access`).set(bearer(staff)).send({ reason: 'Just checking where he is' }).expect(409)).body.error.code).toBe('no_emergency');

    // A trip-not-started alert opens the door, for this booking only.
    await OpsAlertModel.create({ type: 'trip_not_started', bookingId: oid(t.bookingId), bookingRef: 'X', message: 'not started', severity: 'high' });
    await request(app).get(`${API}/admin/bookings/${t.bookingId}/tracking`).set(bearer(noPerm)).expect(403);
    await request(app).post(`${API}/admin/bookings/${t.bookingId}/tracking-access`).set(bearer(staff)).send({ reason: 'short' }).expect(400);
    const opened = (await request(app).post(`${API}/admin/bookings/${t.bookingId}/tracking-access`).set(bearer(staff)).send({ reason: 'Driver not at pickup 30 min late, customer waiting' }).expect(201)).body;
    expect(opened).toMatchObject({ eligible: true, basis: 'trip_not_started' });
    expect(opened.access.driverLocation).toMatchObject(FAR);
    expect(opened.access.trail).toHaveLength(1);
    expect(await auditActions()).toEqual(expect.arrayContaining(['tracking.emergency_opened']));
    const audit = await db().collection('auditLogs').findOne({ action: 'tracking.emergency_opened', targetId: t.bookingId });
    expect(audit!.reason).toBe('Driver not at pickup 30 min late, customer waiting');

    // Another staff member must open their own access.
    const other = await signInAdmin(app, await createActiveAdmin('staff', ['tracking.emergency']));
    expect((await request(app).get(`${API}/admin/bookings/${t.bookingId}/tracking`).set(bearer(other))).body.access).toBeNull();

    // Alert resolved: access ends.
    await OpsAlertModel.updateMany({ bookingId: oid(t.bookingId) }, { $set: { resolvedAt: new Date() } });
    expect((await request(app).get(`${API}/admin/bookings/${t.bookingId}/tracking`).set(bearer(staff))).body).toMatchObject({ eligible: false, access: null });
  });

  it('views are audited (at most once a minute per access)', async () => {
    const t = await assignedTrip();
    await send(t, FAR).expect(200);
    await startTrip(t);
    await request(app).post(`${API}/bookings/${t.bookingId}/safety-report`).set(bearer(t.customer)).send({ message: 'I feel unsafe' }).expect(201);
    const staff = await signInAdmin(app, await createActiveAdmin('staff', ['tracking.emergency']));
    await request(app).post(`${API}/admin/bookings/${t.bookingId}/tracking-access`).set(bearer(staff)).send({ reason: 'Customer safety report during trip' }).expect(201);
    await db().collection('trackingAccess').updateMany({ bookingId: oid(t.bookingId) }, { $set: { lastAuditedAt: new Date(Date.now() - 120_000) } });
    await request(app).get(`${API}/admin/bookings/${t.bookingId}/tracking`).set(bearer(staff)).expect(200);
    await request(app).get(`${API}/admin/bookings/${t.bookingId}/tracking`).set(bearer(staff)).expect(200);
    const viewed = await db().collection('auditLogs').countDocuments({ action: 'tracking.emergency_viewed', targetId: t.bookingId });
    expect(viewed).toBe(1);
  });
});

describe('WebSocket', () => {
  let server: http.Server | null = null;
  afterEach(() => server?.close());

  async function open(origin = 'http://localhost:5173') {
    server = http.createServer(app);
    attachTrackingSocket(server);
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    return (headers: Record<string, string> = { Origin: origin }) => new WebSocket(`ws://127.0.0.1:${port}${TRACKING_WS_PATH}`, { headers });
  }
  const next = (ws: WebSocket) =>
    new Promise<{ type: string; code?: string; view?: { state: string; driverLocation: unknown } }>((resolve) => ws.once('message', (m) => resolve(JSON.parse(String(m)))));
  const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));

  it('refuses other sites and unauthenticated or unrelated subscribers', async () => {
    const connect = await open();
    const t = await assignedTrip();
    const evil = connect({ Origin: 'https://evil.example' });
    await new Promise((r) => evil.once('error', r));

    const anon = connect();
    await new Promise((r) => anon.once('open', r));
    anon.send(JSON.stringify({ type: 'subscribe', bookingId: t.bookingId, as: 'customer' }));
    expect(await closed(anon)).toBe(4401);

    const badToken = connect();
    await new Promise((r) => badToken.once('open', r));
    badToken.send(JSON.stringify({ type: 'auth', token: 'not-a-token' }));
    expect(await closed(badToken)).toBe(4401);

    const stranger = await signInCustomer(app, '0788799020');
    const s = connect();
    await new Promise((r) => s.once('open', r));
    s.send(JSON.stringify({ type: 'auth', token: stranger.accessToken }));
    expect((await next(s)).type).toBe('ready');
    s.send(JSON.stringify({ type: 'subscribe', bookingId: t.bookingId, as: 'customer' }));
    expect(await closed(s)).toBe(4404);
  });

  it('pushes each new point to the customer and closes when the trip ends', async () => {
    const connect = await open();
    const t = await assignedTrip();
    const ws = connect();
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: t.customer.accessToken }));
    expect((await next(ws)).type).toBe('ready');
    ws.send(JSON.stringify({ type: 'subscribe', bookingId: t.bookingId, as: 'customer' }));
    const first = await next(ws);
    expect(first.view).toMatchObject({ state: 'open', driverLocation: null });

    const pushed = next(ws);
    await send(t, FAR).expect(200);
    expect((await pushed).view!.driverLocation).toMatchObject(FAR);

    await startTrip(t);
    const end = closed(ws);
    await request(app).post(`${API}/driver/trips/${t.bookingId}/complete`).set(bearer(t.driver)).expect(200);
    expect(await end).toBe(1000);
  });
});

describe('Google Maps adapter (request shapes; not yet verified against live Google: no key)', () => {
  function fakeFetch(responses: unknown[]) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = responses.shift();
      return { ok: body !== 'fail', status: body === 'fail' ? 500 : 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  it('autocomplete: Rwanda, biased to Kigali, session token, key in a header (never the URL)', async () => {
    const { f, calls } = fakeFetch([{ suggestions: [{ placePrediction: { placeId: 'ChIJabc123456', text: { text: 'Kigali Marriott Hotel, Kigali' }, structuredFormat: { mainText: { text: 'Kigali Marriott Hotel' }, secondaryText: { text: 'KN 3 Ave, Kigali' } } } }, { queryPrediction: {} }] }]);
    const g = new GoogleMapsProvider('server-key-123456', f);
    const out = await g.autocomplete('marriott', 'session-token-1');
    expect(out).toEqual([{ placeId: 'ChIJabc123456', primary: 'Kigali Marriott Hotel', secondary: 'KN 3 Ave, Kigali' }]);
    expect(calls[0]!.url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(calls[0]!.url).not.toContain('server-key');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('server-key-123456');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ input: 'marriott', sessionToken: 'session-token-1', includedRegionCodes: ['rw'] });
  });

  it('place details and route use field masks; a failed route falls back to a labelled straight line', async () => {
    const { f, calls } = fakeFetch([
      { id: 'ChIJabc123456', displayName: { text: 'Kigali Marriott Hotel' }, formattedAddress: 'KN 3 Ave, Kigali, Rwanda', location: { latitude: -1.9536, longitude: 30.0605 } },
      { routes: [{ duration: '754s', distanceMeters: 6120, polyline: { encodedPolyline: 'abc' } }] },
      'fail',
    ]);
    const g = new GoogleMapsProvider('server-key-123456', f);
    expect(await g.place('ChIJabc123456', 'session-token-1')).toEqual({ placeId: 'ChIJabc123456', address: 'Kigali Marriott Hotel, KN 3 Ave, Kigali, Rwanda', lat: -1.9536, lng: 30.0605 });
    expect((calls[0]!.init.headers as Record<string, string>)['X-Goog-FieldMask']).toBe('id,displayName,formattedAddress,location');
    expect(await g.route(FAR, PICKUP)).toEqual({ distanceM: 6120, durationS: 754, polyline: 'abc', kind: 'route' });
    expect((calls[1]!.init.headers as Record<string, string>)['X-Goog-FieldMask']).toBe('routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline');
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE' });
    const fallback = await g.route(FAR, PICKUP);
    expect(fallback.kind).toBe('straight_line');
    expect(fallback.durationS).toBeNull();
  });
});

describe('maps routes in development', () => {
  it('say search is unavailable instead of inventing places', async () => {
    expect((await request(app).get(`${API}/maps/config`).expect(200)).body).toEqual({ provider: 'dev', search: false, browserKey: null });
    expect((await request(app).get(`${API}/maps/autocomplete?q=marriott&session=abcdefgh12`).expect(200)).body).toEqual({ available: false, suggestions: [] });
    await request(app).get(`${API}/maps/place/ChIJabc123456`).expect(404);
    expect((await request(app).get(`${API}/maps/reverse?lat=-1.95&lng=30.06`).expect(200)).body).toEqual({ address: null });
    await request(app).get(`${API}/maps/autocomplete?q=ab&session=abcdefgh12`).expect(400);
  });
});
