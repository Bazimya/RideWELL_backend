import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import mongoose from 'mongoose';

const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ridewell-outbox-'));
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ridewell-storage-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGODB_URI: inject('mongoUri'),
  JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'),
  HASH_PEPPER: crypto.randomBytes(32).toString('hex'),
  DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  CORS_ORIGINS: 'http://localhost:5173',
  APP_BASE_URL: 'http://localhost:5173',
  OUTBOX_DIR: outbox,
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: storageDir,
  EMAIL_SIGNUP_WITHOUT_VERIFICATION: 'true',
  JOBS_ENABLED: 'false',
  DEV_VERIFICATION_CODE: '',
  LOG_LEVEL: 'silent',
});

const { connectDatabase, ensureIndexes } = await import('../src/db/connection.js');
// Register every model before building indexes.
await import('../src/app.js');
await import('../src/modules/ledger/ledger.model.js');
await import('../src/modules/platformConfig/platformConfig.model.js');
await import('../src/modules/jobs/job.model.js');
await import('../src/modules/documents/document.model.js');
await import('../src/modules/partners/partner.models.js');
await import('../src/modules/bookings/booking.model.js');
await import('../src/modules/payments/payment.model.js');
await import('../src/modules/bookings/alerts.js');
await import('../src/modules/bookings/safety.js');
await import('../src/modules/bookings/availability.js');
await import('../src/modules/finance/finance.models.js');

beforeAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await connectDatabase(process.env.MONGODB_URI!);
    await ensureIndexes();
  }
});

/**
 * Wipe data between tests. Uses the raw driver on purpose: append-only collections
 * refuse deletes through the models, which is exactly what the app must do.
 */
beforeEach(async () => {
  const db = mongoose.connection.db!;
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
  fs.rmSync(outbox, { recursive: true, force: true });
  fs.mkdirSync(outbox, { recursive: true });
});

afterAll(async () => {
  await mongoose.disconnect();
});
