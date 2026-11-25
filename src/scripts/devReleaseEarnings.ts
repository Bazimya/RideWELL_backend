/**
 * DEVELOPMENT ONLY. Runs the real earnings-release job as if `--hours` had passed,
 * so held earnings whose dispute-free period would have ended become payable now
 * for testing payouts. It moves the job's clock only: no earning is edited by hand,
 * and the same rules apply (completed trip, no open safety report).
 *
 *   npm run dev:release-earnings -- --hours 48
 */
import { parseArgs } from 'node:util';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../db/connection.js';
import { releaseDueEarnings } from '../modules/finance/finance.service.js';

const { values } = parseArgs({ options: { hours: { type: 'string', default: '48' } } });
const hours = Number(values.hours);
const e = env();
if (e.NODE_ENV === 'production') {
  console.error('Refusing to simulate the release clock in production.');
  process.exit(1);
}
if (!Number.isInteger(hours) || hours < 0 || hours > 24 * 60) {
  console.error('--hours must be a whole number between 0 and 1440.');
  process.exit(1);
}
await connectDatabase(e.MONGODB_URI);
const n = await releaseDueEarnings(new Date(Date.now() + hours * 3_600_000));
console.log(`Released ${n} earning(s) as if ${hours} h had passed.`);
await disconnectDatabase();
