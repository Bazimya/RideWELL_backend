import type { Schema } from 'mongoose';

export class AppendOnlyViolation extends Error {
  constructor(collection: string, operation: string) {
    super(`${collection} is append-only: ${operation} is not allowed`);
    this.name = 'AppendOnlyViolation';
  }
}

const BLOCKED_QUERY_OPS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

/**
 * Make a collection append-only at the application layer: inserts are allowed,
 * every update, replace and delete throws. In production the database user is also
 * given an insert/find-only role on these collections (see docs/DATABASE.md), so
 * the rule holds even if application code is bypassed.
 */
export function appendOnly(schema: Schema, collection: string): void {
  for (const op of BLOCKED_QUERY_OPS) {
    schema.pre(op, function () {
      throw new AppendOnlyViolation(collection, op);
    });
  }
  schema.pre('deleteOne', { document: true, query: false }, function () {
    throw new AppendOnlyViolation(collection, 'document deleteOne');
  });
  schema.pre('save', function () {
    if (!this.isNew) throw new AppendOnlyViolation(collection, 'save of an existing document');
  });
  schema.pre('bulkWrite', function (next, ops: Array<Record<string, unknown>>) {
    if (ops.some((o) => !('insertOne' in o))) throw new AppendOnlyViolation(collection, 'bulkWrite with non-insert operations');
    next();
  });
}
