import type { ClassifyContext, ErrorClassification } from './types';

type HeaderSource =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | number | undefined | null>;

/**
 * Thrown by `fetchSender` for a response that is not 2xx. The default
 * classifier reads `status` and the `Retry-After` header from it. It also
 * understands errors shaped like `{ status, headers }` and Axios errors
 * (`{ response: { status, headers } }`).
 */
export class HttpError extends Error {
  readonly status: number;
  readonly headers: HeaderSource | undefined;
  /** The response body, when it could be read. */
  readonly body: unknown;

  constructor(status: number, message?: string, headers?: HeaderSource, body?: unknown) {
    super(message || `HTTP ${status}`);
    // Keep `instanceof` working when the class is compiled to ES5 by an app's Babel config.
    Object.setPrototypeOf(this, HttpError.prototype);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = (getter as (key: string) => unknown).call(headers, name);
    return value == null ? undefined : String(value);
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = (headers as Record<string, unknown>)[key];
      if (value == null) return undefined;
      return Array.isArray(value) ? String(value[0]) : String(value);
    }
  }
  return undefined;
}

/**
 * Parses a `Retry-After` value: delay-seconds or an HTTP date.
 * Returns milliseconds from `now`, never negative, or `undefined` if invalid.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(parseFloat(trimmed) * 1000);
  // An HTTP date names a weekday or month; this also stops Date.parse('-1') from reading a year.
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** The HTTP status and headers of an error, if it has them. */
export function httpDetails(error: unknown): { status: number; headers: unknown } | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = error as { status?: unknown; headers?: unknown; response?: unknown };
  if (typeof direct.status === 'number') return { status: direct.status, headers: direct.headers };
  const response = direct.response as { status?: unknown; headers?: unknown } | undefined;
  if (response && typeof response === 'object' && typeof response.status === 'number') {
    return { status: response.status, headers: response.headers };
  }
  return undefined;
}

/**
 * The default classifier:
 *
 * | Error | Decision |
 * | --- | --- |
 * | No HTTP status (network failure, timeout, any other thrown value) | retryable |
 * | 408, 425, 429, 500-599 | retryable; `rateLimited` when a valid `Retry-After` is present |
 * | Any other status (other 4xx, and 1xx-3xx thrown as errors) | permanent |
 */
export function defaultClassifyError(error: unknown, context: Pick<ClassifyContext, 'now'>): ErrorClassification {
  const details = httpDetails(error);
  if (!details) return { type: 'retryable' };
  const { status } = details;
  const retryable = status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
  if (!retryable) return { type: 'permanent' };
  const delayMs = parseRetryAfter(readHeader(details.headers, 'Retry-After'), context.now);
  if (delayMs !== undefined) return { type: 'rateLimited', delayMs };
  return { type: 'retryable' };
}
