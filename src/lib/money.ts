/**
 * Money is always whole Rwandan francs held in a JS number that is a safe integer.
 * Percentages are basis points (1% = 100 bps, 100% = 10 000 bps), also integers.
 * No floating-point arithmetic happens on amounts anywhere in this module.
 */

export const BPS_TOTAL = 10_000;
/** Upper bound for any single amount: 1 billion RWF. Keeps amount * bps well inside 2^53. */
export const MAX_RWF = 1_000_000_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function assertRwf(amount: unknown, label = 'amount'): asserts amount is number {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) {
    throw new MoneyError(`${label} must be a whole number of RWF`);
  }
  if (amount < 0) throw new MoneyError(`${label} must not be negative`);
  if (amount > MAX_RWF) throw new MoneyError(`${label} exceeds the maximum allowed amount`);
}

export function assertBps(value: unknown, label = 'share'): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > BPS_TOTAL) {
    throw new MoneyError(`${label} must be an integer between 0 and ${BPS_TOTAL} basis points`);
  }
}

/**
 * Split `total` between parties by basis points. Every party except `platform`
 * gets floor(total * bps / 10 000); the platform gets everything that is left,
 * so the rounding remainder always goes to the platform and the parts always
 * add up to the total exactly.
 */
export function splitByBps<K extends string>(
  total: number,
  sharesBps: Record<K | 'platform', number>,
): Record<K | 'platform', number> {
  assertRwf(total, 'total');
  const entries = Object.entries(sharesBps) as [K | 'platform', number][];
  let sum = 0;
  for (const [party, bps] of entries) {
    assertBps(bps, `${party} share`);
    sum += bps;
  }
  if (sum !== BPS_TOTAL) throw new MoneyError(`shares must add up to ${BPS_TOTAL} bps (got ${sum})`);
  if (!('platform' in sharesBps)) throw new MoneyError('a platform share is required');

  const result = {} as Record<K | 'platform', number>;
  let allocated = 0;
  for (const [party, bps] of entries) {
    if (party === 'platform') continue;
    const part = Math.floor((total * bps) / BPS_TOTAL);
    result[party] = part;
    allocated += part;
  }
  result.platform = total - allocated;
  return result;
}

/** Apply a basis-point rate to an amount, rounding down (e.g. a partial refund). */
export function applyBps(amount: number, bps: number): number {
  assertRwf(amount);
  assertBps(bps);
  return Math.floor((amount * bps) / BPS_TOTAL);
}
