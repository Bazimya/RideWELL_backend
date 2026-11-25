import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate, valid } from '../../lib/validate.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { auditContext, recordAudit } from '../audit/audit.service.js';
import { financeCsv, financeReport, fromKigaliDate, kigaliDate, myDashboard, operationsReport, staffDashboard, type Range } from './dashboard.service.js';

const MAX_RANGE_DAYS = 366;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const rangeQuery = z.strictObject({ from: date.optional(), to: date.optional(), format: z.enum(['json', 'csv']).default('json') });

/** Default: the last 30 Kigali days including today. */
function parseRange(q: { from?: string; to?: string }): Range {
  const now = new Date();
  const to = q.to ?? kigaliDate(now);
  const from = q.from ?? kigaliDate(new Date(fromKigaliDate(to).getTime() - 29 * 86_400_000));
  const a = fromKigaliDate(from).getTime();
  const b = fromKigaliDate(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) throw badRequest('invalid_range', 'Dates must be real calendar dates.');
  if (b < a) throw badRequest('invalid_range', '"to" must be on or after "from".');
  if ((b - a) / 86_400_000 + 1 > MAX_RANGE_DAYS) throw badRequest('invalid_range', `A report covers at most ${MAX_RANGE_DAYS} days.`);
  return { from, to };
}

/** /me/dashboard: the signed-in customer's or partner's home. */
export function myDashboardRouter(): Router {
  const r = Router();
  r.use(authenticate, (req, _res, next) => (req.auth!.sessionKind === 'user' ? next() : next(forbidden('Staff use the operations overview.'))));
  r.get('/', async (req, res) => {
    res.json(await myDashboard(req.auth!.user.id, req.auth!.user.roles));
  });
  return r;
}

/** /admin/dashboard and /admin/reports/*. */
export function adminDashboardRouter(): Router {
  const r = Router();
  r.use(['/dashboard', '/reports'], authenticate, (req, _res, next) => (req.auth!.sessionKind === 'admin' ? next() : next(forbidden())));

  r.get('/dashboard', async (req, res) => {
    res.json(await staffDashboard(req.auth!.user.permissions));
  });

  r.get('/reports/operations', requirePermission('bookings.view'), validate({ query: rangeQuery }), async (req, res) => {
    res.json(await operationsReport(parseRange(valid<{ from?: string; to?: string }>(req, 'query'))));
  });

  r.get('/reports/finance', requirePermission('finance.view'), validate({ query: rangeQuery }), async (req, res) => {
    const q = valid<{ from?: string; to?: string; format: 'json' | 'csv' }>(req, 'query');
    const range = parseRange(q);
    const report = await financeReport(range);
    if (q.format === 'csv') {
      await recordAudit({ actor: { type: 'user', id: req.auth!.user.id, roles: req.auth!.user.roles }, action: 'finance.exported', targetType: 'ledger', targetId: null, after: { ...range, rows: report.rows.length }, ...auditContext(req) });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ridewell-ledger-${range.from}-to-${range.to}.csv"`);
      res.send(financeCsv(report));
      return;
    }
    const { rows, ...summary } = report;
    res.json({ ...summary, rows: rows.slice(-500) });
  });

  return r;
}
