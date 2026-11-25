import mongoose from 'mongoose';
import request from 'supertest';
import { authenticator } from 'otplib';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { readOutbox } from '../src/modules/notifications/adapters/outbox.js';
import { confirmTwoFactorSetup, createStaffAccount, startTwoFactorSetup } from '../src/modules/auth/adminAuth.service.js';
import { signMfaChallenge } from '../src/modules/auth/token.service.js';
import { PERMISSION_PRESETS, type Permission } from '../src/modules/users/permissions.js';
import { normalizePhone } from '../src/lib/phone.js';

export const API = '/api/v1';
export const CLIENT = { 'X-RideWELL-Client': 'web' };

/** App with rate limits raised so functional tests are not throttled. */
export function testApp() {
  return createApp({ rateLimits: { otpRequest: 10_000, otpVerify: 10_000, adminLogin: 10_000, passwordLogin: 10_000, upload: 10_000, booking: 10_000, general: 100_000 } });
}

export async function lastSmsTo(phone: string): Promise<string> {
  const e164 = normalizePhone(phone)!;
  const msgs = (await readOutbox(process.env.OUTBOX_DIR!, 'sms')).filter((m) => m.to === e164);
  const text = msgs.at(-1)?.text;
  if (!text) throw new Error(`No SMS sent to ${e164}`);
  return text;
}

export async function lastOtpTo(phone: string): Promise<string> {
  const match = (await lastSmsTo(phone)).match(/\b(\d{6})\b/);
  if (!match) throw new Error('No code in SMS');
  return match[1]!;
}

export function refreshCookieFrom(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const c = cookies.find((x) => x.startsWith('rw_rt='));
  if (!c) throw new Error('No refresh cookie set');
  return c.split(';')[0]!;
}

export interface SignedIn {
  userId: string;
  accessToken: string;
  cookie: string;
}

export async function signInCustomer(app: ReturnType<typeof testApp>, phone = '0788000001'): Promise<SignedIn> {
  await request(app).post(`${API}/auth/otp/request`).send({ phone }).expect(202);
  const code = await lastOtpTo(phone);
  const res = await request(app).post(`${API}/auth/otp/verify`).send({ phone, code }).expect(200);
  return { userId: res.body.user.id, accessToken: res.body.accessToken, cookie: refreshCookieFrom(res) };
}

export interface TestAdmin {
  userId: string;
  email: string;
  password: string;
  secret: string;
  phone: string;
}

let adminCounter = 0;

/**
 * Create a staff or super admin account the way a Super Admin does (password set
 * for them), then complete the real first-sign-in authenticator setup.
 * Staff default to the Operations preset.
 */
export async function createActiveAdmin(kind: 'staff' | 'super_admin', permissions: Permission[] = PERMISSION_PRESETS.operations!.permissions): Promise<TestAdmin> {
  adminCounter++;
  const phone = `+25078${String(9000000 + adminCounter).slice(-7)}`;
  const email = `admin${adminCounter}-${Date.now()}@ridewell.test`;
  const password = 'Correct-Horse-Battery-42';
  const { userId } = await createStaffAccount(
    { email, phone, firstName: 'Test', lastName: `Admin${adminCounter}`, password, accountType: kind, permissions },
    { type: 'system', name: 'test' },
  );
  const mfaToken = signMfaChallenge(userId);
  const { secret } = await startTwoFactorSetup(mfaToken);
  await confirmTwoFactorSetup(mfaToken, authenticator.generate(secret), 'test-device-0000000000000', { ip: null, userAgent: null, requestId: null });
  return { userId, email, password, secret, phone };
}

/**
 * A valid authenticator code for this admin. Replay protection rejects a time step
 * that was already used, and tests run many sign-ins within one 30 s window, so
 * the helper clears the stored step first (raw driver, test-only).
 */
export async function freshTotp(admin: TestAdmin): Promise<string> {
  await mongoose.connection.db!.collection('users').updateOne(
    { _id: new mongoose.Types.ObjectId(admin.userId) },
    { $set: { 'twoFactor.lastUsedStep': 0 } },
  );
  return authenticator.generate(admin.secret);
}

export async function signInAdmin(app: ReturnType<typeof testApp>, admin: TestAdmin): Promise<SignedIn> {
  const step1 = await request(app).post(`${API}/auth/admin/login`).send({ email: admin.email, password: admin.password }).expect(200);
  const res = await request(app)
    .post(`${API}/auth/admin/login/mfa`)
    .send({ mfaToken: step1.body.mfaToken, code: await freshTotp(admin) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { userId: admin.userId, accessToken: res.body.accessToken, cookie: refreshCookieFrom(res) };
}

export const bearer = (s: SignedIn) => ({ Authorization: `Bearer ${s.accessToken}` });

export async function auditActions(): Promise<string[]> {
  const rows = await mongoose.connection.db!.collection('auditLogs').find({}).sort({ at: 1 }).toArray();
  return rows.map((r) => r.action as string);
}
