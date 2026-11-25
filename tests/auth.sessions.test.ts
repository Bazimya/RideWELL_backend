import { describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { API, CLIENT, auditActions, bearer, refreshCookieFrom, signInCustomer, testApp } from './helpers.js';

const app = testApp();

describe('sessions and refresh tokens', () => {
  it('rotates the refresh token on every use', async () => {
    const s = await signInCustomer(app);
    const r1 = await request(app).post(`${API}/auth/refresh`).set(CLIENT).set('Cookie', s.cookie).expect(200);
    const c1 = refreshCookieFrom(r1);
    expect(c1).not.toBe(s.cookie);
    expect(r1.body.accessToken).toBeTypeOf('string');
    const r2 = await request(app).post(`${API}/auth/refresh`).set(CLIENT).set('Cookie', c1).expect(200);
    expect(refreshCookieFrom(r2)).not.toBe(c1);
  });

  it('detects reuse of a rotated refresh token and ends the whole session', async () => {
    const s = await signInCustomer(app);
    const r1 = await request(app).post(`${API}/auth/refresh`).set(CLIENT).set('Cookie', s.cookie).expect(200);
    // The old token is replayed (e.g. it was stolen):
    await request(app).post(`${API}/auth/refresh`).set(CLIENT).set('Cookie', s.cookie).expect(401);
    // ...so even the legitimate newest token no longer works, and neither does the access token.
    await request(app).post(`${API}/auth/refresh`).set(CLIENT).set('Cookie', refreshCookieFrom(r1)).expect(401);
    await request(app).get(`${API}/me`).set('Authorization', `Bearer ${r1.body.accessToken}`).expect(401);
    expect(await auditActions()).toContain('auth.refresh_reuse_detected');
  });

  it('lets only one of two concurrent refreshes with the same token succeed', async () => {
    const s = await signInCustomer(app);
    const [a, b] = await Promise.all([
      request(app).post(`${API}/auth/refresh`).set(CLIENT).set('Cookie', s.cookie),
      request(app).post(`${API}/auth/refresh`).set(CLIENT).set('Cookie', s.cookie),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });

  it('requires the client header on cookie-authenticated routes (CSRF defence)', async () => {
    const s = await signInCustomer(app);
    const res = await request(app).post(`${API}/auth/refresh`).set('Cookie', s.cookie).expect(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('logout revokes the session immediately, including its unexpired access token', async () => {
    const s = await signInCustomer(app);
    await request(app).post(`${API}/auth/logout`).set(CLIENT).set(bearer(s)).expect(204);
    await request(app).get(`${API}/me`).set(bearer(s)).expect(401);
    await request(app).post(`${API}/auth/refresh`).set(CLIENT).set('Cookie', s.cookie).expect(401);
  });

  it('logout-all ends every session of the user', async () => {
    const a = await signInCustomer(app, '0788000001');
    await mongoose.connection.db!.collection('otpStates').updateMany({}, { $set: { lastSentAt: new Date(0) } });
    const b = await signInCustomer(app, '0788000001');
    await request(app).post(`${API}/auth/logout-all`).set(CLIENT).set(bearer(a)).expect(204);
    await request(app).get(`${API}/me`).set(bearer(b)).expect(401);
  });

  it('suspending a user takes effect on their very next request', async () => {
    const s = await signInCustomer(app);
    await mongoose.connection.db!.collection('users').updateOne(
      { _id: new mongoose.Types.ObjectId(s.userId) },
      { $set: { status: 'suspended' } },
    );
    await request(app).get(`${API}/me`).set(bearer(s)).expect(401);
    await request(app).post(`${API}/auth/refresh`).set(CLIENT).set('Cookie', s.cookie).expect(401);
  });

  it('refuses forged, expired, wrong-audience and alg=none tokens', async () => {
    const s = await signInCustomer(app);
    const claims = jwt.decode(s.accessToken) as jwt.JwtPayload;
    const forged = jwt.sign({ sid: claims.sid, typ: 'access' }, 'not-the-real-secret-not-the-real-secret', {
      subject: claims.sub,
      issuer: 'ridewell-api',
      audience: 'ridewell-web',
    });
    const expired = jwt.sign({ sid: claims.sid, typ: 'access' }, process.env.JWT_ACCESS_SECRET!, {
      subject: claims.sub,
      issuer: 'ridewell-api',
      audience: 'ridewell-web',
      expiresIn: -10,
    });
    const wrongAud = jwt.sign({ sid: claims.sid, typ: 'access' }, process.env.JWT_ACCESS_SECRET!, {
      subject: claims.sub,
      issuer: 'ridewell-api',
      audience: 'ridewell-web:mfa',
    });
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({ ...claims }),
    ).toString('base64url')}.`;
    for (const t of [forged, expired, wrongAud, none, 'garbage']) {
      await request(app).get(`${API}/me`).set('Authorization', `Bearer ${t}`).expect(401);
    }
  });

  it('never accepts the access token in a cookie or query string', async () => {
    const s = await signInCustomer(app);
    await request(app).get(`${API}/me?access_token=${s.accessToken}`).expect(401);
    await request(app).get(`${API}/me`).set('Cookie', `access_token=${s.accessToken}`).expect(401);
  });

  it('gives customer sessions a 30-day absolute expiry', async () => {
    const before = Date.now();
    await signInCustomer(app);
    const sess = await mongoose.connection.db!.collection('sessions').findOne({});
    const days = ((sess!.expiresAt as Date).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
  });

  it('stores refresh tokens only as hashes', async () => {
    const s = await signInCustomer(app);
    const secret = decodeURIComponent(s.cookie.split('=')[1]!).split('.')[1]!;
    const sess = await mongoose.connection.db!.collection('sessions').findOne({});
    expect(JSON.stringify(sess)).not.toContain(secret);
  });
});
