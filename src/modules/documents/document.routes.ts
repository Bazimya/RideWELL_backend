import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { validate, valid, objectIdSchema } from '../../lib/validate.js';
import { auditContext } from '../audit/audit.service.js';
import { createDocumentLink, readDocumentContent } from './document.service.js';

/** Document access for owners and admins. Uploads live under each subject's routes. */
export function documentRouter(): Router {
  const r = Router();
  r.use(authenticate);

  r.post('/:id/link', validate({ params: z.strictObject({ id: objectIdSchema }) }), async (req, res) => {
    res.json(await createDocumentLink(valid<{ id: string }>(req, 'params').id, req.auth!));
  });

  r.get(
    '/:id/content',
    validate({
      params: z.strictObject({ id: objectIdSchema }),
      query: z.strictObject({ exp: z.coerce.number().int(), sig: z.string().min(20).max(100) }),
    }),
    async (req, res) => {
      const { id } = valid<{ id: string }>(req, 'params');
      const link = valid<{ exp: number; sig: string }>(req, 'query');
      const file = await readDocumentContent(id, link, req.auth!, auditContext(req));
      res.set({
        'Content-Type': file.contentType,
        'Content-Length': String(file.body.length),
        'Content-Disposition': `inline; filename="ridewell-document.${file.extension}"`,
        'X-Content-Type-Options': 'nosniff',
        // Shown inside the app only; never executes anything, never framed elsewhere.
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(file.body);
    },
  );

  return r;
}
