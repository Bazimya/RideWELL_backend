import crypto from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import {
  DocumentModel,
  EXPIRING_KINDS,
  IMAGE_ONLY_KINDS,
  KINDS_FOR_SUBJECT,
  MAX_PER_MULTI_KIND,
  MULTI_KINDS,
  type DocumentKind,
  type SubjectType,
} from './document.model.js';
import { inspectAndClean } from './fileInspection.js';
import { storage } from '../storage/storage.js';
import { keyedHash, safeEqual } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import type { AuthContext } from '../../middleware/auth.js';
import { API_PREFIX } from '../auth/cookies.js';
import { logger } from '../../lib/logger.js';

/** Signed document links expire after 5 minutes (brief §7). */
export const DOCUMENT_LINK_TTL_MS = 5 * 60_000;

export interface UploadInput {
  ownerId: string;
  subjectType: SubjectType;
  subjectId: string | Types.ObjectId;
  kind: DocumentKind;
  buffer: Buffer;
  actor: AuditActor;
  meta?: { ip?: string | null; userAgent?: string | null; requestId?: string | null };
}

/**
 * Store an upload: check and clean it, write it to private storage under a random
 * key, record its metadata. A new file of a single-file kind replaces any pending
 * or rejected one; an *approved* one stays in force until the new file is approved,
 * so renewing insurance never leaves a vehicle without valid cover on record.
 */
export async function uploadDocument(input: UploadInput) {
  if (!KINDS_FOR_SUBJECT[input.subjectType].includes(input.kind)) {
    throw badRequest('invalid_kind', `A ${input.kind.replace(/_/g, ' ')} cannot be attached here.`);
  }
  if (MULTI_KINDS.has(input.kind)) {
    const current = await DocumentModel.countDocuments({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
      status: { $in: ['pending', 'approved'] },
    });
    if (current >= MAX_PER_MULTI_KIND) throw conflict('too_many_files', `You can upload at most ${MAX_PER_MULTI_KIND} of these. Remove one first.`);
  }

  const clean = await inspectAndClean(input.buffer, { imagesOnly: IMAGE_ONLY_KINDS.has(input.kind) });
  const storageKey = `docs/${crypto.randomBytes(24).toString('hex')}`;
  await storage().put(storageKey, clean.body, clean.contentType);

  try {
    const doc = await DocumentModel.create({
      ownerId: input.ownerId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
      storageKey,
      contentType: clean.contentType,
      extension: clean.extension,
      size: clean.body.length,
      sha256: crypto.createHash('sha256').update(clean.body).digest('hex'),
      width: clean.width,
      height: clean.height,
    });
    if (!MULTI_KINDS.has(input.kind)) {
      await DocumentModel.updateMany(
        { _id: { $ne: doc._id }, subjectType: input.subjectType, subjectId: input.subjectId, kind: input.kind, status: { $in: ['pending', 'rejected'] } },
        { $set: { status: 'superseded' } },
      );
    }
    await recordAudit({
      actor: input.actor,
      action: 'document.uploaded',
      targetType: 'document',
      targetId: doc.id,
      after: { subjectType: input.subjectType, subjectId: String(input.subjectId), kind: input.kind, contentType: clean.contentType, size: clean.body.length },
      ...input.meta,
    });
    return doc;
  } catch (err) {
    await storage().delete(storageKey).catch((e) => logger.error({ err: e }, 'orphaned upload not removed'));
    throw err;
  }
}

/** The owner removes one of their own pending or rejected files (e.g. a blurry photo). */
export async function withdrawDocument(docId: string, ownerId: string, actor: AuditActor) {
  const doc = await DocumentModel.findOne({ _id: docId, ownerId });
  if (!doc) throw notFound('Document not found.');
  if (doc.status === 'approved') throw conflict('document_approved', 'An approved document cannot be removed. Upload a replacement instead.');
  if (doc.status === 'superseded') return;
  doc.status = 'superseded';
  await doc.save();
  await recordAudit({ actor, action: 'document.withdrawn', targetType: 'document', targetId: docId });
}

/**
 * Admin decision on one document. Licence and insurance approvals must carry the
 * expiry date the admin read on the document, which must be in the future.
 * Approving a single-file kind supersedes the previously approved file.
 */
