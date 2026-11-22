import { defaultClassifyError, HttpError } from '../classify';
import { fetchSender, type FetchLike } from '../fetchSender';
import { createIdempotentQueue } from '../queue';
import { createMemoryStorage } from '../storage';
import type { QueueItem } from '../types';

function response(status: number, body = '', headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  Object.keys(headers).forEach((name) => (lower[name.toLowerCase()] = headers[name]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (name: string) => lower[name.toLowerCase()] || null },
    text: async () => body,
  };
}

const item = (payload: unknown, key = 'key-1'): QueueItem => ({
  id: 'id-1',
  key,
  payload,
  status: 'inflight',
  attempts: 1,
  sequence: 1,
  createdAt: 0,
  updatedAt: 0,
  nextAttemptAt: 0,
});

describe('fetchSender', () => {
  it('posts the payload as JSON with the Idempotency-Key header', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      response(201, '{"id":"pay_1"}', { 'Content-Type': 'application/json; charset=utf-8' }),
    );
    const send = fetchSender('https://api.example.com/payments', { headers: { Authorization: 'Bearer t' } }, { fetch });
    const result = await send(item({ amount: 5 }), { key: 'key-1', attempt: 1 });
    expect(result).toEqual({ id: 'pay_1' });
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/payments', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Idempotency-Key': 'key-1', 'Content-Type': 'application/json' },
      body: '{"amount":5}',
    });
  });

  it('never lets a caller header replace the key, and keeps a custom content type', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () => response(200, 'done'));
    const send = fetchSender(
      (queued) => `https://api.example.com/orders/${(queued.payload as { order: string }).order}`,
      () => ({ method: 'PUT', headers: { 'idempotency-key': 'stale', 'content-type': 'application/vnd+json' } }),
      { fetch, headerName: 'X-Request-Id' },
    );
    expect(await send(item({ order: 'o1' }), { key: 'fresh', attempt: 2 })).toBe('done');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/orders/o1');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'idempotency-key': 'stale', 'content-type': 'application/vnd+json', 'X-Request-Id': 'fresh' });
  });

  it('removes a caller header with the same name as the key header', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () => response(204));
    const send = fetchSender('u', { headers: { 'idempotency-key': 'stale' } }, { fetch });
    expect(await send(item('raw text'), { key: 'fresh', attempt: 1 })).toBeUndefined();
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { 'Idempotency-Key': 'fresh' }, body: 'raw text' });
  });

  it('throws an HttpError the default classifier understands', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      response(429, '{"error":"slow down"}', { 'Retry-After': '7', 'Content-Type': 'application/json' }),
    );
    const send = fetchSender('u', undefined, { fetch });
    const error = await send(item(1), { key: 'k', attempt: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, body: { error: 'slow down' }, message: 'HTTP 429 Error' });
    expect(defaultClassifyError(error, { now: 0 })).toEqual({ type: 'rateLimited', delayMs: 7000 });
  });

  it('lets network failures reject as fetch does', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () => {
      throw new TypeError('Network request failed');
    });
    const send = fetchSender('u', undefined, { fetch });
    await expect(send(item(1), { key: 'k', attempt: 1 })).rejects.toThrow('Network request failed');
  });

  it('uses the global fetch by default', async () => {
    const global = globalThis as { fetch?: unknown };
    const original = global.fetch;
    global.fetch = jest.fn(async () => response(200, 'ok'));
    try {
      expect(await fetchSender('u')(item(1), { key: 'k', attempt: 1 })).toBe('ok');
    } finally {
      global.fetch = original;
    }
  });

  it('works as the queue sender end to end', async () => {
    const seen: string[] = [];
    let calls = 0;
    const fetch: FetchLike = async (_url, init) => {
      seen.push((init.headers as Record<string, string>)['Idempotency-Key']);
      calls++;
      return calls === 1 ? response(503) : response(200, '{"ok":true}', { 'content-type': 'application/json' });
    };
    let now = 0;
    const queue = createIdempotentQueue({
      storage: createMemoryStorage(),
      send: fetchSender('u', undefined, { fetch }),
      now: () => now,
      random: () => 0,
      // These timers ignore the delay, so an attempt timeout would fire at once.
      attemptTimeoutMs: Infinity,
      timers: { setTimeout: (callback) => Promise.resolve().then(callback), clearTimeout: () => undefined },
    });
    await queue.start();
    await queue.enqueue({ payload: { amount: 1 }, key: 'pay-1' });
    for (let i = 0; i < 100 && queue.getItems()[0].status !== 'succeeded'; i++) {
      now += 1;
      await Promise.resolve();
    }
    expect(queue.getItems()[0].status).toBe('succeeded');
    expect(seen).toEqual(['pay-1', 'pay-1']);
    await queue.stop();
  });
});
