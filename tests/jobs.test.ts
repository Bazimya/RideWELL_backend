import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/modules/jobs/scheduler.js';
import { JobModel } from '../src/modules/jobs/job.model.js';

describe('job scheduler', () => {
  it('runs a due job on exactly one instance even when several race for it', async () => {
    let runs = 0;
    const handler = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 50));
    };
    const instances = Array.from({ length: 5 }, (_, i) => {
      const s = new Scheduler(`instance-${i}`);
      s.register({ name: 'test.job', intervalMs: 60_000, handler });
      return s;
    });
    await instances[0]!.ensureJobRows();
    const results = await Promise.all(instances.map((s) => s.runIfDue('test.job')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(runs).toBe(1);

    // Not due again until the interval has passed.
    expect(await instances[1]!.runIfDue('test.job')).toBe(false);
    const row = await JobModel.findOne({ name: 'test.job' }).lean();
    expect(row!.lockedBy).toBeNull();
    expect(row!.runCount).toBe(1);
  });

  it('lets another instance take over when a run’s lease has expired (crashed instance)', async () => {
    const a = new Scheduler('a');
    const b = new Scheduler('b');
    let ranOnB = false;
    a.register({ name: 'crashy', intervalMs: 1000, leaseMs: 1000, handler: async () => undefined });
    b.register({ name: 'crashy', intervalMs: 1000, leaseMs: 1000, handler: async () => void (ranOnB = true) });
    await a.ensureJobRows();
    // Simulate "a" holding the lease and dying.
    await JobModel.updateOne({ name: 'crashy' }, { $set: { lockedBy: 'a', lockedUntil: new Date(Date.now() - 1) } });
    expect(await b.runIfDue('crashy')).toBe(true);
    expect(ranOnB).toBe(true);
  });

  it('records a failing job’s error and keeps scheduling it', async () => {
    const s = new Scheduler('x');
    s.register({ name: 'failing', intervalMs: 1000, handler: async () => { throw new Error('boom'); } });
    await s.ensureJobRows();
    await s.runIfDue('failing');
    const row = await JobModel.findOne({ name: 'failing' }).lean();
    expect(row!.lastError).toBe('boom');
    expect(row!.lockedBy).toBeNull();
    expect(row!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });
});
