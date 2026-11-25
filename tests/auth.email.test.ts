import { describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { API, auditActions, bearer, createActiveAdmin, refreshCookieFrom, signInCustomer, testApp } from './helpers.js';

const app = testApp();
const PW = 'Kivu-Lakeside-Sunrise-42';

function register(email = 'aline@example.com', password = PW) {
  return request(app).post(`${API}/auth/email/register`).send({ email, password, firstName: 'Aline', lastName: 'Uwase' });
}
function login(email = 'aline@example.com', password = PW) {
  return request(app).post(`${API}/auth/email/login`).send({ email, password });
}

describe('email + password accounts', () => {
  it('registers a customer with email and password and opens a session', async () => {
    const res = await register().expect(201);
    expect(res.body.user).toMatchObject({ email: 'aline@example.com', phone: null, roles: ['customer'], emailVerified: false, hasPassword: true });
    expect(refreshCookieFrom(res)).toMatch(/^rw_rt=/);
    await request(app).get(`${API}/me`).set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
    expect(await auditActions()).toEqual(['user.registered', 'auth.login']);
  });

  it('signs in with email and password; the email is case-insensitive', async () => {
    await register().expect(201);
    const res = await login('ALINE@Example.com').expect(200);
    expect(res.body.user.email).toBe('aline@example.com');
  });

  it('refuses a second account with the same email', async () => {
    await register().expect(201);
    const res = await register('Aline@example.com').expect(409);
    expect(res.body.error.code).toBe('email_taken');
  });

  it('refuses weak passwords, including ones containing the name or email', async () => {
    for (const pw of ['short1!', 'password1234', 'aline-uwase-2026', 'Aline@example.com1']) {
      const res = await register('weak@example.com', pw).expect(400);
      expect(res.body.error.code).toBe('weak_password');
    }
  });

  it('gives the same answer for unknown email, wrong password and admin accounts', async () => {
    await register().expect(201);
    const admin = await createActiveAdmin('staff');
    const a = await login('nobody@example.com').expect(401);
    const b = await login('aline@example.com', 'Wrong-Password-123').expect(401);
    const c = await login(admin.email, admin.password).expect(401);
    expect(new Set([a.body.error.message, b.body.error.message, c.body.error.message]).size).toBe(1);
  });

  it('locks the account after 5 wrong passwords, even for the right one', async () => {
    await register().expect(201);
    for (let i = 0; i < 5; i++) await login('aline@example.com', 'Wrong-Password-123').expect(401);
    await login().expect(401);
    expect(await auditActions()).toContain('auth.account_locked');
  });

  it('a phone (SMS) customer can add an email and password, then sign in either way', async () => {
    const s = await signInCustomer(app, '0788500001');
    await request(app).put(`${API}/me/password`).set(bearer(s)).send({ newPassword: PW }).expect(400); // no email yet
    await request(app).patch(`${API}/me`).set(bearer(s)).send({ email: 'phoneuser@example.com' }).expect(200);
    await request(app).put(`${API}/me/password`).set(bearer(s)).send({ newPassword: PW }).expect(204);
    const res = await login('phoneuser@example.com').expect(200);
    expect(res.body.user.phone).toBe('+250788500001');
  });

  it('changing a password needs the current one and signs out other sessions', async () => {
    const first = await register().expect(201);
    const other = await login().expect(200);
    const s = { accessToken: first.body.accessToken } as never;
    const bad = await request(app).put(`${API}/me/password`).set(bearer(s)).send({ newPassword: 'Another-Long-Phrase-9' }).expect(400);
    expect(bad.body.error.code).toBe('wrong_password');
    await request(app).put(`${API}/me/password`).set(bearer(s)).send({ currentPassword: PW, newPassword: 'Another-Long-Phrase-9' }).expect(204);
    await request(app).get(`${API}/me`).set('Authorization', `Bearer ${other.body.accessToken}`).expect(401); // other session ended
    await request(app).get(`${API}/me`).set(bearer(s)).expect(200); // this one kept
    await login('aline@example.com', 'Another-Long-Phrase-9').expect(200);
    expect(await auditActions()).toContain('auth.password_changed');
  });

  it('refuses a suspended account with a clear message after the right password', async () => {
    await register().expect(201);
    await mongoose.connection.db!.collection('users').updateOne({ email: 'aline@example.com' }, { $set: { status: 'suspended' } });
    const res = await login().expect(403);
    expect(res.body.error.code).toBe('account_suspended');
  });

  it('cannot send roles or status at sign-up', async () => {
    const res = await request(app)
      .post(`${API}/auth/email/register`)
      .send({ email: 'x@example.com', password: PW, firstName: 'X', lastName: 'Y', roles: ['super_admin'] })
      .expect(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});
