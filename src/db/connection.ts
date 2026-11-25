import mongoose from 'mongoose';
import { logger } from '../lib/logger.js';

mongoose.set('strictQuery', true);
// Never let a query filter silently drop unknown fields: a typo must fail, not match everything.
mongoose.set('strict', 'throw');
// Operator injection is blocked at the request edge (rejectOperatorKeys) and by strict
// zod schemas; mongoose's sanitizeFilter is not used because it also neutralises the
// server's own $gt/$lt filters.

export async function connectDatabase(uri: string): Promise<typeof mongoose> {
  const conn = await mongoose.connect(uri, {
    autoIndex: false, // indexes are built explicitly by ensureIndexes()
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 10_000,
  });

  // Transactions (double-booking prevention, ledger postings) need a replica set.
  const hello = await conn.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName) {
    throw new Error('MongoDB must run as a replica set (transactions are required). Locally: mongod --replSet rs0, then rs.initiate().');
  }
  logger.info({ replicaSet: hello.setName }, 'database connected');
  return conn;
}

/**
 * Make every collection's indexes match the schemas: create missing ones and drop
 * ones no longer defined (e.g. an index whose options changed). Run at startup.
 */
export async function ensureIndexes(): Promise<void> {
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection().catch(() => undefined);
    await model.syncIndexes();
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
