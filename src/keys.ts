import type { KeySource } from './types';

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T>(array: T) => T;
}

/** Reads `globalThis.crypto` on every call, so a polyfill loaded later is picked up. */
function getCrypto(): CryptoLike | undefined {
  const root: unknown = typeof globalThis !== 'undefined' ? globalThis : undefined;
  if (!root) return undefined;
  const value = (root as { crypto?: unknown }).crypto;
  return value && typeof value === 'object' ? (value as CryptoLike) : undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let lastSource: KeySource | undefined;
let warnedFallback = false;

function format(bytes: ArrayLike<number>): string {
  let hex = '';
  for (let i = 0; i < 16; i++) {
    let byte = bytes[i] & 0xff;
    if (i === 6) byte = (byte & 0x0f) | 0x40; // version 4
    if (i === 8) byte = (byte & 0x3f) | 0x80; // RFC 4122 variant
    hex += (byte < 16 ? '0' : '') + byte.toString(16);
    if (i === 3 || i === 5 || i === 7 || i === 9) hex += '-';
  }
  return hex;
}

function fromRandomUUID(crypto: CryptoLike | undefined): string | undefined {
  if (!crypto || typeof crypto.randomUUID !== 'function') return undefined;
  try {
    const value = String(crypto.randomUUID()).toLowerCase();
    return UUID_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function fromGetRandomValues(crypto: CryptoLike | undefined): string | undefined {
  if (!crypto || typeof crypto.getRandomValues !== 'function') return undefined;
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return format(bytes);
  } catch {
    return undefined;
  }
}

function fromMathRandom(): string {
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) bytes.push(Math.floor(Math.random() * 256));
  return format(bytes);
}

/**
 * A random UUID v4. Sources, in order:
 *
 * 1. `crypto.randomUUID()`
 * 2. `crypto.getRandomValues()` (for example from `react-native-get-random-values`)
 * 3. `Math.random()`. Not cryptographically secure, so keys are guessable, though
 *    collisions stay very unlikely. The first time this fallback is used, a
 *    warning is logged. `getKeySource()` reports it at any time.
 *
 * React Native does not ship `crypto` by default. Install a `getRandomValues`
 * polyfill, or pass your own `generateKey`, for keys that must not be guessable.
 */
export function uuidV4(): string {
  const crypto = getCrypto();
  let value = fromRandomUUID(crypto);
  if (value) {
    lastSource = 'crypto.randomUUID';
    return value;
  }
  value = fromGetRandomValues(crypto);
  if (value) {
    lastSource = 'crypto.getRandomValues';
    return value;
  }
  lastSource = 'Math.random';
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(
      '[react-native-idempotent-queue] No crypto.randomUUID or crypto.getRandomValues is available, so ' +
        'idempotency keys are generated with Math.random(). They are unique in practice but guessable. ' +
        'Install a getRandomValues polyfill such as react-native-get-random-values, or pass generateKey.',
    );
  }
  return fromMathRandom();
}

/**
 * The source `uuidV4()` used last, or the one it would use now if it has not
 * run yet.
 */
export function getKeySource(): Exclude<KeySource, 'custom'> {
  if (lastSource && lastSource !== 'custom') return lastSource;
  const crypto = getCrypto();
  if (fromRandomUUID(crypto)) return 'crypto.randomUUID';
  if (fromGetRandomValues(crypto)) return 'crypto.getRandomValues';
  return 'Math.random';
}

/** Longest accepted idempotency key, matching common payment APIs. */
export const MAX_KEY_LENGTH = 255;

export function validateKey(key: unknown, origin: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new TypeError(`${origin} must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`);
  }
  return key;
}

/** Testing hook: forget the remembered source and the warning. */
export function resetKeySourceForTests(): void {
  lastSource = undefined;
  warnedFallback = false;
}
