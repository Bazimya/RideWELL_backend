import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { API, bearer, signInCustomer, testApp } from './helpers.js';
import { loadEnv } from '../src/config/env.js';

const app = testApp();

describe('API security basics', () => {
  it('rejects MongoDB operator injection in body and query', async () => {
    const body = await request(app).post(`${API}/auth/otp/verify`).send({ phone: { $gt: '' }, code: { $ne: null } }).expect(400);
    expect(body.body.error.code).toBe('invalid_input');
    const s = await signInCustomer(app);
    await request(app).get(`${API}/me?$where=1`).set(bearer(s)).expect(400);
    await request(app).patch(`${API}/me`).set(bearer(s)).send({ 'twoFactor.enabled': false }).expect(400);
    await request(app).patch(`${API}/me`).set(bearer(s)).send(JSON.parse('{"__proto__": {"roles": ["super_admin"]}}')).expect(400);
  });

  it('rejects unknown fields instead of ignoring them', async () => {
    const res = await request(app).post(`${API}/auth/otp/request`).send({ phone: '0788123456', role: 'super_admin' }).expect(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('returns generic errors with no stack traces', async () => {
    const res = await request(app).post(`${API}/auth/otp/request`).set('Content-Type', 'application/json').send('{"phone": ').expect(400);
    expect(res.body.error.code).toBe('invalid_json');
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
    const nf = await request(app).get('/api/v1/does-not-exist').expect(404);
    expect(nf.body.error.code).toBe('not_found');
  });

  it('sends security headers and no framework fingerprint', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('allows CORS only for configured origins', async () => {
    const ok = await request(app).options(`${API}/me`).set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'GET');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await request(app).options(`${API}/me`).set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('caps request body size', async () => {
    const res = await request(app).post(`${API}/auth/otp/request`).send({ phone: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
  });
});

describe('configuration guards', () => {
  const base = {
    MONGODB_URI: 'mongodb://localhost/x',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    HASH_PEPPER: 'b'.repeat(32),
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  it('refuses to start production with development-only adapters or insecure settings', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://ridewell.rw' })).toThrow(/SMS_PROVIDER=outbox/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'http://ridewell.rw' })).toThrow(/https/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false', CORS_ORIGINS: 'https://ridewell.rw' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://ridewell.rw' })).toThrow(/MAPS_PROVIDER=dev/);
    expect(() => loadEnv({ ...base, MAPS_PROVIDER: 'google' })).toThrow(/MAPS_SERVER_KEY/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://ridewell.rw', DEV_RATE_LIMIT_ADMIN_LOGIN: '100' })).toThrow(/DEV_RATE_LIMIT_ADMIN_LOGIN/);
  });

  it('refuses short secrets and a malformed encryption key', () => {
    expect(() => loadEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadEnv({ ...base, DATA_ENCRYPTION_KEY: 'abc' })).toThrow(/DATA_ENCRYPTION_KEY/);
  });
});
