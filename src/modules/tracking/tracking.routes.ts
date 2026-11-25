import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth.js';
import { objectIdSchema, validate, valid } from '../../lib/validate.js';
import { auditContext } from '../audit/audit.service.js';
import type { RateLimiters } from '../../middleware/rateLimits.js';
import { openEmergencyAccess, recordPoint, staffTrackingView, trackingView } from './tracking.service.js';

const idParam = z.strictObject({ id: objectIdSchema });

/** The same payload a future native driver app will send (`source: driver_app`). */
const pointBody = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(50_000),
  recordedAt: z.coerce.date(),
  headingDeg: z.number().min(0).max(360).nullable().optional(),
  speedMps: z.number().min(0).max(100).nullable().optional(),
  source: z.enum(['driver_web', 'driver_app']).optional(),
});

/**
 * Tracking routes, mounted at the API root. Each route authenticates itself and the
 * service checks role and booking membership on every call.
 */
export function trackingRouter(limits: RateLimiters): Router {
  const r = Router();
  const driver = [authenticate, requireRole('driver_partner')];

  r.post('/driver/trips/:id/location', limits.tracking, ...driver, validate({ params: idParam, body: pointBody }), async (req, res) => {
    const body = valid<z.infer<typeof pointBody>>(req, 'body');
    res.json(await recordPoint(valid<{ id: string }>(req, 'params').id, req.auth!.user.id, body));
  });
  r.get('/driver/trips/:id/tracking', ...driver, validate({ params: idParam }), async (req, res) => {
    res.json(await trackingView(valid<{ id: string }>(req, 'params').id, req.auth!, 'driver'));
  });
  r.get('/bookings/:id/tracking', authenticate, requireRole('customer'), validate({ params: idParam }), async (req, res) => {
    res.json(await trackingView(valid<{ id: string }>(req, 'params').id, req.auth!, 'customer'));
  });
  r.get('/owner/trips/:id/tracking', authenticate, requireRole('vehicle_partner'), validate({ params: idParam }), async (req, res) => {
    res.json(await trackingView(valid<{ id: string }>(req, 'params').id, req.auth!, 'owner'));
  });

  // ---- staff break-glass --------------------------------------------------------
  r.get('/admin/bookings/:id/tracking', authenticate, requirePermission('tracking.emergency'), validate({ params: idParam }), async (req, res) => {
    const u = req.auth!.user;
    res.json(await staffTrackingView(valid<{ id: string }>(req, 'params').id, { id: u.id, roles: u.roles }, auditContext(req)));
  });
  r.post(
    '/admin/bookings/:id/tracking-access',
    authenticate,
    requirePermission('tracking.emergency'),
    validate({ params: idParam, body: z.strictObject({ reason: z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(500) }) }),
    async (req, res) => {
      const u = req.auth!.user;
      const id = valid<{ id: string }>(req, 'params').id;
      await openEmergencyAccess(id, { id: u.id, roles: u.roles }, valid<{ reason: string }>(req, 'body').reason, auditContext(req));
      res.status(201).json(await staffTrackingView(id, { id: u.id, roles: u.roles }, auditContext(req)));
    },
  );
  return r;
}