export async function reviewDocument(
  input: { docId: string; decision: 'approved' | 'rejected'; note?: string | null; expiresAt?: Date | null; actor: AuditActor & { type: 'user' } },
  session: ClientSession,
) {
  const doc = await DocumentModel.findById(input.docId, null, { session });
  if (!doc) throw notFound('Document not found.');
  if (doc.status !== 'pending') throw conflict('not_pending', `This document is already ${doc.status}.`);
  if (input.decision === 'rejected' && !input.note?.trim()) throw badRequest('reason_required', 'Say why the document is rejected, so the partner can fix it.');
  if (input.decision === 'approved' && EXPIRING_KINDS.has(doc.kind as DocumentKind)) {
    if (!input.expiresAt) throw badRequest('expiry_required', 'Enter the expiry date shown on the document.');
    if (input.expiresAt <= new Date()) throw badRequest('document_expired', 'This document has already expired and cannot be approved.');
  }
  const before = { status: doc.status, expiresAt: doc.expiresAt };
  doc.status = input.decision;
  doc.reviewedBy = input.actor.id as unknown as Types.ObjectId;
  doc.reviewedAt = new Date();
  doc.reviewNote = input.note?.trim() || null;
  if (input.decision === 'approved' && EXPIRING_KINDS.has(doc.kind as DocumentKind)) doc.expiresAt = input.expiresAt!;
  await doc.save({ session });

  if (input.decision === 'approved' && !MULTI_KINDS.has(doc.kind as DocumentKind)) {
    await DocumentModel.updateMany(
      { _id: { $ne: doc._id }, subjectType: doc.subjectType, subjectId: doc.subjectId, kind: doc.kind, status: 'approved' },
      { $set: { status: 'superseded' } },
      { session },
    );
  }
  await recordAudit(
    {
      actor: input.actor,
      action: `document.${input.decision}`,
      targetType: 'document',
      targetId: doc.id,
      before,
      after: { status: doc.status, expiresAt: doc.expiresAt, kind: doc.kind, subjectType: doc.subjectType, subjectId: String(doc.subjectId) },
      reason: doc.reviewNote,
    },
    session,
  );
  return doc;
}

export async function listDocuments(subjectType: SubjectType, subjectId: string | Types.ObjectId, opts: { includeSuperseded?: boolean } = {}) {
  return DocumentModel.find({
    subjectType,
    subjectId,
    ...(opts.includeSuperseded ? {} : { status: { $ne: 'superseded' } }),
  })
    .sort({ createdAt: -1 })
    .lean();
}

// ---------------------------------------------------------------------------
// Access: 5-minute links bound to the caller's own session
// ---------------------------------------------------------------------------

function canAccess(auth: AuthContext, doc: { ownerId: unknown }): boolean {
  if (String(doc.ownerId) === auth.user.id) return true;
  return auth.sessionKind === 'admin' && auth.user.permissions.includes('documents.view');
}

const sign = (docId: string, sessionId: string, exp: number) => keyedHash(`${docId}.${sessionId}.${exp}`, 'document-link');

/**
 * Issue a link to view a document. It works for 5 minutes, only for the session
 * that asked for it (the content route also requires that session's bearer token),
 * so a copied link is useless to anyone else, after sign-out, or later.
 */
export async function createDocumentLink(docId: string, auth: AuthContext) {
  const doc = await DocumentModel.findById(docId).lean();
  if (!doc || !canAccess(auth, doc)) throw notFound('Document not found.');
  const exp = Date.now() + DOCUMENT_LINK_TTL_MS;
  return {
    url: `${API_PREFIX}/documents/${docId}/content?exp=${exp}&sig=${sign(docId, auth.sessionId, exp)}`,
    expiresAt: new Date(exp),
  };
}

export async function readDocumentContent(
  docId: string,
  link: { exp: number; sig: string },
  auth: AuthContext,
  meta: { ip?: string | null; userAgent?: string | null; requestId?: string | null },
) {
  if (!Number.isSafeInteger(link.exp) || link.exp < Date.now() || link.exp > Date.now() + DOCUMENT_LINK_TTL_MS + 5_000) {
    throw new AppError(410, 'link_expired', 'This document link has expired. Open the document again.');
  }
  if (!safeEqual(link.sig, sign(docId, auth.sessionId, link.exp))) throw forbidden('This document link is not valid for your session.');
  const doc = await DocumentModel.findById(docId).select('+storageKey').lean();
  if (!doc || !canAccess(auth, doc)) throw notFound('Document not found.');

  const body = await storage().get(doc.storageKey);
  const isOwner = String(doc.ownerId) === auth.user.id;
  await recordAudit({
    actor: { type: 'user', id: auth.user.id, roles: auth.user.roles },
    action: isOwner ? 'document.viewed_by_owner' : 'document.viewed_by_admin',
    targetType: 'document',
    targetId: docId,
    after: { kind: doc.kind, subjectType: doc.subjectType, subjectId: String(doc.subjectId) },
    ...meta,
  });
  return { body, contentType: doc.contentType, extension: doc.extension };
}
