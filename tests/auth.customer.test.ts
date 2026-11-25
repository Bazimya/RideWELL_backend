import { describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { API, auditActions, bearer, createActiveAdmin, lastOtpTo, signInCustomer, testApp } from './helpers.js';
import { readOutbox } from '../src/modules/notifications/adapters/outbox.js';
import { createApp } from '../src/app.js';

const app = testApp();
const phone = '0788123456';
const e164 = '+250788123456';

function requestCode(p = phone) {
  return request(app).post(`${API}/auth/otp/request`).send({ phone: p });
}

describe('customer sign-up and sign-in by SMS code', () => {
  it('registers a new customer on first verified code and returns a session', async () => {
    await requestCode().expect(202);
    const code = await lastOtpTo(phone);
    const res = await request(app).post(`${API}/auth/otp/verify`).send({ phone, code }).expect(200);

    expect(res.body.isNewUser).toBe(true);
    expect(res.body.user).toMatchObject({ phone: e164, roles: ['customer'], status: 'active' });
    expect(res.body.accessToken).toBeTypeOf('string');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/rw_rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

    const me = await request(app).get(`${API}/me`).set(bearer({ accessToken: res.body.accessToken } as never)).expect(200);
    expect(me.body.user.phone).toBe(e164);
    expect(await auditActions()).toEqual(['user.registered', 'auth.login']);
  });

  it('signs an existing customer back in without creating a second account', async () => {
    await signInCustomer(app, phone);
    await new Promise((r) => setTimeout(r, 0));
    await mongoose.connection.db!.collection('otpStates').updateMany({}, { $set: { lastSentAt: new Date(0) } });
    await requestCode().expect(202);
    const res = await request(app).post(`${API}/auth/otp/verify`).send({ phone, code: await lastOtpTo(phone) }).expect(200);
    expect(res.body.isNewUser).toBe(false);
    expect(await mongoose.connection.db!.collection('users').countDocuments()).toBe(1);
  });

  it('stores only a hash of the code, never the code itself', async () => {
    await requestCode().expect(202);
    const code = await lastOtpTo(phone);
    const state = await mongoose.connection.db!.collection('otpStates').findOne({ phone: e164 });
    expect(JSON.stringify(state)).not.toContain(code);
  });

  it('accepts local and international formats as the same phone', async () => {
    await requestCode('+250 788 123 456').expect(202);
    const res = await request(app).post(`${API}/auth/otp/verify`).send({ phone: '0788123456', code: await lastOtpTo(phone) });
    expect(res.status).toBe(200);
  });

  it('rejects an invalid phone number', async () => {
    const res = await requestCode('12345').expect(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('rejects a wrong code, and a used code cannot be used again', async () => {
    await requestCode().expect(202);
    const code = await lastOtpTo(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await request(app).post(`${API}/auth/otp/verify`).send({ phone, code: wrong }).expect(400);
    expect(bad.body.error.code).toBe('invalid_code');
    await request(app).post(`${API}/auth/otp/verify`).send({ phone, code }).expect(200);
    const reuse = await request(app).post(`${API}/auth/otp/verify`).send({ phone, code }).expect(400);
    expect(reuse.body.error.code).toBe('invalid_code');
  });

  it('locks the phone for 15 minutes after 5 wrong attempts, even with the right code', async () => {
    await requestCode().expect(202);
    const code = await lastOtpTo(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) await request(app).post(`${API}/auth/otp/verify`).send({ phone, code: wrong }).expect(400);
    const fifth = await request(app).post(`${API}/auth/otp/verify`).send({ phone, code: wrong }).expect(429);
    expect(Number(fifth.headers['retry-after'])).toBe(900);
    await request(app).post(`${API}/auth/otp/verify`).send({ phone, code }).expect(429);
    await requestCode().expect(429);
  });

  it('counts parallel guesses atomically: at most 5 attempts are ever evaluated', async () => {
    await requestCode().expect(202);
    const code = await lastOtpTo(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    const results = await Promise.all(
      Array.from({ length: 12 }, () => request(app).post(`${API}/auth/otp/verify`).send({ phone, code: wrong })),
    );
    // Requests beyond the 5th are refused before any comparison (400 or 429 depending
    // on whether the lock was already written); the counter itself never passes 5.
    expect(results.every((r) => r.status === 400 || r.status === 429)).toBe(true);
    const state = await mongoose.connection.db!.collection('otpStates').findOne({ phone: e164 });
    expect(state!.failedAttempts).toBe(5);
    expect(state!.lockedUntil).toBeInstanceOf(Date);
    // ...and the real code is now refused too.
    await request(app).post(`${API}/auth/otp/verify`).send({ phone, code }).expect(429);
  });

  it('refuses a correct code once it has expired', async () => {
    await requestCode().expect(202);
    const code = await lastOtpTo(phone);
    await mongoose.connection.db!.collection('otpStates').updateOne({ phone: e164 }, { $set: { codeExpiresAt: new Date(Date.now() - 1) } });
    const res = await request(app).post(`${API}/auth/otp/verify`).send({ phone, code }).expect(400);
    expect(res.body.error.code).toBe('invalid_code');
  });

  it('sets a 10-minute expiry on new codes', async () => {
    const before = Date.now();
    await requestCode().expect(202);
    const state = await mongoose.connection.db!.collection('otpStates').findOne({ phone: e164 });
    const ttl = (state!.codeExpiresAt as Date).getTime() - before;
    expect(ttl).toBeGreaterThan(9.9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 2000);
  });

  it('enforces a resend cooldown', async () => {
    await requestCode().expect(202);
    const res = await requestCode().expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never sends an SMS sign-in code to an admin account, and says nothing about it', async () => {
    const admin = await createActiveAdmin('staff');
    const res = await request(app).post(`${API}/auth/otp/request`).send({ phone: admin.phone }).expect(202);
    expect(res.body).toEqual({ status: 'sent', expiresInSeconds: 600 });
    const sms = await readOutbox(process.env.OUTBOX_DIR!, 'sms');
    expect(sms.filter((m) => m.to === admin.phone)).toHaveLength(0);
  });

  it('refuses sign-in for a suspended account after a correct code', async () => {
    await signInCustomer(app, phone);
    await mongoose.connection.db!.collection('users').updateOne({ phone: e164 }, { $set: { status: 'suspended' } });
    await mongoose.connection.db!.collection('otpStates').updateMany({}, { $set: { lastSentAt: new Date(0) } });
    await requestCode().expect(202);
    const res = await request(app).post(`${API}/auth/otp/verify`).send({ phone, code: await lastOtpTo(phone) }).expect(403);
    expect(res.body.error.code).toBe('account_suspended');
  });

  it('rate-limits code requests per IP', async () => {
    const limited = createApp({ rateLimits: { otpRequest: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await request(limited).post(`${API}/auth/otp/request`).send({ phone: `07881000${10 + i}` })).status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
  });
});

describe('profile', () => {
  it('lets a customer set their name and email, but never their roles or status', async () => {
    const s = await signInCustomer(app, phone);
    const ok = await request(app).patch(`${API}/me`).set(bearer(s)).send({ firstName: 'Aline', email: 'Aline@Example.com' }).expect(200);
    expect(ok.body.user).toMatchObject({ firstName: 'Aline', email: 'aline@example.com', roles: ['customer'] });

    for (const body of [{ roles: ['super_admin'] }, { status: 'active' }, { firstName: 'X', role: 'ops_admin' }]) {
      const res = await request(app).patch(`${API}/me`).set(bearer(s)).send(body).expect(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
    const me = await request(app).get(`${API}/me`).set(bearer(s)).expect(200);
    expect(me.body.user.roles).toEqual(['customer']);
  });

  it('refuses an email already used by another account', async () => {
    const a = await signInCustomer(app, '0788000011');
    const b = await signInCustomer(app, '0788000012');
    await request(app).patch(`${API}/me`).set(bearer(a)).send({ email: 'same@example.com' }).expect(200);
    const res = await request(app).patch(`${API}/me`).set(bearer(b)).send({ email: 'same@example.com' }).expect(409);
    expect(res.body.error.code).toBe('email_taken');
  });
});
