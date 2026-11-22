import type { RetryPolicy } from './types';

export interface ResolvedRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

/**
 * The longest wait the queue schedules after a failure, from a classifier's
 * `delayMs` or a `Retry-After` header: 24 hours. Longer values, `Infinity`
 * included, are cut to this.
 */
export const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

/** The smallest accepted `baseDelayMs` and `maxDelayMs`. */
export const MIN_POLICY_DELAY_MS = 10;

/**
 * The shortest wait before an automatic retry. A zero delay would start the
 * next attempt in the same turn of the event loop; with a `send` that fails
 * at once, that loop never lets anything else run.
 */
export const MIN_RETRY_DELAY_MS = 1;

/**
 * A delay from outside (a classifier, a header) as a safe number of
 * milliseconds in `[MIN_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS]`, or `undefined`
 * when it is not a number at all.
 */
export function clampRetryDelay(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, Math.round(value)));
}

function check(name: string, value: number, min: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < min) {
    throw new TypeError(`retry.${name} must be a number >= ${min}, got ${String(value)}`);
  }
  return value;
}

export function resolveRetryPolicy(policy: RetryPolicy | undefined): ResolvedRetryPolicy {
  const merged = { ...DEFAULT_RETRY_POLICY, ...(policy || {}) };
  const maxAttempts = check('maxAttempts', merged.maxAttempts, 1);
  if (maxAttempts !== Infinity && Math.floor(maxAttempts) !== maxAttempts) {
    throw new TypeError(`retry.maxAttempts must be an integer or Infinity, got ${maxAttempts}`);
  }
  const baseDelayMs = check('baseDelayMs', merged.baseDelayMs, MIN_POLICY_DELAY_MS);
  const maxDelayMs = check('maxDelayMs', merged.maxDelayMs, MIN_POLICY_DELAY_MS);
  if (!isFinite(baseDelayMs) || !isFinite(maxDelayMs)) {
    throw new TypeError('retry.baseDelayMs and retry.maxDelayMs must be finite');
  }
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

/**
 * The largest delay allowed after `failures` failed attempts (1 or more):
 * `min(maxDelayMs, baseDelayMs * 2 ** (failures - 1))`.
 */
export function backoffCeiling(failures: number, policy: ResolvedRetryPolicy): number {
  const exponent = Math.max(0, Math.min(failures - 1, 1023));
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, exponent));
}

/**
 * Exponential backoff with full jitter: a uniform delay in `[0, ceiling)`.
 * `random` must return a number in `[0, 1)`; values outside are clamped.
 */
export function backoffDelay(failures: number, policy: ResolvedRetryPolicy, random: () => number): number {
  const ceiling = backoffCeiling(failures, policy);
  let r = random();
  if (!(r >= 0)) r = 0;
  if (r >= 1) r = 1 - Number.EPSILON;
  return Math.floor(r * ceiling);
}
