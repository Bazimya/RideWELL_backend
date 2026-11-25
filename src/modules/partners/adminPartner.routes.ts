import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate, valid, objectIdSchema } from '../../lib/validate.js';
import { withTransaction } from '../../db/transaction.js';
import { reviewDocument } from '../documents/document.service.js';
import { PARTNER_STATUSES, type PartnerStatus } from './partner.models.js';
import { adminSubjectView, decide, listApplications, recordDriverCheck, recordInspection, setSuspended, startReview, type SubjectKind } from './partner.service.js';

const actor = (req: Request) => ({ type: 'user' as const, id: req.auth!.user.id, roles: req.auth!.user.roles });
const kindParam = z.strictObject({ kind: z.enum(['driver', 'owner', 'vehicle']), id: objectIdSchema });
const reason = z.string().trim().min(3).max(1000);

/** Partner review. Each route requires its own permission (Super Admins hold all). */
export function adminPartnerRouter(): Router {
  const r = Router();
  r.use(authenticate, requirePermission('partners.view', 'partners.review', 'partners.suspend'));

  r.get(
    '/applications',
    requirePermission('partners.view'),
    validate({
      query: z.strictObject({
        kind: z.enum(['driver', 'owner', 'vehicle']),
        status: z
          .string()
          .default('applied,under_review')
          .transform((s) => s.split(',').filter(Boolean))
          .pipe(z.array(z.enum(PARTNER_STATUSES)).min(1)),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        before: objectIdSchema.optional(),
      }),
    }),
    async (req, res) => {
      const q = valid<{ kind: SubjectKind; status: PartnerStatus[]; limit: number; before?: string }>(req, 'query');
      res.json({ applications: await listApplications(q.kind, q.status, q.limit, q.before) });
    },
  );

  r.get('/:kind/:id', requirePermission('partners.view'), validate({ params: kindParam }), async (req, res) => {
    const { kind, id } = valid<{ kind: SubjectKind; id: string }>(req, 'params');
    res.json(await adminSubjectView(kind, id));
  });

  r.post('/:kind/:id/start-review', requirePermission('partners.review'), validate({ params: kindParam }), async (req, res) => {
    const { kind, id } = valid<{ kind: SubjectKind; id: string }>(req, 'params');
    await startReview(kind, id, actor(req));
    res.json(await adminSubjectView(kind, id));
  });

  r.post(
    '/driver/:id/checks',
    requirePermission('partners.review'),
    validate({
      params: z.strictObject({ id: objectIdSchema }),
      body: z.strictObject({
        check: z.enum(['interview', 'drivingTest', 'references']),
        result: z.enum(['passed', 'failed']),
        notes: z.string().trim().max(1000).nullable().optional(),
      }),
    }),
    async (req, res) => {
      const { id } = valid<{ id: string }>(req, 'params');
      const b = valid<{ check: 'interview' | 'drivingTest' | 'references'; result: 'passed' | 'failed'; notes?: string | null }>(req, 'body');
      await recordDriverCheck(id, b.check, b.result, b.notes ?? null, actor(req));
      res.json(await adminSubjectView('driver', id));
    },
  );

  r.post(
    '/vehicle/:id/inspection',
    requirePermission('partners.review'),
    validate({
      params: z.strictObject({ id: objectIdSchema }),
      body: z.strictObject({ result: z.enum(['passed', 'failed']), notes: z.string().trim().max(1000).nullable().optional() }),
    }),
    async (req, res) => {
      const { id } = valid<{ id: string }>(req, 'params');
      const b = valid<{ result: 'passed' | 'failed'; notes?: string | null }>(req, 'body');
      await recordInspection(id, b.result, b.notes ?? null, actor(req));
      res.json(await adminSubjectView('vehicle', id));
    },
  );

  r.post(
    '/:kind/:id/decision',
    requirePermission('partners.review'),
    validate({
      params: kindParam,
      body: z.strictObject({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(1000).nullable().optional() }),
    }),
    async (req, res) => {
      const { kind, id } = valid<{ kind: SubjectKind; id: string }>(req, 'params');
      const b = valid<{ decision: 'approve' | 'reject'; reason?: string | null }>(req, 'body');
      await decide(kind, id, b.decision, b.reason ?? null, actor(req));
      res.json(await adminSubjectView(kind, id));
    },
  );

  r.post('/:kind/:id/suspend', requirePermission('partners.suspend'), validate({ params: kindParam, body: z.strictObject({ reason }) }), async (req, res) => {
    const { kind, id } = valid<{ kind: SubjectKind; id: string }>(req, 'params');
    await setSuspended(kind, id, true, valid<{ reason: string }>(req, 'body').reason, actor(req));
    res.json(await adminSubjectView(kind, id));
  });

  r.post('/:kind/:id/reinstate', requirePermission('partners.suspend'), validate({ params: kindParam, body: z.strictObject({ reason }) }), async (req, res) => {
    const { kind, id } = valid<{ kind: SubjectKind; id: string }>(req, 'params');
    await setSuspended(kind, id, false, valid<{ reason: string }>(req, 'body').reason, actor(req));
    res.json(await adminSubjectView(kind, id));
  });

  r.post(
    '/documents/:id/review',
    requirePermission('partners.review'),
    validate({
      params: z.strictObject({ id: objectIdSchema }),
      body: z.strictObject({
        decision: z.enum(['approved', 'rejected']),
        note: z.string().trim().max(500).nullable().optional(),
        expiresAt: z.coerce.date().nullable().optional(),
      }),
    }),
    async (req, res) => {
      const b = valid<{ decision: 'approved' | 'rejected'; note?: string | null; expiresAt?: Date | null }>(req, 'body');
      const a = actor(req);
      const doc = await withTransaction((session) =>
        reviewDocument({ docId: valid<{ id: string }>(req, 'params').id, decision: b.decision, note: b.note, expiresAt: b.expiresAt ?? null, actor: a }, session),
      );
      res.json(await adminSubjectView(doc.subjectType as SubjectKind, String(doc.subjectId)));
    },
  );

  return r;
}
