import { defaultClassifyError, HttpError, httpDetails, parseRetryAfter } from '../classify';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const classify = (error: unknown) => defaultClassifyError(error, { now: NOW });

describe('defaultClassifyError', () => {
  it.each([
    ['a network failure', new TypeError('Network request failed'), { type: 'retryable' }],
    ['an abort or timeout', Object.assign(new Error('Aborted'), { name: 'AbortError' }), { type: 'retryable' }],
    ['a thrown string', 'boom', { type: 'retryable' }],
    ['undefined', undefined, { type: 'retryable' }],
    ['408', new HttpError(408), { type: 'retryable' }],
    ['425', new HttpError(425), { type: 'retryable' }],
    ['429 without Retry-After', new HttpError(429), { type: 'retryable' }],
    ['500', new HttpError(500), { type: 'retryable' }],
    ['502', new HttpError(502), { type: 'retryable' }],
    ['503', new HttpError(503), { type: 'retryable' }],
    ['599', new HttpError(599), { type: 'retryable' }],
    ['400', new HttpError(400), { type: 'permanent' }],
    ['401', new HttpError(401), { type: 'permanent' }],
    ['403', new HttpError(403), { type: 'permanent' }],
    ['404', new HttpError(404), { type: 'permanent' }],
    ['409 (same key still processing)', new HttpError(409), { type: 'retryable' }],
    ['422', new HttpError(422), { type: 'permanent' }],
    ['304 thrown as an error', new HttpError(304), { type: 'permanent' }],
    ['600', new HttpError(600), { type: 'permanent' }],
    ['a plain { status } object', { status: 503 }, { type: 'retryable' }],
    ['an Axios-style error', { message: 'x', response: { status: 404, headers: {} } }, { type: 'permanent' }],
  ])('%s', (_name, error, expected) => {
    expect(classify(error)).toEqual(expected);
  });

  it('honours Retry-After in seconds on 429 and 503', () => {
    expect(classify(new HttpError(429, undefined, { 'Retry-After': '3' }))).toEqual({
      type: 'rateLimited',
      delayMs: 3000,
    });
    expect(classify({ response: { status: 503, headers: { 'retry-after': '120' } } })).toEqual({
      type: 'rateLimited',
      delayMs: 120000,
    });
  });

  it('honours Retry-After as an HTTP date, read through headers.get()', () => {
    const headers = { get: (name: string) => (name === 'Retry-After' ? 'Thu, 01 Jan 2026 00:00:30 GMT' : null) };
    expect(classify(new HttpError(503, undefined, headers))).toEqual({ type: 'rateLimited', delayMs: 30000 });
  });

  it('ignores Retry-After on permanent errors and when it is invalid', () => {
    expect(classify(new HttpError(400, undefined, { 'Retry-After': '5' }))).toEqual({ type: 'permanent' });
    expect(classify(new HttpError(429, undefined, { 'Retry-After': 'soon' }))).toEqual({ type: 'retryable' });
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and dates and never returns a negative delay', () => {
    expect(parseRetryAfter('0', NOW)).toBe(0);
    expect(parseRetryAfter(' 2 ', NOW)).toBe(2000);
    expect(parseRetryAfter('1.5', NOW)).toBe(1500);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', NOW)).toBe(0);
    expect(parseRetryAfter('-1', NOW)).toBeUndefined();
    expect(parseRetryAfter('', NOW)).toBeUndefined();
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter('later', NOW)).toBeUndefined();
  });
});

describe('HttpError', () => {
  it('keeps instanceof, status, headers and body', () => {
    const error = new HttpError(418, undefined, { a: 'b' }, { reason: 'teapot' });
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('HTTP 418');
    expect(error.body).toEqual({ reason: 'teapot' });
    expect(httpDetails(error)).toEqual({ status: 418, headers: { a: 'b' } });
  });
});
