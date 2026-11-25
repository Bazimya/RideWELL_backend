import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { validate, valid } from '../../lib/validate.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { UserModel, toSelfView } from './user.model.js';
import { auditContext, recordAudit } from '../audit/audit.service.js';
import { setOwnPassword } from '../auth/emailAuth.service.js';
import { MAX_PASSWORD_LENGTH } from '../auth/password.js';

const name = z.string().trim().min(1).max(80);

/** The signed-in user's own profile. Roles and status are never editable here. */
export function meRouter(): Router {
  const r = Router();
  r.use(authenticate);

  r.get('/', async (req, res) => {
    const user = await UserModel.findById(req.auth!.user.id);
    if (!user) throw notFound();
    res.json({ user: toSelfView(user), sessionKind: req.auth!.sessionKind });
  });

  r.patch(
    '/',
    validate({
      body: z.strictObject({
        firstName: name.optional(),
        lastName: name.optional(),
        email: z.email().max(200).transform((v) => v.toLowerCase()).nullable().optional(),
      }),
    }),
    async (req, res) => {
      const body = valid<{ firstName?: string; lastName?: string; email?: string | null }>(req, 'body');
      // An admin's email is their sign-in identity; it changes only through admin management.
      if (req.auth!.sessionKind === 'admin' && body.email !== undefined) throw forbidden('Admin email addresses cannot be changed here.');
      const user = await UserModel.findById(req.auth!.user.id);
      if (!user) throw notFound();
      const before = { firstName: user.firstName ?? null, lastName: user.lastName ?? null, email: user.email ?? null };
      if (body.firstName !== undefined) user.firstName = body.firstName;
      if (body.lastName !== undefined) user.lastName = body.lastName;
      if (body.email !== undefined) user.email = body.email ?? undefined;
      try {
        await user.save();
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw conflict('email_taken', 'This email is already used by another account.');
        throw err;
      }
      await recordAudit({
        actor: { type: 'user', id: user.id, roles: user.roles },
        action: 'user.profile_updated',
        targetType: 'user',
        targetId: user.id,
        before,
        after: { firstName: user.firstName ?? null, lastName: user.lastName ?? null, email: user.email ?? null },
        ...auditContext(req),
      });
      res.json({ user: toSelfView(user) });
    },
  );

  r.put(
    '/password',
    // Role first, then input: an admin is refused whatever they send.
    (req, _res, next) => (req.auth!.sessionKind === 'admin' ? next(forbidden('Admins change their password through the admin password reset.')) : next()),
    validate({
      body: z.strictObject({
        currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH).optional(),
        newPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
      }),
    }),
    async (req, res) => {
      await setOwnPassword(req.auth!.user.id, req.auth!.sessionId, valid<{ currentPassword?: string; newPassword: string }>(req, 'body'), auditContext(req));
      res.status(204).end();
    },
  );

  return r;
}
