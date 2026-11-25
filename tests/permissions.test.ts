import { describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { API, bearer, createActiveAdmin, freshTotp, signInAdmin, signInCustomer, testApp, type SignedIn } from './helpers.js';
import { createSession } from '../src/modules/auth/token.service.js';
import { jpegWithGps, upload } from './fixtures.js';

const app = testApp();
const someId = new mongoose.Types.ObjectId().toHexString();

/**
 * Callers: anonymous, customer, driver (Driver / Chauffeur), vehicle owner,
 * staff with no permissions, staff with the Operations preset, staff holding only
 * `audit.view`, and a super admin.
 */
type Who = 'anonymous' | 'customer' | 'driver' | 'vehicle' | 'staffNone' | 'staffOps' | 'staffAudit' | 'super';
const ALL: Who[] = ['anonymous', 'customer', 'driver', 'vehicle', 'staffNone', 'staffOps', 'staffAudit', 'super'];
const PARTNERS: Who[] = ['customer', 'driver', 'vehicle'];

const ROUTES: Array<{ method: 'get' | 'post' | 'put' | 'delete' | 'patch'; path: string; allowed: Who[]; body?: object }> = [
  { method: 'get', path: '/me', allowed: [...PARTNERS, 'staffNone', 'staffOps', 'staffAudit', 'super'] },
  { method: 'put', path: '/me/password', allowed: PARTNERS, body: {} },
  { method: 'get', path: '/partners/driver', allowed: PARTNERS },
  { method: 'get', path: '/partners/owner', allowed: PARTNERS },
  { method: 'get', path: '/admin/permissions', allowed: ['staffNone', 'staffOps', 'staffAudit', 'super'] },
  { method: 'get', path: '/admin/users', allowed: ['staffOps', 'super'] },
  { method: 'post', path: `/admin/users/${someId}/suspend`, allowed: ['super'], body: { reason: 'test only' } },
  { method: 'get', path: '/admin/staff', allowed: ['super'] },
  { method: 'post', path: '/admin/staff', allowed: ['super'], body: {} },
  { method: 'put', path: `/admin/staff/${someId}`, allowed: ['super'], body: {} },
  { method: 'delete', path: `/admin/staff/${someId}`, allowed: ['super'], body: { reason: 'test only' } },
  { method: 'get', path: '/admin/audit-logs', allowed: ['staffOps', 'staffAudit', 'super'] },
  { method: 'get', path: '/admin/config', allowed: ['staffOps', 'super'] },
  { method: 'put', path: '/admin/config', allowed: ['super'], body: {} },
  { method: 'get', path: '/admin/partners/applications?kind=driver', allowed: ['staffOps', 'super'] },
  { method: 'get', path: `/admin/partners/vehicle/${someId}`, allowed: ['staffOps', 'super'] },
  { method: 'post', path: `/admin/partners/driver/${someId}/decision`, allowed: ['staffOps', 'super'], body: { decision: 'approve' } },
  { method: 'post', path: `/admin/partners/driver/${someId}/suspend`, allowed: ['staffOps', 'super'], body: { reason: 'test only' } },
  { method: 'post', path: `/admin/partners/documents/${someId}/review`, allowed: ['staffOps', 'super'], body: { decision: 'approved' } },
  { method: 'get', path: '/admin/finance/ledger', allowed: ['super'] },
  { method: 'get', path: '/admin/finance/summary', allowed: ['super'] },
  { method: 'post', path: '/admin/finance/refunds', allowed: ['staffOps', 'super'], body: {} },
  { method: 'post', path: `/admin/finance/refunds/${someId}/approve`, allowed: ['super'], body: {} },
  { method: 'post', path: '/admin/finance/payouts', allowed: ['super'], body: {} },
  { method: 'get', path: '/admin/finance/payables', allowed: ['super'] },
  { method: 'get', path: '/partners/earnings', allowed: ['driver', 'vehicle'] },
  { method: 'get', path: '/admin/bookings', allowed: ['staffOps', 'super'] },
  { method: 'get', path: `/bookings/${someId}/tracking`, allowed: PARTNERS },
  { method: 'post', path: `/driver/trips/${someId}/location`, allowed: ['driver'], body: { lat: -1.95, lng: 30.06, accuracyM: 10, recordedAt: new Date().toISOString() } },
  { method: 'get', path: `/driver/trips/${someId}/tracking`, allowed: ['driver'] },
  { method: 'get', path: `/owner/trips/${someId}/tracking`, allowed: ['vehicle'] },
  { method: 'get', path: `/admin/bookings/${someId}/tracking`, allowed: ['staffOps', 'super'] },
  { method: 'post', path: `/admin/bookings/${someId}/tracking-access`, allowed: ['staffOps', 'super'], body: { reason: 'test only reason' } },
  // Phase 7: dashboards, reports, notifications, ratings, support
  { method: 'get', path: '/me/dashboard', allowed: PARTNERS },
  { method: 'get', path: '/me/notifications', allowed: [...PARTNERS, 'staffNone', 'staffOps', 'staffAudit', 'super'] },
  { method: 'post', path: '/me/notifications/read', allowed: [...PARTNERS, 'staffNone', 'staffOps', 'staffAudit', 'super'], body: {} },
  { method: 'get', path: '/admin/dashboard', allowed: ['staffNone', 'staffOps', 'staffAudit', 'super'] },
  { method: 'get', path: '/admin/reports/operations', allowed: ['staffOps', 'super'] },
  { method: 'get', path: '/admin/reports/finance', allowed: ['super'] },
  { method: 'get', path: '/admin/reports/finance?format=csv', allowed: ['super'] },
  { method: 'get', path: '/admin/notifications', allowed: ['staffOps', 'super'] },
  { method: 'post', path: `/admin/notifications/${someId}/resend`, allowed: ['staffOps', 'super'] },
  { method: 'get', path: '/support', allowed: PARTNERS },
  { method: 'post', path: '/support', allowed: PARTNERS, body: { category: 'other', message: 'test only' } },
  { method: 'get', path: '/admin/support', allowed: ['staffOps', 'super'] },
  { method: 'post', path: `/admin/support/${someId}/resolve`, allowed: ['staffOps', 'super'], body: { reply: 'test only' } },
  { method: 'post', path: `/bookings/${someId}/rating`, allowed: PARTNERS, body: { stars: 5 } },
  { method: 'get', path: '/driver/ratings', allowed: ['driver'] },
];

async function partner(role: 'driver_partner' | 'vehicle_partner', phone: string): Promise<SignedIn> {
  const s = await signInCustomer(app, phone);
  await mongoose.connection.db!.collection('users').updateOne({ _id: new mongoose.Types.ObjectId(s.userId) }, { $set: { roles: ['customer', role] } });
  return s;
}

describe('permission matrix: every protected route refuses every caller without the right permission', () => {
  it('enforces the matrix', async () => {
    const who: Record<Exclude<Who, 'anonymous'>, SignedIn> = {
      customer: await signInCustomer(app, '0788100001'),
      driver: await partner('driver_partner', '0788100002'),
      vehicle: await partner('vehicle_partner', '0788100003'),
      staffNone: await signInAdmin(app, await createActiveAdmin('staff', [])),
      staffOps: await signInAdmin(app, await createActiveAdmin('staff')),
      staffAudit: await signInAdmin(app, await createActiveAdmin('staff', ['audit.view'])),
      super: await signInAdmin(app, await createActiveAdmin('super_admin')),
    };

    for (const route of ROUTES) {
      for (const role of ALL) {
        const req = request(app)[route.method](`${API}${route.path}`);
        if (role !== 'anonymous') req.set(bearer(who[role]));
        const res = await (route.body ? req.send(route.body) : req);
        const label = `${route.method.toUpperCase()} ${route.path} as ${role}`;
        if (role === 'anonymous') expect(res.status, label).toBe(401);
        else if (!route.allowed.includes(role)) expect(res.status, label).toBe(403);
        else {
          // Allowed callers get past the permission gate. A step-up route then asks for an
          // authenticator code (401 step_up_required): that is the next gate, not a refusal.
          const refused = res.status === 403 || (res.status === 401 && res.body.error?.code !== 'step_up_required');
          expect(refused, `${label} was refused (${res.status})`).toBe(false);
        }
      }
    }
  });

  it('admin accounts do not work through a non-admin session (e.g. one forged without 2FA)', async () => {
    const staff = await createActiveAdmin('staff');
    const s = await createSession({ userId: staff.userId, kind: 'user' });
    await request(app).get(`${API}/admin/users`).set('Authorization', `Bearer ${s.accessToken}`).expect(401);
  });

  it('a partner role on a customer never unlocks admin routes', async () => {
    const d = await partner('driver_partner', '0788100009');
    await request(app).get(`${API}/admin/audit-logs`).set(bearer(d)).expect(403);
  });

  it('config.edit is refused without the permission even with a valid authenticator code', async () => {
    const staff = await createActiveAdmin('staff');
    const s = await signInAdmin(app, staff);
    await request(app).put(`${API}/admin/config`).set(bearer(s)).set('X-2FA-Code', await freshTotp(staff)).send({}).expect(403);
  });

  it('documents.view is needed to open a partner document', async () => {
    const driver = await signInCustomer(app, '0788100010');
    const up = await upload(app, driver, '/partners/driver/documents', 'profile_photo', await jpegWithGps());
    const docId = up.body.documents[0].id;
    const reviewer = await signInAdmin(app, await createActiveAdmin('staff', ['partners.view', 'partners.review']));
    await request(app).post(`${API}/documents/${docId}/link`).set(bearer(reviewer)).expect(404);
    const withDocs = await signInAdmin(app, await createActiveAdmin('staff', ['partners.view', 'documents.view']));
    await request(app).post(`${API}/documents/${docId}/link`).set(bearer(withDocs)).expect(200);
  });
});
