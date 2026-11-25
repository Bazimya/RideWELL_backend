import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { keyedHash, randomToken, safeEqual } from '../../lib/crypto.js';
import { SessionModel } from './session.model.js';
import { recordAudit } from '../audit/audit.service.js';

export const SESSION_RULES = {
  accessTtlSeconds: 15 * 60,
  userSessionMs: 30 * 24 * 60 * 60_000,
  /** Spec: admin sessions expire after 8 hours. */
  adminSessionMs: 8 * 60 * 60_000,
  mfaChallengeTtlSeconds: 5 * 60,
  keepUsedHashes: 20,
} as const;

const ISSUER = 'ridewell-api';
const AUDIENCE = 'ridewell-web';

export interface AccessClaims {
  sub: string;
  sid: string;
  typ: 'access';
}

export function signAccessToken(userId: string, sessionId: string): string {
  return jwt.sign({ sid: sessionId, typ: 'access' }, env().JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: SESSION_RULES.accessTtlSeconds,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const claims = jwt.verify(token, env().JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    if (claims.typ !== 'access' || typeof claims.sub !== 'string' || typeof claims.sid !== 'string') return null;
    return { sub: claims.sub, sid: claims.sid, typ: 'access' };
  } catch {
    return null;
  }
}

/** Short-lived token proving the password step of an admin login succeeded. */
export function signMfaChallenge(userId: string): string {
  return jwt.sign({ typ: 'mfa' }, env().JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: SESSION_RULES.mfaChallengeTtlSeconds,
    issuer: ISSUER,
    audience: `${AUDIENCE}:mfa`,
    algorithm: 'HS256',
  });
}

export function verifyMfaChallenge(token: string): string | null {
  try {
    const c = jwt.verify(token, env().JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: `${AUDIENCE}:mfa`,
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    return c.typ === 'mfa' && typeof c.sub === 'string' ? c.sub : null;
  } catch {
    return null;
  }
}

const hashRefresh = (secret: string) => keyedHash(secret, 'refresh');

/** Refresh token format: `<sessionId>.<random secret>`. Only the hash is stored. */
function composeRefresh(sessionId: string, secret: string) {
  return `${sessionId}.${secret}`;
}
function parseRefresh(token: string): { sessionId: string; secret: string } | null {
  const [sessionId, secret, extra] = token.split('.');
  if (!sessionId || !secret || extra !== undefined || !Types.ObjectId.isValid(sessionId)) return null;
  return { sessionId, secret };
}

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export async function createSession(input: {
  userId: string;
  kind: 'user' | 'admin';
  ip?: string | null;
  userAgent?: string | null;
}): Promise<IssuedSession> {
  const now = Date.now();
  const lifetime = input.kind === 'admin' ? SESSION_RULES.adminSessionMs : SESSION_RULES.userSessionMs;
  const secret = randomToken();
  const expiresAt = new Date(now + lifetime);
  const session = await SessionModel.create({
    userId: input.userId,
    kind: input.kind,
    currentTokenHash: hashRefresh(secret),
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + 30 * 24 * 60 * 60_000),
    ip: input.ip ?? null,
    userAgent: input.userAgent?.slice(0, 400) ?? null,
  });
  const sessionId = session.id as string;
  return {
    sessionId,
    accessToken: signAccessToken(input.userId, sessionId),
    refreshToken: composeRefresh(sessionId, secret),
    expiresAt,
  };
}

export type RefreshResult =
  | { ok: true; session: IssuedSession; userId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'reuse_detected' };

/**
 * Rotate a refresh token. The swap is a single conditional update on the current
 * hash, so two concurrent refreshes cannot both succeed. Presenting a token that
 * was already rotated away means it was copied: the whole session is revoked.
 */
export async function rotateRefreshToken(token: string, now = new Date()): Promise<RefreshResult> {
  const parsed = parseRefresh(token);
  if (!parsed) return { ok: false, reason: 'invalid' };
  const presentedHash = hashRefresh(parsed.secret);
  const newSecret = randomToken();
  const newHash = hashRefresh(newSecret);

  const rotated = await SessionModel.findOneAndUpdate(
    { _id: parsed.sessionId, currentTokenHash: presentedHash, revokedAt: null, expiresAt: { $gt: now } },
    {
      $set: { currentTokenHash: newHash, lastUsedAt: now },
      $push: { usedTokenHashes: { $each: [presentedHash], $slice: -SESSION_RULES.keepUsedHashes } },
    },
    { new: true },
  ).lean();

  if (rotated) {
    const userId = String(rotated.userId);
    return {
      ok: true,
      userId,
      session: {
        sessionId: parsed.sessionId,
        accessToken: signAccessToken(userId, parsed.sessionId),
        refreshToken: composeRefresh(parsed.sessionId, newSecret),
        expiresAt: rotated.expiresAt,
      },
    };
  }

  const existing = await SessionModel.findById(parsed.sessionId).select('+usedTokenHashes').lean();
  if (!existing) return { ok: false, reason: 'invalid' };
  if (existing.revokedAt) return { ok: false, reason: 'revoked' };
  if (existing.expiresAt <= now) return { ok: false, reason: 'expired' };
  if ((existing.usedTokenHashes ?? []).some((h) => safeEqual(h, presentedHash))) {
    await revokeSession(parsed.sessionId, 'refresh_token_reuse');
    await recordAudit({
      actor: { type: 'system', name: 'auth' },
      action: 'auth.refresh_reuse_detected',
      targetType: 'session',
      targetId: parsed.sessionId,
      after: { userId: String(existing.userId) },
    });
    return { ok: false, reason: 'reuse_detected' };
  }
  return { ok: false, reason: 'invalid' };
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await SessionModel.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } });
}

/** Revoke every live session of a user (logout everywhere, suspension, password change). */
export async function revokeAllSessions(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const filter: Record<string, unknown> = { userId, revokedAt: null };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  const res = await SessionModel.updateMany(filter, { $set: { revokedAt: new Date(), revokeReason: reason } });
  return res.modifiedCount;
}
