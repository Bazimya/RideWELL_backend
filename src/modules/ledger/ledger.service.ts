import type { ClientSession, Types } from 'mongoose';
import { LedgerEntryModel, type LedgerParty, type LedgerType } from './ledger.model.js';
import { MAX_RWF } from '../../lib/money.js';

export interface LedgerEntryInput {
  type: LedgerType;
  party: LedgerParty;
  partyUserId?: Types.ObjectId | string | null;
  bookingId?: Types.ObjectId | string | null;
  payoutId?: Types.ObjectId | string | null;
  refundId?: Types.ObjectId | string | null;
  amount: number;
  correctsEntryId?: Types.ObjectId | string | null;
  externalRef?: string | null;
  idempotencyKey: string;
  memo?: string | null;
  createdBy?: Types.ObjectId | string | null;
  createdBySystem?: string | null;
}

export class LedgerError extends Error {
  constructor(message: string, public readonly code: 'invalid_entry' | 'duplicate_event') {
    super(message);
    this.name = 'LedgerError';
  }
}

const NEGATIVE_ALLOWED: ReadonlySet<LedgerType> = new Set(['reversal', 'adjustment']);

function check(e: LedgerEntryInput): void {
  if (!Number.isSafeInteger(e.amount) || e.amount === 0 || Math.abs(e.amount) > MAX_RWF) {
    throw new LedgerError(`ledger amount must be a non-zero whole number of RWF (got ${e.amount})`, 'invalid_entry');
  }
  if (e.amount < 0 && !NEGATIVE_ALLOWED.has(e.type)) {
    throw new LedgerError(`${e.type} entries must be positive; use a reversal or adjustment to reduce an amount`, 'invalid_entry');
  }
  if (NEGATIVE_ALLOWED.has(e.type) && !e.correctsEntryId) {
    throw new LedgerError(`${e.type} entries must reference the entry they correct`, 'invalid_entry');
  }
  if (!e.createdBy && !e.createdBySystem) {
    throw new LedgerError('ledger entries must record who created them', 'invalid_entry');
  }
  if (!e.idempotencyKey || e.idempotencyKey.length > 200) {
    throw new LedgerError('ledger entries need an idempotency key', 'invalid_entry');
  }
}

/**
 * Append entries to the ledger. Pass the caller's transaction session so postings
 * commit together with the state change they record (e.g. payment → paid).
 * A repeated idempotency key raises `duplicate_event` and nothing is written.
 */
export async function postLedgerEntries(entries: LedgerEntryInput[], session: ClientSession) {
  if (!entries.length) return [];
  entries.forEach(check);
  try {
    return await LedgerEntryModel.insertMany(
      entries.map((e) => ({ ...e, createdAt: new Date() })),
      { session, ordered: true },
    );
  } catch (err: unknown) {
    if ((err as { code?: number }).code === 11000) {
      throw new LedgerError('this financial event has already been recorded', 'duplicate_event');
    }
    throw err;
  }
}
