import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, requireFreshTotp, requirePermission, requireRole } from '../../middleware/auth.js';
import { validate, valid, objectIdSchema } from '../../lib/validate.js';
import { phoneSchema } from '../../lib/phone.js';
import { forbidden, notFound } from '../../lib/errors.js';
import {
  createStaffAccount,
  removeAdmin,
  resetStaffTwoFactor,
  setStaffPassword,
  setUserSuspended,
  updateStaffAccount,
  type NewStaffInput,
} from '../auth/adminAuth.service.js';
import { UserModel } from '../users/user.model.js';
import { ROLES, type Role } from '../users/roles.js';
import { PERMISSIONS, PERMISSION_CATALOG, PERMISSION_PRESETS, effectivePermissions } from '../users/permissions.js';
import { MAX_PASSWORD_LENGTH } from '../auth/password.js';
import { AuditLogModel } from '../audit/audit.model.js';
import { actorFrom, auditContext, recordAudit } from '../audit/audit.service.js';
import { getCurrentConfig, saveConfigVersion } from '../platformConfig/platformConfig.service.js';
import { platformConfigValuesSchema, type PlatformConfigValues } from '../platformConfig/platformConfig.schema.js';
import { withTransaction } from '../../db/transaction.js';

const reason = z.string().trim().min(3).max(1000);
const userActor = (req: Request) => actorFrom(req) as { type: 'user'; id: string; roles: string[] };
const idParam = z.strictObject({ id: objectIdSchema });
const name = z.string().trim().min(1).max(80);

