import { Router, type Request } from 'express';
import { z } from 'zod';
import { validate, valid } from '../../lib/validate.js';
import { phoneSchema } from '../../lib/phone.js';
import { unauthorized } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import type { RateLimiters } from '../../middleware/rateLimits.js';
import { requestLoginCode, verifyLoginCode, type RequestMeta } from './customerAuth.service.js';
import {
  adminMfaStep,
  adminPasswordStep,
  confirmAdminPasswordReset,
  confirmTwoFactorSetup,
  requestAdminPasswordReset,
  startTwoFactorSetup,
} from './adminAuth.service.js';
import { revokeAllSessions, revokeSession, rotateRefreshToken } from './token.service.js';
import { clearRefreshCookie, ensureDeviceId, REFRESH_COOKIE, requireClientHeader, setRefreshCookie } from './cookies.js';
import { UserModel, toSelfView } from '../users/user.model.js';
import { devCode } from '../../lib/devCode.js';
import { recordAudit } from '../audit/audit.service.js';
import { MAX_PASSWORD_LENGTH } from './password.js';
import { registerWithEmail, signInWithEmail } from './emailAuth.service.js';

const meta = (req: Request): RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
  requestId: req.id ? String(req.id) : null,
});

const otpCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.');
const email = z.email().max(200).transform((v) => v.toLowerCase());
const password = z.string().min(1).max(MAX_PASSWORD_LENGTH);

