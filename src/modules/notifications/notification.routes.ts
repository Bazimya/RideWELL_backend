import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate, valid, objectIdSchema } from '../../lib/validate.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { auditContext, recordAudit } from '../audit/audit.service.js';
import { NOTIFICATION_STATUSES, NotificationModel } from './notification.model.js';
import { providerNames, resendNotification, retryDueNotifications } from './notification.service.js';
import type { JobDefinition } from '../jobs/scheduler.js';

export const notificationJobs: JobDefinition[] = [
  { name: 'notifications.retry', intervalMs: 60_000, handler: async ({ now }) => void (await retryDueNotifications(now)) },
];

/** The signed-in user's inbox: /me/notifications. Only their own messages, ever. */
export function myNotificationsRouter(): Router {
  const r = Router();
  r.use(authenticate);

  r.get('/', validate({ query: z.strictObject({ before: objectIdSchema.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }) }), async (req, res) => {
    const q = valid<{ before?: string; limit: number }>(req, 'query');
    const userId = req.auth!.user.id;
    const filter: Record<string, unknown> = { userId };
    if (q.before) filter._id = { $lt: q.before };
    const [items, unread] = await Promise.all([
      NotificationModel.find(filter).sort({ _id: -1 }).limit(q.limit).select('key title body link createdAt readAt').lean(),
      NotificationModel.countDocuments({ userId, readAt: null }),
    ]);
    res.json({
      notifications: items.map((n) => ({ id: String(n._id), key: n.key, title: n.title, body: n.body, link: n.link ?? null, createdAt: n.createdAt, readAt: n.readAt ?? null })),
      unread,
      nextBefore: items.length === q.limit ? String(items[items.length - 1]!._id) : null,
    });
  });

  r.post('/read', validate({ body: z.strictObject({ ids: z.array(objectIdSchema).min(1).max(100).optional() }) }), async (req, res) => {
    const { ids } = valid<{ ids?: string[] }>(req, 'body');
    const filter: Record<string, unknown> = { userId: req.auth!.user.id, readAt: null };
    if (ids) filter._id = { $in: ids };
    await NotificationModel.updateMany(filter, { $set: { readAt: new Date() } });
    res.status(204).end();
  });

  return r;
}

/** Staff delivery log: /admin/notifications. */
export function adminNotificationsRouter(): Router {
  const r = Router();
  r.use(authenticate, (req, _res, next) => (req.auth!.sessionKind === 'admin' ? next() : next(forbidden())));

  r.get(
    '/',
    requirePermission('notifications.view'),
    validate({ query: z.strictObject({ status: z.enum(NOTIFICATION_STATUSES).optional(), userId: objectIdSchema.optional(), before: objectIdSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }),
    async (req, res) => {
      const q = valid<{ status?: string; userId?: string; before?: string; limit: number }>(req, 'query');
      const filter: Record<string, unknown> = {};
      if (q.status) filter.status = q.status;
      if (q.userId) filter.userId = q.userId;
      if (q.before) filter._id = { $lt: q.before };
      const since = new Date(Date.now() - 7 * 86_400_000);
      const [items, counts] = await Promise.all([
        NotificationModel.find(filter).sort({ _id: -1 }).limit(q.limit).lean(),
        NotificationModel.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      ]);
      res.json({
        providers: providerNames(),
        last7Days: Object.fromEntries(NOTIFICATION_STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])),
        notifications: items.map((n) => ({
          id: String(n._id),
          userId: String(n.userId),
          key: n.key,
          title: n.title,
          body: n.body,
          channel: n.channel,
          to: n.toMasked ?? null,
          status: n.status,
          attempts: n.attempts,
          lastError: n.lastError ?? null,
          provider: n.provider ?? null,
          providerMessageId: n.providerMessageId ?? null,
          resendable: n.resendable,
          createdAt: n.createdAt,
          sentAt: n.sentAt ?? null,
        })),
        nextBefore: items.length === q.limit ? String(items[items.length - 1]!._id) : null,
      });
    },
  );

  r.post('/:id/resend', requirePermission('notifications.view'), validate({ params: z.strictObject({ id: objectIdSchema }) }), async (req, res) => {
    const { id } = valid<{ id: string }>(req, 'params');
    const result = await resendNotification(id);
    if (result === 'not_found') throw notFound('Notification not found.');
    if (result === 'not_failed') throw conflict('not_failed', 'Only failed messages can be resent.');
    if (result === 'not_resendable') throw conflict('not_resendable', 'This message held a secret (such as a trip PIN) that is not stored, so it cannot be resent. The recipient can see it in the app.');
    await recordAudit({ actor: { type: 'user', id: req.auth!.user.id, roles: req.auth!.user.roles }, action: 'notification.resent', targetType: 'notification', targetId: id, ...auditContext(req) });
    const n = await NotificationModel.findById(id).select('status lastError attempts').lean();
    res.json({ status: n?.status, lastError: n?.lastError ?? null, attempts: n?.attempts ?? 0 });
  });

  return r;
}
