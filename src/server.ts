import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDatabase, disconnectDatabase, ensureIndexes } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { createApp } from './app.js';
import { Scheduler } from './modules/jobs/scheduler.js';
import { documentExpiryJob } from './modules/partners/expiryJob.js';
import { bookingJobs } from './modules/bookings/jobs.js';
import { financeJobs } from './modules/finance/finance.routes.js';
import { attachTrackingSocket } from './modules/tracking/tracking.ws.js';
import { notificationJobs } from './modules/notifications/notification.routes.js';

async function main() {
  const e = env(); // throws on invalid or unsafe configuration
  await connectDatabase(e.MONGODB_URI);
  await ensureIndexes();
  await runMigrations();

  const scheduler = new Scheduler();
  scheduler.register(documentExpiryJob);
  for (const job of [...bookingJobs, ...financeJobs, ...notificationJobs]) scheduler.register(job);
  // Location retention needs no job: a TTL index on locationPoints.purgeAt deletes points.
  if (e.JOBS_ENABLED) await scheduler.start();

  const app = createApp();
  const server = app.listen(e.PORT, () => logger.info({ port: e.PORT, env: e.NODE_ENV }, 'RideWELL API listening'));
  const wss = attachTrackingSocket(server);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    wss.close();
    server.close();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