export function authRouter(limits: RateLimiters): Router {
  const r = Router();

  // ---- Customers and partners: phone + SMS code -------------------------------

  r.post(
    '/otp/request',
    limits.otpRequest,
    validate({ body: z.strictObject({ phone: phoneSchema }) }),
    async (req, res) => {
      const { phone } = valid<{ phone: string }>(req, 'body');
      await requestLoginCode(phone);
      const dc = devCode();
      res.status(202).json({ status: 'sent', expiresInSeconds: 600, ...(dc ? { developmentCode: dc } : {}) });
    },
  );

  r.post(
    '/otp/verify',
    limits.otpVerify,
    validate({ body: z.strictObject({ phone: phoneSchema, code: otpCode }) }),
    async (req, res) => {
      const { phone, code } = valid<{ phone: string; code: string }>(req, 'body');
      const { userId, isNewUser, session } = await verifyLoginCode(phone, code, meta(req));
      setRefreshCookie(res, session.refreshToken, session.expiresAt);
      const user = await UserModel.findById(userId);
      res.json({ accessToken: session.accessToken, isNewUser, user: toSelfView(user!) });
    },
  );

  // ---- Customers and partners: email + password ------------------------------

  r.post(
    '/email/register',
    limits.passwordLogin,
    validate({
      body: z.strictObject({
        email,
        password,
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().min(1).max(80),
      }),
    }),
    async (req, res) => {
      const body = valid<{ email: string; password: string; firstName: string; lastName: string }>(req, 'body');
      const { userId, session } = await registerWithEmail(body, meta(req));
      setRefreshCookie(res, session.refreshToken, session.expiresAt);
      const user = await UserModel.findById(userId);
      res.status(201).json({ accessToken: session.accessToken, isNewUser: true, user: toSelfView(user!) });
    },
  );

  r.post(
    '/email/login',
    limits.passwordLogin,
    validate({ body: z.strictObject({ email, password }) }),
    async (req, res) => {
      const body = valid<{ email: string; password: string }>(req, 'body');
      const { userId, session } = await signInWithEmail(body.email, body.password, meta(req));
      setRefreshCookie(res, session.refreshToken, session.expiresAt);
      const user = await UserModel.findById(userId);
      res.json({ accessToken: session.accessToken, isNewUser: false, user: toSelfView(user!) });
    },
  );

  // ---- Session refresh / logout (cookie + client header) ----------------------

  r.post('/refresh', requireClientHeader, async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (typeof token !== 'string') throw unauthorized('Please sign in.');
    const result = await rotateRefreshToken(token);
    if (!result.ok) {
      clearRefreshCookie(res);
      throw unauthorized('Your session has ended. Please sign in again.');
    }
    const user = await UserModel.findById(result.userId);
    if (!user || user.status !== 'active') {
      await revokeSession(result.session.sessionId, 'user_inactive');
      clearRefreshCookie(res);
      throw unauthorized('Your session has ended. Please sign in again.');
    }
    setRefreshCookie(res, result.session.refreshToken, result.session.expiresAt);
    res.json({ accessToken: result.session.accessToken, user: toSelfView(user) });
  });

  r.post('/logout', requireClientHeader, authenticate, async (req, res) => {
    await revokeSession(req.auth!.sessionId, 'logout');
    clearRefreshCookie(res);
    res.status(204).end();
  });

  r.post('/logout-all', requireClientHeader, authenticate, async (req, res) => {
    const count = await revokeAllSessions(req.auth!.user.id, 'logout_all');
    await recordAudit({
      actor: { type: 'user', id: req.auth!.user.id, roles: req.auth!.user.roles },
      action: 'auth.logout_all',
      targetType: 'user',
      targetId: req.auth!.user.id,
      after: { sessionsRevoked: count },
      ...meta(req),
    });
    clearRefreshCookie(res);
    res.status(204).end();
  });

  // ---- Admins: invite setup, password + authenticator, reset ------------------

  // First sign-in of a staff account: set up the authenticator app.
  r.post(
    '/admin/2fa/setup',
    limits.adminLogin,
    validate({ body: z.strictObject({ mfaToken: z.string().min(20).max(2000) }) }),
    async (req, res) => {
      res.json(await startTwoFactorSetup(valid<{ mfaToken: string }>(req, 'body').mfaToken));
    },
  );

  r.post(
    '/admin/2fa/confirm',
    limits.adminLogin,
    validate({ body: z.strictObject({ mfaToken: z.string().min(20).max(2000), code: otpCode }) }),
    async (req, res) => {
      const body = valid<{ mfaToken: string; code: string }>(req, 'body');
      const deviceId = ensureDeviceId(req, res);
      const { userId, session, recoveryCodes } = await confirmTwoFactorSetup(body.mfaToken, body.code, deviceId, meta(req));
      setRefreshCookie(res, session.refreshToken, session.expiresAt);
      const user = await UserModel.findById(userId);
      res.json({ accessToken: session.accessToken, user: toSelfView(user!), sessionExpiresAt: session.expiresAt, recoveryCodes });
    },
  );

  r.post(
    '/admin/login',
    limits.adminLogin,
    validate({ body: z.strictObject({ email, password }) }),
    async (req, res) => {
      const body = valid<{ email: string; password: string }>(req, 'body');
      const dc = devCode();
      res.json({ ...(await adminPasswordStep(body.email, body.password)), ...(dc ? { developmentCode: dc } : {}) });
    },
  );

  r.post(
    '/admin/login/mfa',
    limits.adminLogin,
    validate({
      body: z
        .strictObject({
          mfaToken: z.string().min(20).max(2000),
          code: otpCode.optional(),
          recoveryCode: z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i).optional(),
        })
        .refine((b) => Boolean(b.code) !== Boolean(b.recoveryCode), 'Send either an authenticator code or a recovery code.'),
    }),
    async (req, res) => {
      const body = valid<{ mfaToken: string; code?: string; recoveryCode?: string }>(req, 'body');
      const deviceId = ensureDeviceId(req, res);
      const { userId, session } = await adminMfaStep(body.mfaToken, body, deviceId, meta(req));
      setRefreshCookie(res, session.refreshToken, session.expiresAt);
      const user = await UserModel.findById(userId);
      res.json({ accessToken: session.accessToken, user: toSelfView(user!), sessionExpiresAt: session.expiresAt });
    },
  );

  r.post(
    '/admin/password-reset/request',
    limits.otpRequest,
    validate({ body: z.strictObject({ email }) }),
    async (req, res) => {
      await requestAdminPasswordReset(valid<{ email: string }>(req, 'body').email);
      const dc = devCode();
      res.status(202).json({ status: 'If this is an admin account, a reset code has been sent to its phone.', ...(dc ? { developmentCode: dc } : {}) });
    },
  );

  r.post(
    '/admin/password-reset/confirm',
    limits.otpVerify,
    validate({ body: z.strictObject({ email, code: otpCode, totpCode: otpCode, newPassword: password }) }),
    async (req, res) => {
      await confirmAdminPasswordReset(
        valid<{ email: string; code: string; totpCode: string; newPassword: string }>(req, 'body'),
        meta(req),
      );
      clearRefreshCookie(res);
      res.status(204).end();
    },
  );

  return r;
}
