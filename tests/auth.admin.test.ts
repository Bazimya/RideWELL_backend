import { describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { authenticator } from 'otplib';
import { API, CLIENT, auditActions, bearer, createActiveAdmin, freshTotp, lastOtpTo, refreshCookieFrom, signInAdmin, signInCustomer, testApp, type TestAdmin } from './helpers.js';
import { createStaffAccount } from '../src/modules/auth/adminAuth.service.js';
import { PERMISSIONS } from '../src/modules/users/permissions.js';
import { readOutbox } from '../src/modules/notifications/adapters/outbox.js';

const app = testApp();
const users = () => mongoose.connection.db!.collection('users');
const PW = 'Correct-Horse-Battery-42';

async function superAdmin(): Promise<{ admin: TestAdmin; s: Awaited<ReturnType<typeof signInAdmin>> }> {
  const admin = await createActiveAdmin('super_admin');
  return { admin, s: await signInAdmin(app, admin) };
}

describe('staff accounts created by a Super Admin', () => {
  it('Super Admin creates a staff account with a password and ticked permissions; the staff member sets up 2FA at first sign-in', async () => {
    const { admin, s } = await superAdmin();
    const body = { email: 'grace@ridewell.test', phone: '0788555001', firstName: 'Grace', lastName: 'Ops', password: 'Lake-Kivu-Sunset-2026', permissions: ['partners.view', 'audit.view'] };

    const noCode = await request(app).post(`${API}/admin/staff`).set(bearer(s)).send(body).expect(401);
    expect(noCode.body.error.code).toBe('step_up_required');
    const created = await request(app).post(`${API}/admin/staff`).set(bearer(s)).set('X-2FA-Code', await freshTotp(admin)).send(body).expect(201);

    const row = await users().findOne({ email: 'grace@ridewell.test' });
    expect(row!.roles).toEqual(['staff']);
    expect(row!.permissions).toEqual(['partners.view', 'audit.view']);
    expect(row!.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(row!.twoFactor.enabled).toBe(false);
    expect(created.body.id).toBe(String(row!._id));

    // First sign-in: password → set up authenticator → confirm → signed in with recovery codes.
    const step1 = await request(app).post(`${API}/auth/admin/login`).send({ email: body.email, password: body.password }).expect(200);
    expect(step1.body.setupRequired).toBe(true);
    await request(app).post(`${API}/auth/admin/login/mfa`).send({ mfaToken: step1.body.mfaToken, code: '123456' }).expect(409);
    const setup = await request(app).post(`${API}/auth/admin/2fa/setup`).send({ mfaToken: step1.body.mfaToken }).expect(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/RideWELL:/);
    await request(app).post(`${API}/auth/admin/2fa/confirm`).send({ mfaToken: step1.body.mfaToken, code: '000000' }).expect(400);
    const done = await request(app)
      .post(`${API}/auth/admin/2fa/confirm`)
      .send({ mfaToken: step1.body.mfaToken, code: authenticator.generate(setup.body.secret) })
      .expect(200);
    expect(done.body.recoveryCodes).toHaveLength(10);
    expect(done.body.user.permissions).toEqual(['partners.view', 'audit.view']);
    expect(refreshCookieFrom(done)).toMatch(/^rw_rt=/);

    // Only what was ticked.
    const staff = { accessToken: done.body.accessToken } as never;
    await request(app).get(`${API}/admin/audit-logs`).set(bearer(staff)).expect(200);
    await request(app).get(`${API}/admin/partners/applications?kind=driver`).set(bearer(staff)).expect(200);
    await request(app).get(`${API}/admin/users`).set(bearer(staff)).expect(403);
    await request(app).get(`${API}/admin/config`).set(bearer(staff)).expect(403);
    await request(app).get(`${API}/admin/staff`).set(bearer(staff)).expect(403);
    await request(app).post(`${API}/auth/admin/2fa/setup`).send({ mfaToken: step1.body.mfaToken }).expect(409);

    expect(await auditActions()).toEqual(expect.arrayContaining(['staff.created', 'auth.two_factor_enabled', 'auth.admin_login']));
    const entry = await mongoose.connection.db!.collection('auditLogs').findOne({ action: 'staff.created' });
    expect(String(entry!.actorId)).toBe(admin.userId);
  });

  it('changing permissions takes effect on the staff member’s very next request', async () => {
    const { admin, s } = await superAdmin();
    const staff = await createActiveAdmin('staff', ['partners.view']);
    const ss = await signInAdmin(app, staff);
    await request(app).get(`${API}/admin/users`).set(bearer(ss)).expect(403);

    await request(app).put(`${API}/admin/staff/${staff.userId}`).set(bearer(s)).set('X-2FA-Code', await freshTotp(admin)).send({ permissions: ['partners.view', 'users.view'] }).expect(204);
    await request(app).get(`${API}/admin/users`).set(bearer(ss)).expect(200);
    const me = await request(app).get(`${API}/me`).set(bearer(ss)).expect(200);
    expect(me.body.user.permissions).toEqual(['partners.view', 'users.view']);

    await request(app).put(`${API}/admin/staff/${staff.userId}`).set(bearer(s)).set('X-2FA-Code', await freshTotp(admin)).send({ permissions: [] }).expect(204);
    await request(app).get(`${API}/admin/partners/applications?kind=driver`).set(bearer(ss)).expect(403);
    const audit = await mongoose.connection.db!.collection('auditLogs').findOne({ action: 'staff.updated' }, { sort: { at: 1, _id: 1 } });
    expect(audit!.before.permissions).toEqual(['partners.view']);
  });

  it('refuses unknown permissions and roles sneaked into the request', async () => {
    const { admin, s } = await superAdmin();
    const base = { email: 'x@ridewell.test', firstName: 'X', lastName: 'Y', password: 'Lake-Kivu-Sunset-2026' };
    await request(app).post(`${API}/admin/staff`).set(bearer(s)).set('X-2FA-Code', await freshTotp(admin)).send({ ...base, permissions: ['staff.manage'] }).expect(400);
    await request(app).post(`${API}/admin/staff`).set(bearer(s)).set('X-2FA-Code', await freshTotp(admin)).send({ ...base, roles: ['super_admin'] }).expect(400);
  });

  it('staff can never manage staff, whatever permissions they hold', async () => {
    const all = ['partners.view', 'partners.review', 'partners.suspend', 'documents.view', 'users.view', 'users.suspend', 'audit.view', 'config.view', 'config.edit'] as const;
    const staff = await createActiveAdmin('staff', [...all]);
    const ss = await signInAdmin(app, staff);
    const other = await createActiveAdmin('staff');
    const code = await freshTotp(staff);
    await request(app)
      .post(`${API}/admin/staff`)
      .set(bearer(ss))
      .set('X-2FA-Code', code)
      .send({ email: 'y@ridewell.test', firstName: 'Y', lastName: 'Z', password: 'Lake-Kivu-Sunset-2026', accountType: 'super_admin' })
      .expect(403);
    await request(app).put(`${API}/admin/staff/${staff.userId}`).set(bearer(ss)).set('X-2FA-Code', code).send({ permissions: [...all] }).expect(403);
    await request(app).delete(`${API}/admin/staff/${other.userId}`).set(bearer(ss)).set('X-2FA-Code', code).send({ reason: 'test' }).expect(403);
  });

  it('refuses weak passwords and a password containing the person’s name', async () => {
    const { admin, s } = await superAdmin();
    for (const password of ['short', 'password1234', 'Mugisha-2026-secure']) {
      const res = await request(app)
        .post(`${API}/admin/staff`)
        .set(bearer(s))
        .set('X-2FA-Code', await freshTotp(admin))
        .send({ email: 'mugisha@ridewell.test', firstName: 'Mugisha', lastName: 'Eric', password, permissions: [] })
        .expect(400);
      expect(res.body.error.code).toBe('weak_password');
    }
  });

  it('allows at most two super admins', async () => {
    await createActiveAdmin('super_admin');
    await createActiveAdmin('super_admin');
    await expect(
      createStaffAccount(
        { email: 'third@ridewell.test', firstName: 'Third', lastName: 'Founder', password: PW, accountType: 'super_admin', permissions: [] },
        { type: 'system', name: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'super_admin_limit' });
  });

  it('refuses a staff account on an email or phone another account already uses', async () => {
    await signInCustomer(app, '0788555004');
    await expect(
      createStaffAccount(
        { email: 'x@ridewell.test', phone: '+250788555004', firstName: 'X', lastName: 'Y', password: PW, accountType: 'staff', permissions: [] },
        { type: 'system', name: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'account_exists' });
  });

  it('Super Admin sets a new password: the staff member is signed out and the old password stops working', async () => {
    const { admin, s } = await superAdmin();
    const staff = await createActiveAdmin('staff');
    const ss = await signInAdmin(app, staff);
    await request(app).post(`${API}/admin/staff/${staff.userId}/password`).set(bearer(s)).set('X-2FA-Code', await freshTotp(admin)).send({ password: 'Nyiragongo-Ridge-Path-7' }).expect(204);
    await request(app).get(`${API}/me`).set(bearer(ss)).expect(401);
    await request(app).post(`${API}/auth/admin/login`).send({ email: staff.email, password: staff.password }).expect(401);
    await request(app).post(`${API}/auth/admin/login`).send({ email: staff.email, password: 'Nyiragongo-Ridge-Path-7' }).expect(200);
  });

  it('resetting a staff member’s 2FA signs them out and requires setup again', async () => {
    const { admin, s } = await superAdmin();
    const staff = await createActiveAdmin('staff');
    const ss = await signInAdmin(app, staff);
    await request(app).post(`${API}/admin/staff/${staff.userId}/reset-2fa`).set(bearer(s)).set('X-2FA-Code', await freshTotp(admin)).expect(204);
    await request(app).get(`${API}/me`).set(bearer(ss)).expect(401);
    const step1 = await request(app).post(`${API}/auth/admin/login`).send({ email: staff.email, password: staff.password }).expect(200);
    expect(step1.body.setupRequired).toBe(true);
  });

  it('removes a staff account: roles stripped, sessions ended; a super admin cannot remove themselves', async () => {
    const { admin, s } = await superAdmin();
    const staff = await createActiveAdmin('staff');
    const ss = await signInAdmin(app, staff);
    await request(app).delete(`${API}/admin/staff/${staff.userId}`).set(bearer(s)).set('X-2FA-Code', await freshTotp(admin)).send({ reason: 'left the company' }).expect(204);
    await request(app).get(`${API}/me`).set(bearer(ss)).expect(401);
    const u = await users().findOne({ email: staff.email });
    expect(u!.roles).toEqual([]);
    expect(u!.status).toBe('suspended');
    await request(app).delete(`${API}/admin/staff/${admin.userId}`).set(bearer(s)).set('X-2FA-Code', await freshTotp(admin)).send({ reason: 'oops' }).expect(403);
  });

  it('lists staff with their effective permissions', async () => {
    const { s } = await superAdmin();
    await createActiveAdmin('staff', ['audit.view']);
    const res = await request(app).get(`${API}/admin/staff`).set(bearer(s)).expect(200);
    const kinds = res.body.staff.map((x: { accountType: string; permissions: string[] }) => [x.accountType, x.permissions.length]);
    expect(kinds).toContainEqual(['staff', 1]);
    expect(kinds).toContainEqual(['super_admin', PERMISSIONS.length]);
  });
});

describe('staff sign-in (password + authenticator)', () => {
  it('opens an 8-hour admin session', async () => {
    const admin = await createActiveAdmin('staff');
    const before = Date.now();
    const s = await signInAdmin(app, admin);
    const me = await request(app).get(`${API}/me`).set(bearer(s)).expect(200);
    expect(me.body.sessionKind).toBe('admin');
    const sess = await mongoose.connection.db!.collection('sessions').findOne({ userId: new mongoose.Types.ObjectId(admin.userId) }, { sort: { _id: -1 } });
    const hours = ((sess!.expiresAt as Date).getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(7.99);
    expect(hours).toBeLessThan(8.01);
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const admin = await createActiveAdmin('staff');
    const wrongPw = await request(app).post(`${API}/auth/admin/login`).send({ email: admin.email, password: 'Wrong-password-123' });
    const noUser = await request(app).post(`${API}/auth/admin/login`).send({ email: 'nobody@ridewell.test', password: 'Wrong-password-123' });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.error).toMatchObject({ code: noUser.body.error.code, message: noUser.body.error.message });
  });

  it('locks the account for 15 minutes after 5 failures, without revealing the lock', async () => {
    const admin = await createActiveAdmin('staff');
    for (let i = 0; i < 5; i++) await request(app).post(`${API}/auth/admin/login`).send({ email: admin.email, password: 'Wrong-password-123' }).expect(401);
    const res = await request(app).post(`${API}/auth/admin/login`).send({ email: admin.email, password: admin.password }).expect(401);
    expect(res.body.error.code).toBe('invalid_credentials');
    expect(await auditActions()).toContain('auth.account_locked');
  });

  it('counts wrong authenticator codes towards the lock', async () => {
    const admin = await createActiveAdmin('staff');
    const step1 = await request(app).post(`${API}/auth/admin/login`).send({ email: admin.email, password: admin.password }).expect(200);
    for (let i = 0; i < 5; i++) await request(app).post(`${API}/auth/admin/login/mfa`).send({ mfaToken: step1.body.mfaToken, code: '000000' }).expect(401);
    const next = await request(app).post(`${API}/auth/admin/login/mfa`).send({ mfaToken: step1.body.mfaToken, code: await freshTotp(admin) });
    expect(next.status).toBe(429);
  });

  it('refuses to reuse an authenticator code (replay protection)', async () => {
    const admin = await createActiveAdmin('staff');
    const code = await freshTotp(admin);
    const a = await request(app).post(`${API}/auth/admin/login`).send({ email: admin.email, password: admin.password });
    await request(app).post(`${API}/auth/admin/login/mfa`).send({ mfaToken: a.body.mfaToken, code }).expect(200);
    const b = await request(app).post(`${API}/auth/admin/login`).send({ email: admin.email, password: admin.password });
    await request(app).post(`${API}/auth/admin/login/mfa`).send({ mfaToken: b.body.mfaToken, code }).expect(401);
  });

  it('accepts a recovery code exactly once', async () => {
    await createStaffAccount(
      { email: 'rec@ridewell.test', firstName: 'Rec', lastName: 'Overy', password: PW, accountType: 'staff', permissions: [] },
      { type: 'system', name: 'test' },
    );
    const s1 = await request(app).post(`${API}/auth/admin/login`).send({ email: 'rec@ridewell.test', password: PW });
    const setup = await request(app).post(`${API}/auth/admin/2fa/setup`).send({ mfaToken: s1.body.mfaToken });
    const conf = await request(app).post(`${API}/auth/admin/2fa/confirm`).send({ mfaToken: s1.body.mfaToken, code: authenticator.generate(setup.body.secret) });
    const recoveryCode = conf.body.recoveryCodes[0];
    const login = async () =>
      request(app)
        .post(`${API}/auth/admin/login/mfa`)
        .send({ mfaToken: (await request(app).post(`${API}/auth/admin/login`).send({ email: 'rec@ridewell.test', password: PW })).body.mfaToken, recoveryCode });
    expect((await login()).status).toBe(200);
    expect((await login()).status).toBe(401);
  });

  it('refuses an MFA token used as an access token, and an access token used as an MFA token', async () => {
    const admin = await createActiveAdmin('staff');
    const step1 = await request(app).post(`${API}/auth/admin/login`).send({ email: admin.email, password: admin.password });
    await request(app).get(`${API}/me`).set('Authorization', `Bearer ${step1.body.mfaToken}`).expect(401);
    const s = await signInAdmin(app, admin);
    await request(app).post(`${API}/auth/admin/login/mfa`).send({ mfaToken: s.accessToken, code: await freshTotp(admin) }).expect(401);
  });

  it('logs a sign-in from a new device, but not from a known one', async () => {
    const admin = await createActiveAdmin('staff');
    const login = async (cookie?: string) => {
      const step1 = await request(app).post(`${API}/auth/admin/login`).send({ email: admin.email, password: admin.password });
      const req = request(app).post(`${API}/auth/admin/login/mfa`);
      if (cookie) req.set('Cookie', cookie);
      return req.send({ mfaToken: step1.body.mfaToken, code: await freshTotp(admin) });
    };
    const count = async () => (await auditActions()).filter((a) => a === 'auth.admin_new_device').length;
    const base = await count();
    const first = await login();
    const device = ([] as string[]).concat(first.headers['set-cookie'] ?? []).find((c) => c.startsWith('rw_did='))!.split(';')[0]!;
    await login(device);
    expect((await count()) - base).toBe(1);
    await login();
    expect((await count()) - base).toBe(2);
  });

  it('refreshing an admin session never extends it past 8 hours', async () => {
    const admin = await createActiveAdmin('staff');
    const s = await signInAdmin(app, admin);
    const sess = await mongoose.connection.db!.collection('sessions').findOne({ userId: new mongoose.Types.ObjectId(admin.userId) }, { sort: { _id: -1 } });
    const r = await request(app).post(`${API}/auth/refresh`).set(CLIENT).set('Cookie', s.cookie).expect(200);
    const after = await mongoose.connection.db!.collection('sessions').findOne({ _id: sess!._id });
    expect((after!.expiresAt as Date).getTime()).toBe((sess!.expiresAt as Date).getTime());
    await mongoose.connection.db!.collection('sessions').updateOne({ _id: sess!._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    await request(app).post(`${API}/auth/refresh`).set(CLIENT).set('Cookie', refreshCookieFrom(r)).expect(401);
    await request(app).get(`${API}/me`).set('Authorization', `Bearer ${r.body.accessToken}`).expect(401);
  });

  it('an admin session stops working the moment 2FA is switched off on the account', async () => {
    const admin = await createActiveAdmin('staff');
    const s = await signInAdmin(app, admin);
    await users().updateOne({ email: admin.email }, { $set: { 'twoFactor.enabled': false } });
    await request(app).get(`${API}/me`).set(bearer(s)).expect(401);
  });
});

describe('staff password reset (SMS code + authenticator)', () => {
  it('resets the password and signs the staff member out everywhere', async () => {
    const admin = await createActiveAdmin('staff');
    const s = await signInAdmin(app, admin);
    await request(app).post(`${API}/auth/admin/password-reset/request`).send({ email: admin.email }).expect(202);
    const code = await lastOtpTo(admin.phone);
    await request(app).post(`${API}/auth/admin/password-reset/confirm`).send({ email: admin.email, code, totpCode: '000000', newPassword: 'Another-Long-Passphrase-9' }).expect(400);
    await mongoose.connection.db!.collection('otpStates').updateMany({}, { $set: { lastSentAt: new Date(0) } });
    await request(app).post(`${API}/auth/admin/password-reset/request`).send({ email: admin.email }).expect(202);
    const code2 = await lastOtpTo(admin.phone);
    await request(app)
      .post(`${API}/auth/admin/password-reset/confirm`)
      .send({ email: admin.email, code: code2, totpCode: await freshTotp(admin), newPassword: 'Another-Long-Passphrase-9' })
      .expect(204);
    await request(app).get(`${API}/me`).set(bearer(s)).expect(401);
    await request(app).post(`${API}/auth/admin/login`).send({ email: admin.email, password: 'Another-Long-Passphrase-9' }).expect(200);
    expect(await auditActions()).toContain('auth.admin_password_reset');
  });

  it('answers the same for unknown emails and sends nothing', async () => {
    const res = await request(app).post(`${API}/auth/admin/password-reset/request`).send({ email: 'nobody@ridewell.test' }).expect(202);
    expect(res.body.status).toMatch(/If this is an admin account/);
    expect(await readOutbox(process.env.OUTBOX_DIR!, 'sms')).toHaveLength(0);
  });
});

describe('suspending customers (users.suspend permission)', () => {
  it('suspends and reactivates a customer, ending their sessions', async () => {
    const staff = await createActiveAdmin('staff', ['users.view', 'users.suspend']);
    const s = await signInAdmin(app, staff);
    const c = await signInCustomer(app, '0788555030');
    await request(app).post(`${API}/admin/users/${c.userId}/suspend`).set(bearer(s)).send({ reason: 'fraud report' }).expect(204);
    await request(app).get(`${API}/me`).set(bearer(c)).expect(401);
    await request(app).post(`${API}/admin/users/${c.userId}/reactivate`).set(bearer(s)).send({ reason: 'cleared' }).expect(204);
    expect(await auditActions()).toEqual(expect.arrayContaining(['user.suspended', 'user.reactivated']));
  });

  it('staff without users.suspend cannot suspend anyone', async () => {
    const staff = await createActiveAdmin('staff', ['users.view']);
    const s = await signInAdmin(app, staff);
    const c = await signInCustomer(app, '0788555031');
    await request(app).post(`${API}/admin/users/${c.userId}/suspend`).set(bearer(s)).send({ reason: 'test only' }).expect(403);
  });
});
