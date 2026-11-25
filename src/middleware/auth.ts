import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { SessionModel } from '../modules/auth/session.model.js';
import { UserModel } from '../modules/users/user.model.js';
import { hasAdminRole, isAdminRole, type Role } from '../modules/users/roles.js';
import { consumeTotp } from '../modules/auth/twoFactor.js';
import { effectivePermissions, type Permission } from '../modules/users/permissions.js';
import { devCode } from '../lib/devCode.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';

export interface AuthContext {
  user: { id: string; roles: Role[]; permissions: Permission[]; status: string; firstName: string | null };
  sessionId: string;
  sessionKind: 'user' | 'admin';
}

/**
 * Authenticate every request from the database, not from token claims: the
 * session must still be live and the user still active. Revoking a session or
 * suspending a user therefore takes effect on the very next request.
 */
export async function resolveAuth(authorization: string | undefined, now = new Date()): Promise<AuthContext | null> {
  if (!authorization?.startsWith('Bearer ')) return null;
  const claims = verifyAccessToken(authorization.slice(7).trim());
  if (!claims) return null;

  const session = await SessionModel.findById(claims.sid).lean();
  if (!session || session.revokedAt || session.expiresAt <= now || String(session.userId) !== claims.sub) return null;

  const user = await UserModel.findById(claims.sub).lean();
  if (!user || user.status !== 'active') return null;

  const roles = user.roles as Role[];
  const isAdmin = hasAdminRole(roles);
  // Admin accounts may only act through an admin session (password + 2FA); and an
  // admin session is only valid while the account still holds an admin role with 2FA on.
  // Development only: with a development code configured, staff may work before setting up 2FA.
  if (session.kind === 'admin' && (!isAdmin || (!user.twoFactor?.enabled && !devCode()))) return null;
  if (session.kind === 'user' && isAdmin) return null;

  return {
    user: { id: String(user._id), roles, permissions: effectivePermissions(user), status: user.status, firstName: user.firstName ?? null },
    sessionId: String(session._id),
    sessionKind: session.kind,
  };
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const ctx = await resolveAuth(req.get('authorization'));
    if (!ctx) return next(unauthorized());
    req.auth = ctx;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Allow the request only if the user holds at least one of `roles`. Admin roles
 * count only inside an admin session. Ownership of the specific record is a
 * separate check inside each handler/service.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  if (!roles.length) throw new Error('requireRole needs at least one role');
  return (req: Request, _res: Response, next: NextFunction) => {
    const ctx = req.auth;
    if (!ctx) return next(unauthorized());
    const allowed = roles.some((r) => ctx.user.roles.includes(r) && (!isAdminRole(r) || ctx.sessionKind === 'admin'));
    if (!allowed) return next(forbidden());
    next();
  };
}

/**
 * Allow the request only inside an admin session whose user holds at least one of
 * `permissions` (Super Admins hold all). Read from the database on every request,
 * so a permission removed by a Super Admin stops working on the next request.
 */
export function requirePermission(...permissions: Permission[]): RequestHandler {
  if (!permissions.length) throw new Error('requirePermission needs at least one permission');
  return (req: Request, _res: Response, next: NextFunction) => {
    const ctx = req.auth;
    if (!ctx) return next(unauthorized());
    if (ctx.sessionKind !== 'admin' || !permissions.some((p) => ctx.user.permissions.includes(p))) return next(forbidden());
    next();
  };
}

export const hasPermission = (ctx: AuthContext | undefined, p: Permission) => Boolean(ctx && ctx.sessionKind === 'admin' && ctx.user.permissions.includes(p));

/**
 * Step-up check for the most sensitive admin actions (creating or removing admins,
 * changing commission): the request must carry a fresh authenticator code in the
 * `X-2FA-Code` header, even inside a valid admin session.
 */
export const requireFreshTotp: RequestHandler = async (req, _res, next) => {
  try {
    const ctx = req.auth;
    if (!ctx || ctx.sessionKind !== 'admin') return next(forbidden());
    const code = req.get('x-2fa-code')?.trim();
    if (!code) return next(new AppError(401, 'step_up_required', 'Enter a current code from your authenticator app to confirm this action.'));
    const ok = await consumeTotp(ctx.user.id, code);
    if (!ok) return next(new AppError(401, 'step_up_failed', 'The authenticator code is incorrect or was already used.'));
    next();
  } catch (err) {
    next(err);
  }
};
