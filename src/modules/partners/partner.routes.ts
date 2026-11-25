import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { validate, valid, objectIdSchema } from '../../lib/validate.js';
import { phoneSchema } from '../../lib/phone.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { auditContext } from '../audit/audit.service.js';
import type { RateLimiters } from '../../middleware/rateLimits.js';
import { singleUpload } from '../documents/upload.js';
import { uploadDocument, withdrawDocument } from '../documents/document.service.js';
import { DocumentModel, KINDS_FOR_SUBJECT, type DocumentKind, type SubjectType } from '../documents/document.model.js';
import { VEHICLE_CATEGORIES } from './partner.models.js';
import {
  createVehicle,
  driverView,
  getOrCreateDriverProfile,
  getOrCreateOwnerProfile,
  getOwnVehicle,
  ownerView,
  setDriverAvailability,
  setVehicleAvailability,
  submitDriverApplication,
  submitOwnerApplication,
  submitVehicle,
  updateDriverProfile,
  updateOwnerProfile,
  updateVehicle,
  vehicleView,
} from './partner.service.js';

const actor = (req: Request) => ({ type: 'user' as const, id: req.auth!.user.id, roles: req.auth!.user.roles });

const text = (max: number) => z.string().trim().min(1).max(max);
const rwf = z.number().int().min(0).max(100_000_000).nullable().optional();
const futureDate = z.coerce.date().refine((d) => d > new Date(), 'The date must be in the future.');
const list = (max: number, item = 60) => z.array(text(item)).max(max);

const availabilitySchema = z.strictObject({
  acceptingTrips: z.boolean(),
  unavailable: z
    .array(
      z
        .strictObject({ from: z.coerce.date(), to: z.coerce.date(), note: z.string().trim().max(200).nullable().optional() })
        .refine((p) => p.to > p.from, 'Each period must end after it starts.'),
    )
    .max(50),
});

/** Kinds a partner may replace after approval (renewals). Anything else goes through operations. */
const RENEWABLE: ReadonlySet<DocumentKind> = new Set(['driving_licence', 'insurance', 'profile_photo']);

/**
 * May a file of `kind` be uploaded to a subject in `status`? While a draft or
 * rejected: anything. During review: only to replace a rejected file. Once
 * approved: renewals (licence, insurance, photo). Suspended: nothing.
 */
async function assertUploadAllowed(subjectType: SubjectType, subjectId: unknown, status: string, kind: DocumentKind) {
  if (!KINDS_FOR_SUBJECT[subjectType].includes(kind)) throw badRequest('invalid_kind', 'This document type does not belong here.');
  if (status === 'draft' || status === 'rejected') return;
  if (status === 'approved' && RENEWABLE.has(kind)) return;
  if (status === 'applied' || status === 'under_review') {
    const rejected = await DocumentModel.exists({ subjectType, subjectId, kind, status: 'rejected' });
    if (rejected) return;
  }
  throw conflict('upload_not_allowed', 'This document cannot be changed at this stage. Contact RideWELL operations.');
}

const kindField = (subject: SubjectType) =>
  z.strictObject({ kind: z.enum(KINDS_FOR_SUBJECT[subject] as [DocumentKind, ...DocumentKind[]]) });

