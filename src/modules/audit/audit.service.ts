import type { ClientSession } from 'mongoose';
import type { Request } from 'express';
import { AuditLogModel } from './audit.model.js';

export type AuditActor =
  | { type: 'user'; id: string; roles: readonly string[] }
  | { type: 'system'; name: string };

export interface AuditEntryInput {
  actor: AuditActor;
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Fields that must never be copied into an audit entry. */
const SECRET_KEYS = new Set([
  'passwordHash',
  'secretEnc',
  'pendingSecretEnc',
  'recoveryCodeHashes',
  'inviteTokenHash',
  'knownDeviceHashes',
  'codeHash',
  'tokenHash',
  'currentTokenHash',
  'usedTokenHashes',
]);

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.toHexString === 'function') return String(value);
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v)) {
      out[k] = SECRET_KEYS.has(k) ? '[redacted]' : scrub(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export async function recordAudit(entry: AuditEntryInput, session?: ClientSession): Promise<void> {
  const doc = {
    at: new Date(),
    actorType: entry.actor.type,
    actorId: entry.actor.type === 'user' ? entry.actor.id : null,
    actorRoles: entry.actor.type === 'user' ? [...entry.actor.roles] : [`system:${entry.actor.name}`],
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    before: scrub(entry.before),
    after: scrub(entry.after),
    reason: entry.reason ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent?.slice(0, 400) ?? null,
    requestId: entry.requestId ?? null,
  };
  await AuditLogModel.create([doc], session ? { session } : {});
}

/** Request metadata to attach to an audit entry. */
export function auditContext(req: Request) {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.id ? String(req.id) : null,
  };
}

/** The current user as an audit actor. */
export function actorFrom(req: Request): AuditActor {
  if (!req.auth) return { type: 'system', name: 'anonymous' };
  return { type: 'user', id: req.auth.user.id, roles: req.auth.user.roles };
}
