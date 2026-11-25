import type { JobDefinition } from '../jobs/scheduler.js';
import { acceptanceTimeouts, expireQuotes, notStartedAlerts } from './booking.service.js';

/** Booking jobs. Each run is idempotent; the scheduler's lease keeps them single-instance. */
export const bookingJobs: JobDefinition[] = [
  { name: 'bookings.expire-quotes', intervalMs: 60_000, handler: async ({ now }) => void (await expireQuotes(now)) },
  { name: 'bookings.acceptance-timeouts', intervalMs: 60_000, handler: async ({ now }) => void (await acceptanceTimeouts(now)) },
  { name: 'bookings.not-started-alerts', intervalMs: 60_000, handler: async ({ now }) => void (await notStartedAlerts(now)) },
];