/** Only admin sessions reach these routes; each route then checks its own permission. */
export function adminRouter(): Router {
  const r = Router();
  r.use(authenticate, (req, _res, next) => (req.auth!.sessionKind === 'admin' ? next() : next(forbidden())));

  // ---- Permission catalogue (for the staff form and for hiding menu items) ----

  r.get('/permissions', (_req, res) => {
    res.json({ permissions: PERMISSION_CATALOG, presets: PERMISSION_PRESETS });
  });

  // ---- Customer and partner accounts ----------------------------------------

  r.get(
    '/users',
    requirePermission('users.view'),
    validate({
      query: z.strictObject({
        role: z.enum(ROLES).optional(),
        status: z.enum(['pending_setup', 'active', 'suspended', 'anonymised']).optional(),
        phone: z.string().regex(/^\+?\d{3,15}$/).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        before: objectIdSchema.optional(),
      }),
    }),
    async (req, res) => {
      const q = valid<{ role?: Role; status?: string; phone?: string; limit: number; before?: string }>(req, 'query');
      const filter: Record<string, unknown> = { roles: { $nin: ['staff', 'super_admin'] } };
      if (q.role) filter.roles = { $eq: q.role, $nin: ['staff', 'super_admin'] };
      if (q.status) filter.status = q.status;
      if (q.phone) filter.phone = { $regex: `^\\+?${q.phone.replace(/^\+/, '')}` };
      if (q.before) filter._id = { $lt: q.before };
      const users = await UserModel.find(filter).sort({ _id: -1 }).limit(q.limit).select('phone email firstName lastName roles status createdAt lastLoginAt').lean();
      res.json({
        users: users.map((u) => ({
          id: String(u._id),
          phone: u.phone ?? null,
          email: u.email ?? null,
          firstName: u.firstName ?? null,
          lastName: u.lastName ?? null,
          roles: u.roles,
          status: u.status,
          createdAt: u.createdAt,
          lastLoginAt: u.lastLoginAt ?? null,
        })),
        nextBefore: users.length === q.limit ? String(users[users.length - 1]!._id) : null,
      });
    },
  );

  r.post('/users/:id/suspend', requirePermission('users.suspend'), validate({ params: idParam, body: z.strictObject({ reason }) }), async (req, res) => {
    await setUserSuspended(valid<{ id: string }>(req, 'params').id, true, userActor(req), valid<{ reason: string }>(req, 'body').reason, auditContext(req));
    res.status(204).end();
  });

  r.post('/users/:id/reactivate', requirePermission('users.suspend'), validate({ params: idParam, body: z.strictObject({ reason }) }), async (req, res) => {
    await setUserSuspended(valid<{ id: string }>(req, 'params').id, false, userActor(req), valid<{ reason: string }>(req, 'body').reason, auditContext(req));
    res.status(204).end();
  });

  // ---- Staff management: Super Admin only, sensitive changes need a fresh code --

  r.get('/staff', requireRole('super_admin'), async (_req, res) => {
    const staff = await UserModel.find({ roles: { $in: ['staff', 'super_admin'] } })
      .select('phone email firstName lastName roles permissions status lastLoginAt createdAt twoFactor.enabled')
      .sort({ createdAt: 1 })
      .lean();
    res.json({
      staff: staff.map((a) => ({
        id: String(a._id),
        email: a.email ?? null,
        phone: a.phone ?? null,
        firstName: a.firstName ?? null,
        lastName: a.lastName ?? null,
        accountType: a.roles.includes('super_admin') ? 'super_admin' : a.roles.includes('staff') ? 'staff' : 'removed',
        permissions: effectivePermissions(a),
        status: a.status,
        twoFactorEnabled: Boolean(a.twoFactor?.enabled),
        lastLoginAt: a.lastLoginAt ?? null,
      })),
    });
  });

  r.post(
    '/staff',
    requireRole('super_admin'),
    requireFreshTotp,
    validate({
      body: z.strictObject({
        email: z.email().max(200).transform((v) => v.toLowerCase()),
        phone: phoneSchema.nullable().optional(),
        firstName: name,
        lastName: name,
        password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
        accountType: z.enum(['staff', 'super_admin']).default('staff'),
        permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]),
      }),
    }),
    async (req, res) => {
      const result = await createStaffAccount(valid<NewStaffInput>(req, 'body'), actorFrom(req), auditContext(req));
      res.status(201).json({ id: result.userId });
    },
  );

  r.put(
    '/staff/:id',
    requireRole('super_admin'),
    requireFreshTotp,
    validate({
      params: idParam,
      body: z.strictObject({
        firstName: name.optional(),
        lastName: name.optional(),
        phone: phoneSchema.nullable().optional(),
        permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional(),
      }),
    }),
    async (req, res) => {
      await updateStaffAccount(valid<{ id: string }>(req, 'params').id, valid(req, 'body'), userActor(req), auditContext(req));
      res.status(204).end();
    },
  );

  r.post(
    '/staff/:id/password',
    requireRole('super_admin'),
    requireFreshTotp,
    validate({ params: idParam, body: z.strictObject({ password: z.string().min(1).max(MAX_PASSWORD_LENGTH) }) }),
    async (req, res) => {
      await setStaffPassword(valid<{ id: string }>(req, 'params').id, valid<{ password: string }>(req, 'body').password, userActor(req), auditContext(req));
      res.status(204).end();
    },
  );

  r.post('/staff/:id/reset-2fa', requireRole('super_admin'), requireFreshTotp, validate({ params: idParam }), async (req, res) => {
    await resetStaffTwoFactor(valid<{ id: string }>(req, 'params').id, userActor(req), auditContext(req));
    res.status(204).end();
  });

  r.delete('/staff/:id', requireRole('super_admin'), requireFreshTotp, validate({ params: idParam, body: z.strictObject({ reason }) }), async (req, res) => {
    await removeAdmin(valid<{ id: string }>(req, 'params').id, userActor(req), valid<{ reason: string }>(req, 'body').reason, auditContext(req));
    res.status(204).end();
  });

  // ---- Audit log: read-only. No route can change or delete an entry. -------

  r.get(
    '/audit-logs',
    requirePermission('audit.view'),
    validate({
      query: z.strictObject({
        targetType: z.string().max(60).optional(),
        targetId: z.string().max(60).optional(),
        actorId: objectIdSchema.optional(),
        action: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: objectIdSchema.optional(),
      }),
    }),
    async (req, res) => {
      const q = valid<{ targetType?: string; targetId?: string; actorId?: string; action?: string; limit: number; before?: string }>(req, 'query');
      const filter: Record<string, unknown> = {};
      if (q.targetType) filter.targetType = q.targetType;
      if (q.targetId) filter.targetId = q.targetId;
      if (q.actorId) filter.actorId = q.actorId;
      if (q.action) filter.action = q.action;
      if (q.before) filter._id = { $lt: q.before };
      const entries = await AuditLogModel.find(filter).sort({ _id: -1 }).limit(q.limit).lean();
      res.json({
        entries: entries.map((e) => ({ ...e, id: String(e._id), _id: undefined })),
        nextBefore: entries.length === q.limit ? String(entries[entries.length - 1]!._id) : null,
      });
    },
  );

  // ---- Platform configuration ------------------------------------------------

  r.get('/config', requirePermission('config.view', 'config.edit'), async (_req, res) => {
    res.json({ config: await getCurrentConfig() });
  });

  r.put(
    '/config',
    requirePermission('config.edit'),
    requireFreshTotp,
    validate({ body: z.strictObject({ values: platformConfigValuesSchema, note: z.string().trim().max(500).optional() }) }),
    async (req, res) => {
      const body = valid<{ values: PlatformConfigValues; note?: string }>(req, 'body');
      const actor = userActor(req);
      const saved = await withTransaction(async (session) => {
        const before = await getCurrentConfig(session);
        const cfg = await saveConfigVersion({ values: body.values, isPlaceholder: false, note: body.note ?? null, createdBy: actor.id }, session);
        await recordAudit(
          {
            actor,
            action: 'config.updated',
            targetType: 'platformConfig',
            targetId: String(cfg.version),
            before: before ? { version: before.version, values: before.values, isPlaceholder: before.isPlaceholder } : null,
            after: { version: cfg.version, values: cfg.values, isPlaceholder: false },
            reason: body.note ?? null,
            ...auditContext(req),
          },
          session,
        );
        return cfg;
      });
      res.json({ config: saved });
    },
  );

  r.use((_req, _res, next) => next(notFound('Route not found.')));
  return r;
}

