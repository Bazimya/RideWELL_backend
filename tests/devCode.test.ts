import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { API, bearer, createActiveAdmin, testApp } from './helpers.js';
import { createStaffAccount } from '../src/modules/auth/adminAuth.service.js';
import { loadEnv, resetEnvCache } from '../src/config/env.js';

afterEach(() => {
  delete process.env.DEV_VERIFICATION_CODE;
  resetEnvCache();
});

describe('development verification code', () => {
  it('when set, SMS codes are that fixed code (shown in the response), with every limit still applied', async () => {
    process.env.DEV_VERIFICATION_CODE = '123456';
    resetEnvCache();
    const app = testApp();
    const res = await request(app).post(`${API}/auth/otp/request`).send({ phone: '0788999001' }).expect(202);
    expect(res.body.developmentCode).toBe('123456');
    await request(app).post(`${API}/auth/otp/verify`).send({ phone: '0788999001', code: '654321' }).expect(400);
    const ok = await request(app).post(`${API}/auth/otp/verify`).send({ phone: '0788999001', code: '123456' }).expect(200);
    expect(ok.body.user.phone).toBe('+250788999001');
    // Still single use.
    await request(app).post(`${API}/auth/otp/verify`).send({ phone: '0788999001', code: '123456' }).expect(400);
  });

  it('when not set, codes are random and never returned', async () => {
    const app = testApp();
    const res = await request(app).post(`${API}/auth/otp/request`).send({ phone: '0788999002' }).expect(202);
    expect(res.body.developmentCode).toBeUndefined();
  });

  it('when set, staff sign in with it without authenticator setup, and it confirms sensitive actions', async () => {
    process.env.DEV_VERIFICATION_CODE = '123456';
    resetEnvCache();
    const app = testApp();
    await createStaffAccount(
      { email: 'dev.staff@ridewell.test', firstName: 'Dev', lastName: 'Staff', password: 'Correct-Horse-Battery-42', accountType: 'super_admin', permissions: [] },
      { type: 'system', name: 'test' },
    );
    const step1 = await request(app).post(`${API}/auth/admin/login`).send({ email: 'dev.staff@ridewell.test', password: 'Correct-Horse-Battery-42' }).expect(200);
    expect(step1.body).toMatchObject({ setupRequired: false, developmentCode: '123456' });
    await request(app).post(`${API}/auth/admin/login/mfa`).send({ mfaToken: step1.body.mfaToken, code: '000000' }).expect(401);
    const ok = await request(app).post(`${API}/auth/admin/login/mfa`).send({ mfaToken: step1.body.mfaToken, code: '123456' }).expect(200);
    const s = { accessToken: ok.body.accessToken } as never;
    await request(app).get(`${API}/admin/staff`).set(bearer(s)).expect(200);
    // Step-up with the development code.
    await request(app)
      .post(`${API}/admin/staff`)
      .set(bearer(s))
      .set('X-2FA-Code', '123456')
      .send({ email: 'new@ridewell.test', firstName: 'New', lastName: 'Person', password: 'Lake-Kivu-Sunset-2026', permissions: ['audit.view'] })
      .expect(201);
    // An account with a real authenticator still accepts real codes too.
    const real = await createActiveAdmin('staff');
    const r1 = await request(app).post(`${API}/auth/admin/login`).send({ email: real.email, password: real.password }).expect(200);
    await request(app).post(`${API}/auth/admin/login/mfa`).send({ mfaToken: r1.body.mfaToken, code: '123456' }).expect(200);
  });

  it('when not set, staff without 2FA must set it up and the code is never returned', async () => {
    const app = testApp();
    await createStaffAccount(
      { email: 'real.staff@ridewell.test', firstName: 'Real', lastName: 'Staff', password: 'Correct-Horse-Battery-42', accountType: 'staff', permissions: [] },
      { type: 'system', name: 'test' },
    );
    const step1 = await request(app).post(`${API}/auth/admin/login`).send({ email: 'real.staff@ridewell.test', password: 'Correct-Horse-Battery-42' }).expect(200);
    expect(step1.body.setupRequired).toBe(true);
    expect(step1.body.developmentCode).toBeUndefined();
    await request(app).post(`${API}/auth/admin/login/mfa`).send({ mfaToken: step1.body.mfaToken, code: '123456' }).expect(409);
  });

  it('is refused in production and must be 6 digits', () => {
    const base = {
      MONGODB_URI: 'mongodb://localhost/x',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      HASH_PEPPER: 'b'.repeat(32),
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    };
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', DEV_VERIFICATION_CODE: '123456', CORS_ORIGINS: 'https://ridewell.rw' })).toThrow(/DEV_VERIFICATION_CODE/);
    expect(() => loadEnv({ ...base, DEV_VERIFICATION_CODE: '12ab' })).toThrow(/DEV_VERIFICATION_CODE/);
  });
});
