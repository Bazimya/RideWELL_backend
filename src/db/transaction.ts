import mongoose, { type ClientSession } from 'mongoose';

/**
 * Run `fn` inside a MongoDB transaction. The driver retries the whole callback on
 * transient errors (including write conflicts), so `fn` must be safe to re-run:
 * do not send SMS or call external services from inside it.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