export function partnerRouter(limits: RateLimiters): Router {
  const r = Router();
  r.use(authenticate);
  // Partner self-service is for customer/partner sessions; admins never apply.
  r.use((req, _res, next) => (req.auth!.sessionKind === 'user' ? next() : next(forbidden('Admin accounts cannot apply as partners.'))));

  // ===== Driver ===============================================================

  r.get('/driver', async (req, res) => {
    res.json(await driverView(await getOrCreateDriverProfile(req.auth!.user.id)));
  });

  r.put(
    '/driver',
    validate({
      body: z.strictObject({
        contactPhone: phoneSchema.optional(),
        licenceNumber: text(40).optional(),
        licenceExpiry: futureDate.optional(),
        licenceCategories: list(10, 10).optional(),
        experienceYears: z.number().int().min(0).max(60).optional(),
        areas: list(20).optional(),
        languages: list(10, 40).optional(),
        bio: z.string().trim().max(600).nullable().optional(),
        references: z
          .array(z.strictObject({ name: text(120), phone: phoneSchema, relationship: text(80) }))
          .max(3)
          .optional(),
      }),
    }),
    async (req, res) => {
      const p = await updateDriverProfile(req.auth!.user.id, valid(req, 'body'), actor(req));
      res.json(await driverView(p));
    },
  );

  r.post('/driver/documents', limits.upload, singleUpload, async (req, res) => {
    const { kind } = kindField('driver').parse(req.body);
    const p = await getOrCreateDriverProfile(req.auth!.user.id);
    await assertUploadAllowed('driver', p._id, p.status, kind);
    await uploadDocument({ ownerId: req.auth!.user.id, subjectType: 'driver', subjectId: p._id, kind, buffer: req.file!.buffer, actor: actor(req), meta: auditContext(req) });
    res.status(201).json(await driverView(p));
  });

  r.post('/driver/submit', async (req, res) => {
    const p = await submitDriverApplication(req.auth!.user.id, actor(req));
    res.json(await driverView(p));
  });

  r.put('/driver/availability', validate({ body: availabilitySchema }), async (req, res) => {
    const p = await setDriverAvailability(req.auth!.user.id, valid(req, 'body'), actor(req));
    res.json(await driverView(p));
  });

  // ===== Vehicle partner (owner) ==============================================

  r.get('/owner', async (req, res) => {
    res.json(await ownerView(await getOrCreateOwnerProfile(req.auth!.user.id)));
  });

  r.put(
    '/owner',
    validate({
      body: z.strictObject({
        contactPhone: phoneSchema.optional(),
        type: z.enum(['individual', 'company']).optional(),
        companyName: z.string().trim().max(160).nullable().optional(),
        rdbNumber: z.string().trim().max(40).nullable().optional(),
        tinNumber: z.string().trim().max(40).nullable().optional(),
        representativeName: z.string().trim().max(120).nullable().optional(),
        payout: z
          .discriminatedUnion('method', [
            z.strictObject({ method: z.literal('momo'), momoPhone: phoneSchema, momoName: text(120) }),
            z.strictObject({ method: z.literal('bank'), bankName: text(120), accountName: text(120), accountNumber: z.string().trim().regex(/^[0-9A-Za-z-]{5,40}$/) }),
          ])
          .optional(),
      }),
    }),
    async (req, res) => {
      const p = await updateOwnerProfile(req.auth!.user.id, valid(req, 'body'), actor(req));
      res.json(await ownerView(p));
    },
  );

  r.post('/owner/documents', limits.upload, singleUpload, async (req, res) => {
    const { kind } = kindField('owner').parse(req.body);
    const p = await getOrCreateOwnerProfile(req.auth!.user.id);
    await assertUploadAllowed('owner', p._id, p.status, kind);
    await uploadDocument({ ownerId: req.auth!.user.id, subjectType: 'owner', subjectId: p._id, kind, buffer: req.file!.buffer, actor: actor(req), meta: auditContext(req) });
    res.status(201).json(await ownerView(p));
  });

  r.post('/owner/submit', async (req, res) => {
    const p = await submitOwnerApplication(req.auth!.user.id, actor(req));
    res.json(await ownerView(p));
  });

  // ===== Vehicles =============================================================

  const vehicleFields = {
    make: text(60),
    model: text(60),
    year: z.number().int().min(1990).max(new Date().getFullYear() + 1),
    plate: z.string().trim().min(4).max(14),
    colour: text(40),
    category: z.enum(VEHICLE_CATEGORIES),
    seats: z.number().int().min(1).max(60),
    insurer: z.string().trim().max(120).nullable().optional(),
    insurancePolicyNumber: z.string().trim().max(60).nullable().optional(),
    insuranceExpiry: futureDate.nullable().optional(),
    proposedRates: z.strictObject({ hourlyRwf: rwf, dailyRwf: rwf, airportTransferRwf: rwf }).optional(),
  };

  r.post('/vehicles', validate({ body: z.strictObject(vehicleFields) }), async (req, res) => {
    const v = await createVehicle(req.auth!.user.id, valid(req, 'body'), actor(req));
    res.status(201).json(await vehicleView(v));
  });

  r.get('/vehicles/:id', validate({ params: z.strictObject({ id: objectIdSchema }) }), async (req, res) => {
    res.json(await vehicleView(await getOwnVehicle(req.auth!.user.id, valid<{ id: string }>(req, 'params').id)));
  });

  r.put(
    '/vehicles/:id',
    validate({ params: z.strictObject({ id: objectIdSchema }), body: z.strictObject(vehicleFields).partial() }),
    async (req, res) => {
      const v = await updateVehicle(req.auth!.user.id, valid<{ id: string }>(req, 'params').id, valid(req, 'body'), actor(req));
      res.json(await vehicleView(v));
    },
  );

  r.post('/vehicles/:id/documents', limits.upload, validate({ params: z.strictObject({ id: objectIdSchema }) }), singleUpload, async (req, res) => {
    const { kind } = kindField('vehicle').parse(req.body);
    const v = await getOwnVehicle(req.auth!.user.id, valid<{ id: string }>(req, 'params').id);
    await assertUploadAllowed('vehicle', v._id, v.status, kind);
    await uploadDocument({ ownerId: req.auth!.user.id, subjectType: 'vehicle', subjectId: v._id, kind, buffer: req.file!.buffer, actor: actor(req), meta: auditContext(req) });
    res.status(201).json(await vehicleView(v));
  });

  r.post('/vehicles/:id/submit', validate({ params: z.strictObject({ id: objectIdSchema }) }), async (req, res) => {
    const v = await submitVehicle(req.auth!.user.id, valid<{ id: string }>(req, 'params').id, actor(req));
    res.json(await vehicleView(v));
  });

  r.put('/vehicles/:id/availability', validate({ params: z.strictObject({ id: objectIdSchema }), body: availabilitySchema }), async (req, res) => {
    const v = await setVehicleAvailability(req.auth!.user.id, valid<{ id: string }>(req, 'params').id, valid(req, 'body'), actor(req));
    res.json(await vehicleView(v));
  });

  // ===== Own documents ========================================================

  r.delete('/documents/:id', validate({ params: z.strictObject({ id: objectIdSchema }) }), async (req, res) => {
    await withdrawDocument(valid<{ id: string }>(req, 'params').id, req.auth!.user.id, actor(req));
    res.status(204).end();
  });

  return r;
}
