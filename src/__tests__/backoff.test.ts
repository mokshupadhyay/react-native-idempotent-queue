import fc from 'fast-check';
import { backoffCeiling, backoffDelay, DEFAULT_RETRY_POLICY, resolveRetryPolicy } from '../backoff';

describe('backoff', () => {
  const policy = resolveRetryPolicy({ baseDelayMs: 100, maxDelayMs: 1000 });

  it('doubles the ceiling after each failure up to maxDelayMs', () => {
    expect([1, 2, 3, 4, 5, 6].map((failures) => backoffCeiling(failures, policy))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
    expect(backoffCeiling(5000, policy)).toBe(1000);
  });

  it('draws a uniform delay in [0, ceiling) (full jitter)', () => {
    expect(backoffDelay(3, policy, () => 0)).toBe(0);
    expect(backoffDelay(3, policy, () => 0.5)).toBe(200);
    expect(backoffDelay(3, policy, () => 0.999999)).toBe(399);
  });

  it('stays within bounds for any policy, failure count and random value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 100000 }),
        fc.integer({ min: 10, max: 1000000 }),
        fc.integer({ min: 1, max: 2000 }),
        fc.double({ min: -1, max: 2, noNaN: false }),
        (baseDelayMs, maxDelayMs, failures, r) => {
          const p = resolveRetryPolicy({ baseDelayMs, maxDelayMs });
          const ceiling = backoffCeiling(failures, p);
          const delay = backoffDelay(failures, p, () => r);
          expect(ceiling).toBeLessThanOrEqual(maxDelayMs);
          expect(ceiling).toBeLessThanOrEqual(baseDelayMs * Math.pow(2, Math.min(failures - 1, 1023)));
          expect(Number.isInteger(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(0);
          if (ceiling > 0) expect(delay).toBeLessThan(ceiling);
          else expect(delay).toBe(0);
        },
      ),
    );
  });

  it('uses documented defaults and rejects invalid policies', () => {
    expect(resolveRetryPolicy(undefined)).toEqual(DEFAULT_RETRY_POLICY);
    expect(DEFAULT_RETRY_POLICY).toEqual({ maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 60000 });
    expect(resolveRetryPolicy({ maxAttempts: Infinity }).maxAttempts).toBe(Infinity);
    expect(() => resolveRetryPolicy({ maxAttempts: 0 })).toThrow(TypeError);
    expect(() => resolveRetryPolicy({ maxAttempts: 2.5 })).toThrow(TypeError);
    expect(() => resolveRetryPolicy({ baseDelayMs: -1 })).toThrow(TypeError);
    expect(() => resolveRetryPolicy({ baseDelayMs: 0 })).toThrow(TypeError);
    expect(() => resolveRetryPolicy({ maxDelayMs: 9 })).toThrow(TypeError);
    expect(() => resolveRetryPolicy({ maxDelayMs: Infinity })).toThrow(TypeError);
    expect(() => resolveRetryPolicy({ baseDelayMs: NaN })).toThrow(TypeError);
  });
});
