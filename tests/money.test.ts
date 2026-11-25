import { describe, expect, it } from 'vitest';
import { applyBps, assertRwf, MoneyError, splitByBps } from '../src/lib/money.js';

describe('money', () => {
  it('splits Driver on Demand and gives the rounding remainder to the platform', () => {
    const s = splitByBps(10_001, { platform: 2500, driver: 7500 });
    expect(s).toEqual({ driver: 7500, platform: 2501 });
    expect(s.driver + s.platform).toBe(10_001);
  });

  it('splits Chauffeur three ways and always adds up exactly', () => {
    for (const total of [1, 7, 999, 33_333, 123_457, 1_000_000_000]) {
      const s = splitByBps(total, { platform: 2000, driver: 3000, vehicle_owner: 5000 });
      expect(s.platform + s.driver + s.vehicle_owner).toBe(total);
      for (const v of Object.values(s)) expect(Number.isSafeInteger(v)).toBe(true);
    }
  });

  it('rejects floats, negatives and over-large amounts', () => {
    expect(() => assertRwf(10.5)).toThrow(MoneyError);
    expect(() => assertRwf(-1)).toThrow(MoneyError);
    expect(() => assertRwf(1_000_000_001)).toThrow(MoneyError);
    expect(() => assertRwf('100')).toThrow(MoneyError);
  });

  it('rejects shares that do not add up to 100% or are not integers', () => {
    expect(() => splitByBps(1000, { platform: 2000, driver: 7000 })).toThrow(/add up/);
    expect(() => splitByBps(1000, { platform: 2500.5, driver: 7499.5 })).toThrow(MoneyError);
  });

  it('applies a refund rate rounding down', () => {
    expect(applyBps(10_001, 5000)).toBe(5000);
  });
});
