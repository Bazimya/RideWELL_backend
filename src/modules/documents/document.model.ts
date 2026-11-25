import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const SUBJECT_TYPES = ['driver', 'owner', 'vehicle'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const DOCUMENT_KINDS = [
  // people
  'id_document', // national ID or passport
  'driving_licence',
  'profile_photo',
  'good_conduct_certificate',
  'rdb_certificate', // company registration (RDB)
  'authorisation_letter', // company: authority of the representative
  // vehicles
  'registration_certificate',
  'ownership_proof', // ownership, or the owner's authorisation to rent it out
  'insurance',
  'vehicle_photo',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_STATUSES = ['pending', 'approved', 'rejected', 'superseded'] as const;

/**
 * Metadata for one uploaded file. The file itself lives in private storage under
 * `storageKey` (random, meaningless). Referenced, not embedded, in partner
 * profiles and vehicles: documents are reviewed, versioned and access-logged
 * individually.
 */
const documentSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    subjectType: { type: String, enum: SUBJECT_TYPES, required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: DOCUMENT_KINDS, required: true },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'pending' },
    storageKey: { type: String, required: true, select: false },
    contentType: { type: String, enum: ['image/jpeg', 'image/png', 'application/pdf'], required: true },
    extension: { type: String, enum: ['jpg', 'png', 'pdf'], required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    width: Number,
    height: Number,
    /** Expiry confirmed by the reviewing admin (licence, insurance). The authoritative date. */
    expiresAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, maxlength: 500, default: null },
    expiryWarningSentAt: { type: Date, default: null },
    expiredNoticeSentAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

documentSchema.index({ subjectType: 1, subjectId: 1, kind: 1, status: 1 });
documentSchema.index({ ownerId: 1, createdAt: -1 });
documentSchema.index({ kind: 1, status: 1, expiresAt: 1 });

export type DocumentRecord = InferSchemaType<typeof documentSchema>;
export type DocumentDoc = HydratedDocument<DocumentRecord>;
export const DocumentModel = model('Document', documentSchema, 'documents');

/** Kinds that hold an expiry date the admin must confirm on approval. */
export const EXPIRING_KINDS: ReadonlySet<DocumentKind> = new Set(['driving_licence', 'insurance']);
/** Kinds that must be photos, not PDFs. */
export const IMAGE_ONLY_KINDS: ReadonlySet<DocumentKind> = new Set(['profile_photo', 'vehicle_photo']);
/** Kinds where several current files may coexist; every other kind keeps one current file. */
export const MULTI_KINDS: ReadonlySet<DocumentKind> = new Set(['vehicle_photo', 'other']);
export const MAX_PER_MULTI_KIND = 8;

/** Which kinds each subject may hold. */
export const KINDS_FOR_SUBJECT: Record<SubjectType, readonly DocumentKind[]> = {
  driver: ['id_document', 'driving_licence', 'profile_photo', 'good_conduct_certificate', 'other'],
  owner: ['id_document', 'rdb_certificate', 'authorisation_letter', 'other'],
  vehicle: ['registration_certificate', 'ownership_proof', 'insurance', 'vehicle_photo', 'other'],
};

export function toDocumentView(d: { _id: unknown; kind: string; status: string; contentType: string; size: number; expiresAt?: Date | null; reviewNote?: string | null; reviewedAt?: Date | null; createdAt?: Date; width?: number | null; height?: number | null }) {
  return {
    id: String(d._id),
    kind: d.kind,
    status: d.status,
    contentType: d.contentType,
    size: d.size,
    expiresAt: d.expiresAt ?? null,
    reviewNote: d.reviewNote ?? null,
    reviewedAt: d.reviewedAt ?? null,
    uploadedAt: d.createdAt ?? null,
  };
}
