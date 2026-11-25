import crypto from 'node:crypto';
import os from 'node:os';
import { JobModel } from './job.model.js';
import { logger } from '../../lib/logger.js';

export interface JobDefinition {
  name: string;
  intervalMs: number;
  /** How long a run may hold the lease before another instance may take over. */
  leaseMs?: number;
  handler: (ctx: { now: Date }) => Promise<void>;
}

const instanceId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

/**
 * MongoDB-backed recurring jobs. A job runs only after an instance wins its lease
 * with a single conditional update, so running several API instances never runs
 * the same job twice at once. A crashed run's lease simply expires.
 */
export class Scheduler {
  private readonly jobs = new Map<string, JobDefinition>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly owner: string = instanceId) {}

  register(def: JobDefinition): void {
    if (this.jobs.has(def.name)) throw new Error(`Job ${def.name} registered twice`);
    this.jobs.set(def.name, def);
  }

  async ensureJobRows(now = new Date()): Promise<void> {
    for (const name of this.jobs.keys()) {
      await JobModel.updateOne({ name }, { $setOnInsert: { name, nextRunAt: now } }, { upsert: true });
    }
  }

  /** Try to run one job if it is due. Returns true if this instance ran it. */
  async runIfDue(name: string, now = new Date()): Promise<boolean> {
    const def = this.jobs.get(name);
    if (!def) throw new Error(`Unknown job ${name}`);
    const leaseMs = def.leaseMs ?? Math.max(60_000, def.intervalMs);

    const claimed = await JobModel.findOneAndUpdate(
      {
        name,
        nextRunAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
      },
      { $set: { lockedBy: this.owner, lockedUntil: new Date(now.getTime() + leaseMs), lastStartedAt: now } },
      { new: true },
    ).lean();
    if (!claimed) return false;

    let error: string | null = null;
    try {
      await def.handler({ now });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error({ err, job: name }, 'job failed');
    }
    await JobModel.updateOne(
      { name, lockedBy: this.owner },
      {
        $set: { lockedBy: null, lockedUntil: null, lastFinishedAt: new Date(), lastError: error, nextRunAt: new Date(Date.now() + def.intervalMs) },
        $inc: { runCount: 1 },
      },
    );
    return true;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const name of this.jobs.keys()) await this.runIfDue(name, now);
    } finally {
      this.ticking = false;
    }
  }

  async start(pollMs = 5_000): Promise<void> {
    await this.ensureJobRows();
    this.timer = setInterval(() => void this.tick().catch((err) => logger.error({ err }, 'scheduler tick failed')), pollMs);
    this.timer.unref();
    logger.info({ jobs: [...this.jobs.keys()], owner: this.owner }, 'scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
