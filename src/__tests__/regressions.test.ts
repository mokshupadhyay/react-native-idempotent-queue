/*
 * Regression tests for the review of 0.1.0. Each `describe` is one finding.
 * Every test here failed on 0.1.0; see CHANGELOG.md for the fixes.
 */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { MAX_RETRY_DELAY_MS } from '../backoff';
import { defaultClassifyError, HttpError, parseRetryAfter } from '../classify';
import { fetchSender, type FetchLike } from '../fetchSender';
import { useQueueItems } from '../hook';
import { AttemptTimeoutError, QueueFullError } from '../index';
import { QueuePersistence, readQuarantine } from '../persistence';
import { createIdempotentQueue } from '../queue';
import { createMemoryStorage } from '../storage';
import type { ErrorClassification, QueueItem, QueueStorage, SendContext } from '../types';
import { harness, holdingStorage, invalidSlots, reloadedKeys } from './support/harness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Node's fetch Headers; the library is built without DOM typings.
declare const Headers: new (init?: Record<string, string>) => unknown;

const PREFIX = 'react-native-idempotent-queue';
const keys = (items: readonly QueueItem[]) => items.map((item) => item.key);
const statuses = (items: readonly QueueItem[]) => items.map((item) => `${item.key}:${item.status}`);

const consoleError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    consoleError(...args);
  });
});
afterAll(() => jest.restoreAllMocks());

describe('finding 1: a non-finite delay never makes the stored queue unreadable', () => {
  it('caps Retry-After values that are huge or would parse to Infinity', () => {
    expect(MAX_RETRY_DELAY_MS).toBe(24 * 60 * 60 * 1000);
    expect(parseRetryAfter('9'.repeat(400), 0)).toBe(MAX_RETRY_DELAY_MS);
    expect(parseRetryAfter('99999999999', 0)).toBe(MAX_RETRY_DELAY_MS);
    expect(parseRetryAfter('Fri, 31 Dec 9999 23:59:59 GMT', 0)).toBe(MAX_RETRY_DELAY_MS);
    expect(parseRetryAfter('120', 0)).toBe(120000);
    expect(parseRetryAfter('-5', 0)).toBeUndefined();
  });

  it('keeps every item across a restart after a 503 with a 400-digit Retry-After', async () => {
    const storage = createMemoryStorage();
    const { queue, calls, tick } = harness({}, storage);
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k1' });
    await queue.enqueue({ payload: 2, key: 'k2' });
    await queue.enqueue({ payload: 3, key: 'k3' });
    await tick();
    calls[0].resolve('ok');
    await tick();
    calls[1].reject(new HttpError(503, 'busy', { 'Retry-After': '9'.repeat(400) }));
    await tick();
    calls[2].resolve('ok');
    await tick();
    await queue.stop();
    expect(statuses(queue.getItems())).toEqual(['k1:succeeded', 'k2:pending', 'k3:succeeded']);
    expect(Number.isFinite(queue.getItems()[1].nextAttemptAt)).toBe(true);
    expect(invalidSlots(storage.data)).toEqual([]);
    expect(await reloadedKeys(storage.data)).toEqual(['k1', 'k2', 'k3']);
  });

  const outputs: Array<[string, unknown]> = [
    ['retryable, delayMs Infinity', { type: 'retryable', delayMs: Infinity }],
    ['retryable, delayMs -Infinity', { type: 'retryable', delayMs: -Infinity }],
    ['retryable, delayMs NaN', { type: 'retryable', delayMs: NaN }],
    ['retryable, delayMs 1e308', { type: 'retryable', delayMs: 1e308 }],
    ['rateLimited, delayMs Infinity', { type: 'rateLimited', delayMs: Infinity }],
    ['rateLimited, delayMs -1', { type: 'rateLimited', delayMs: -1 }],
    ['rateLimited, delayMs Number.MAX_VALUE', { type: 'rateLimited', delayMs: Number.MAX_VALUE }],
  ];
  it.each(outputs)('stores a finite wait for a classifier returning %s', async (_name, output) => {
    const storage = createMemoryStorage();
    const { queue, calls, clock, tick } = harness(
      { classifyError: () => output as ErrorClassification },
      storage,
    );
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k1', group: 'g' });
    await queue.enqueue({ payload: 2, key: 'k2', group: 'g' });
    await tick();
    calls[0].reject(new Error('hold'));
    await tick();
    const [first] = queue.getItems();
    expect(first.status).toBe('pending');
    expect(first.nextAttemptAt).toBeGreaterThan(clock.now);
    expect(first.nextAttemptAt).toBeLessThanOrEqual(clock.now + MAX_RETRY_DELAY_MS);
    expect(invalidSlots(storage.data)).toEqual([]);
    await queue.stop();
    expect(await reloadedKeys(storage.data)).toEqual(['k1', 'k2']);
  });

  it('refuses to write a state that would fail its own load validation', async () => {
    const storage = createMemoryStorage();
    const persistence = new QueuePersistence(storage, 'q', {
      onQuarantine: () => undefined,
      onStorageError: () => undefined,
      now: () => 0,
    });
    await persistence.load();
    const bad = {
      id: 'a',
      key: 'k',
      payload: 1,
      status: 'pending',
      attempts: 0,
      sequence: 1,
      createdAt: 0,
      updatedAt: 0,
      nextAttemptAt: Infinity,
    } as QueueItem;
    await expect(persistence.save(() => [bad])).rejects.toThrow(/nextAttemptAt/);
    expect(Array.from(storage.data.keys())).toEqual([]);
    await persistence.save(() => [{ ...bad, nextAttemptAt: 5 }]);
    expect(invalidSlots(storage.data)).toEqual([]);
  });
});

describe('finding 2: discard before the attempt is saved means the item is never sent', () => {
  it('does not send an item discarded while its attempt was being recorded', async () => {
    const { storage, held, state } = holdingStorage();
    const { queue, calls, tick } = harness({}, storage);
    await queue.start();
    await queue.enqueue({ payload: { amount: 999 }, key: 'pay-1' });
    state.hold = true;
    await tick();
    expect(statuses(queue.getItems())).toEqual(['pay-1:inflight']);
    expect(held).toHaveLength(1);
    const discarded = queue.discard(queue.getItems()[0].id);
    state.hold = false;
    while (held.length) {
      held.shift()!();
      await tick();
    }
    expect(await discarded).toBe(true);
    await tick();
    expect(calls).toHaveLength(0);
    expect(queue.getItems()).toEqual([]);
  });
});

describe('finding 3: clear is safe against storage failures and crashes between its steps', () => {
  /** Storage that fails (or hangs, like a killed app) on the n-th write or remove after `arm()`. */
  function faulty(initial: Record<string, string>, n: number, mode: 'fail' | 'hang') {
    const memory = createMemoryStorage(initial);
    let armed = false;
    let count = 0;
    const step = <T>(run: () => Promise<T>): Promise<T> => {
      if (armed && count++ === n) {
        return mode === 'fail' ? Promise.reject(new Error(`step ${n} failed`)) : new Promise<T>(() => undefined);
      }
      return run();
    };
    const storage: QueueStorage = {
      getItem: (key) => memory.getItem(key),
      setItem: (key, value) => step(() => memory.setItem(key, value)),
      removeItem: (key) => step(() => memory.removeItem(key)),
    };
    return { storage, memory, arm: () => (armed = true) };
  }

  async function filledQueue(n: number, mode: 'fail' | 'hang') {
    // A broken slot gives the queue a quarantine to remove as well.
    const f = faulty({ [`${PREFIX}:b`]: 'broken' }, n, mode);
    const h = harness({ isOnline: () => false }, f.storage);
    await h.queue.start();
    await h.queue.enqueue({ payload: { amount: 1 }, key: 'p1' });
    await h.queue.enqueue({ payload: { amount: 2 }, key: 'p2' });
    await h.tick();
    expect(f.memory.data.has(`${PREFIX}:quarantine`)).toBe(true);
    f.arm();
    return { ...h, ...f };
  }

  it.each([0, 1, 2, 3])('keeps memory and disk consistent when step %i fails, and keeps running', async (n) => {
    const { queue, memory, tick } = await filledQueue(n, 'fail');
    const error = await queue.clear().then(
      () => undefined,
      (e: unknown) => e,
    );
    await tick();
    expect(error).toBeInstanceOf(Error);
    expect(queue.isRunning()).toBe(true);
    const reloaded = await reloadedKeys(memory.data);
    expect(reloaded).toEqual(keys(queue.getItems()));
    expect([['p1', 'p2'], []]).toContainEqual(reloaded);
  });

  it.each([0, 1, 2, 3])('leaves a loadable state when the app dies during step %i', async (n) => {
    const { queue, memory, tick } = await filledQueue(n, 'hang');
    void queue.clear();
    await tick();
    const reloaded = await reloadedKeys(memory.data);
    // Until the first step lands nothing has changed; after it, the clear is final.
    expect(reloaded).toEqual(n === 0 ? ['p1', 'p2'] : []);
  });

  it('removes everything when every step succeeds', async () => {
    const { queue, memory } = await filledQueue(99, 'fail');
    await queue.clear();
    expect(Array.from(memory.data.keys())).toEqual([]);
    expect(queue.getItems()).toEqual([]);
    expect(queue.isRunning()).toBe(true);
  });
});

describe('finding 4: clear does not restart a queue stopped while it ran', () => {
  it('stays stopped when stop() is called during clear()', async () => {
    const { queue, calls, tick } = harness();
    await queue.start();
    const clearing = queue.clear();
    await queue.stop();
    expect(queue.isRunning()).toBe(false);
    await clearing;
    expect(queue.isRunning()).toBe(false);
    await queue.enqueue({ payload: { user: 'next' }, key: 'x' });
    await tick();
    expect(calls).toHaveLength(0);
  });
});

describe('finding 5: storage failures back off and never starve the JavaScript thread', () => {
  it('waits at least a second after a failed attempt write, doubling, without using attempts', async () => {
    const memory = createMemoryStorage();
    const seed = createIdempotentQueue({ storage: memory, send: () => undefined, now: () => 0 });
    await seed.enqueue({ payload: 1, key: 'k' });
    let writes = 0;
    const storage: QueueStorage = {
      ...memory,
      // A guard against the old busy loop: after 50 writes, hang instead of failing.
      setItem: () => (++writes > 50 ? new Promise(() => undefined) : Promise.reject(new Error('SQLITE_FULL'))),
    };
    const { queue, calls, clock, events, tick } = harness({ random: () => 0 }, storage);
    await queue.start();
    await tick();
    expect(writes).toBe(1);
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [item] = queue.getItems();
      expect(item.status).toBe('pending');
      expect(item.attempts).toBe(0);
      waits.push(item.nextAttemptAt - clock.now);
      await clock.advance(item.nextAttemptAt - clock.now);
    }
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(writes).toBe(4);
    expect(events.filter((event) => event.type === 'storage-error')).toHaveLength(4);
    expect(calls).toHaveLength(0);
  });

  it('never starts the next attempt in the same turn, even with a zero delay', async () => {
    let sends = 0;
    const { queue, tick } = harness({
      retry: { maxAttempts: Infinity },
      classifyError: () => ({ type: 'retryable', delayMs: 0 }),
      random: () => 0,
      // A guard against the old busy loop: after 20 sends, never answer.
      send: () => (++sends > 20 ? new Promise(() => undefined) : Promise.reject(new Error('no token'))),
    });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    expect(sends).toBe(1);
  });

  it('rejects retry delays below the minimum', () => {
    const storage = createMemoryStorage();
    const send = () => undefined;
    expect(() => createIdempotentQueue({ storage, send, retry: { baseDelayMs: 0 } })).toThrow(TypeError);
    expect(() => createIdempotentQueue({ storage, send, retry: { maxDelayMs: 0 } })).toThrow(TypeError);
    expect(() => createIdempotentQueue({ storage, send, retry: { baseDelayMs: Infinity } })).toThrow(TypeError);
    expect(() => createIdempotentQueue({ storage, send, retry: { baseDelayMs: 10, maxDelayMs: 10 } })).not.toThrow();
  });
});

describe('finding 6: stop waits for writes, so a stopped queue cannot overwrite a newer one', () => {
  it('does not resolve stop() while a write is in progress', async () => {
    const { storage, held, state } = holdingStorage();
    const { queue, tick } = harness({}, storage);
    await queue.start();
    state.hold = true;
    void queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    let stopped = false;
    void queue.stop().then(() => (stopped = true));
    await tick();
    expect(stopped).toBe(false);
    held.shift()!();
    await tick();
    expect(stopped).toBe(true);
  });

  it('keeps the newer instance’s enqueue when the old instance had a slow write', async () => {
    const { storage, memory, held, state } = holdingStorage();
    const old = harness({}, storage);
    await old.queue.start();
    await old.queue.enqueue({ payload: 1, key: 'old-1' });
    await old.tick();
    old.calls[0].resolve('ok');
    await old.tick();
    state.hold = true;
    const slowEnqueue = old.queue.enqueue({ payload: 2, key: 'old-2' });
    await old.tick();
    // A newer instance on the same storage takes over as soon as stop() resolves.
    const takeover = old.queue.stop().then(async () => {
      const fresh = createIdempotentQueue({ storage: memory, send: () => undefined });
      await fresh.load();
      await fresh.enqueue({ payload: 3, key: 'new-1' });
    });
    await old.tick();
    held.shift()!();
    await takeover;
    await slowEnqueue;
    expect(await reloadedKeys(memory.data)).toEqual(['old-1', 'old-2', 'new-1']);
  });

  it('writes nothing in the background after stop() resolves', async () => {
    let writes = 0;
    const memory = createMemoryStorage();
    const storage: QueueStorage = { ...memory, setItem: (k, v) => (writes++, memory.setItem(k, v)) };
    let listener: ((online: boolean) => void) | undefined;
    const { queue, calls, clock, tick } = harness(
      {
        keepSucceededMs: 1000,
        subscribeToConnectivity: (l) => {
          listener = l;
          return () => (listener = undefined);
        },
      },
      storage,
    );
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'a' });
    await queue.enqueue({ payload: 2, key: 'b' });
    await tick();
    calls[0].resolve('ok');
    await tick();
    calls[1].reject(new Error('timeout'));
    await tick();
    await queue.stop();
    const before = writes;
    if (listener) listener(true);
    await clock.advance(60 * 60 * 1000);
    expect(writes).toBe(before);
  });
});

describe('finding 7: an enqueue during clear() lands after the clear', () => {
  it('keeps, saves and sends an item enqueued while clear() runs', async () => {
    const storage = createMemoryStorage();
    const { queue, calls, tick } = harness({}, storage);
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'before-clear' });
    const clearing = queue.clear();
    const item = await queue.enqueue({ payload: { amount: 5 }, key: 'pay-after-clear' });
    await clearing;
    await tick();
    expect(item.key).toBe('pay-after-clear');
    expect(keys(queue.getItems())).toEqual(['pay-after-clear']);
    expect(await reloadedKeys(storage.data)).toEqual(['pay-after-clear']);
    expect(calls.map((call) => call.context.key)).toEqual(['pay-after-clear']);
  });
});

describe('finding 8: flush() tells listeners about the items it changed', () => {
  async function waitingItem() {
    let online = true;
    const h = harness({ isOnline: () => online });
    await h.queue.start();
    await h.queue.enqueue({ payload: 1, key: 'k' });
    await h.tick();
    h.calls[0].reject(new Error('timeout'));
    await h.tick();
    online = false;
    expect(h.queue.getItems()[0].nextAttemptAt).toBeGreaterThan(h.clock.now);
    return h;
  }

  it('emits updated for every item made due', async () => {
    const { queue, events, clock } = await waitingItem();
    events.length = 0;
    await queue.flush();
    expect(events.map((event) => event.type)).toEqual(['updated']);
    expect(queue.getItems()[0].nextAttemptAt).toBe(clock.now);
    await queue.stop();
  });

  it('re-renders useQueueItems', async () => {
    const { queue, clock } = await waitingItem();
    let rendered: number | undefined;
    function Probe() {
      const { items } = useQueueItems(queue);
      rendered = items[0].nextAttemptAt - clock.now;
      return null;
    }
    await act(async () => {
      TestRenderer.create(React.createElement(Probe));
    });
    expect(rendered).toBeGreaterThan(0);
    await act(async () => {
      await queue.flush();
    });
    expect(rendered).toBe(0);
    await queue.stop();
  });
});

describe('finding 9: fetchSender accepts every kind of headers', () => {
  const ok = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' });
  const context = { key: 'k', attempt: 1 };
  const item = { key: 'k', payload: { a: 1 } } as QueueItem;

  it.each([
    ['a Headers instance', () => new Headers({ Authorization: 'Bearer T', 'Idempotency-Key': 'stale' })],
    ['an array of pairs', () => [['Authorization', 'Bearer T'], ['Idempotency-Key', 'stale']]],
    ['a plain object', () => ({ Authorization: 'Bearer T', 'Idempotency-Key': 'stale' })],
  ])('keeps Authorization from %s and never lets it replace the key', async (_name, make) => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(ok);
    const send = fetchSender('https://x/pay', { headers: make() as never }, { fetch });
    await send(item, context);
    const sent = fetch.mock.calls[0][1].headers as Record<string, string>;
    const lower: Record<string, string> = {};
    Object.keys(sent).forEach((name) => (lower[name.toLowerCase()] = sent[name]));
    expect(lower).toEqual({ authorization: 'Bearer T', 'idempotency-key': 'k', 'content-type': 'application/json' });
  });

  it('sees a content type given in a Headers instance', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(ok);
    const send = fetchSender('https://x', { headers: new Headers({ 'Content-Type': 'text/csv' }) as never }, { fetch });
    await send(item, context);
    const sent = fetch.mock.calls[0][1].headers as Record<string, string>;
    expect(Object.keys(sent).filter((name) => name.toLowerCase() === 'content-type')).toHaveLength(1);
    expect(Object.values(sent)).toContain('text/csv');
  });
});

describe('finding 10: start() forgets the offline state of the previous run', () => {
  it('sends after stop() and start() when only subscribeToConnectivity is given', async () => {
    let listener: ((online: boolean) => void) | undefined;
    const { queue, calls, tick } = harness({
      subscribeToConnectivity: (l) => {
        listener = l;
        return () => (listener = undefined);
      },
    });
    await queue.start();
    listener!(false);
    await queue.stop();
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['k']);
  });
});

describe('finding 11: HTTP 409 is retryable', () => {
  it('classifies 409 as retryable and honours its Retry-After', () => {
    expect(defaultClassifyError(new HttpError(409), { now: 0 })).toEqual({ type: 'retryable' });
    expect(defaultClassifyError(new HttpError(409, undefined, { 'Retry-After': '2' }), { now: 0 })).toEqual({
      type: 'rateLimited',
      delayMs: 2000,
    });
  });

  it('retries a 409 "still processing" with the same key until it succeeds', async () => {
    const { queue, calls, clock, tick } = harness();
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'pay-1' });
    await tick();
    calls[0].reject(new HttpError(409, 'Conflict', { 'Retry-After': '1' }));
    await tick();
    expect(statuses(queue.getItems())).toEqual(['pay-1:pending']);
    await clock.advance(1000);
    expect(calls.map((call) => call.context.key)).toEqual(['pay-1', 'pay-1']);
    calls[1].resolve('charged');
    await tick();
    expect(statuses(queue.getItems())).toEqual(['pay-1:succeeded']);
  });
});

describe('finding 12: a failed or dead item holds back later items of its group', () => {
  it('does not send past a dead head, and keeps order after retry()', async () => {
    const { queue, calls, tick } = harness();
    await queue.start();
    const a = await queue.enqueue({ payload: 1, key: 'a', group: 'g' });
    await queue.enqueue({ payload: 2, key: 'b', group: 'g' });
    await queue.enqueue({ payload: 3, key: 'c' });
    await tick();
    calls[0].reject(new HttpError(400));
    await tick();
    calls[1].resolve('ok');
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['a', 'c']);
    expect(statuses(queue.getItems())).toEqual(['a:dead', 'b:pending', 'c:succeeded']);
    await queue.retry(a.id);
    await tick();
    calls[2].resolve('ok');
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['a', 'c', 'a', 'b']);
  });

  it('does not send past a failed head until it is discarded', async () => {
    const { queue, calls, tick } = harness({ retry: { maxAttempts: 1 } });
    await queue.start();
    const a = await queue.enqueue({ payload: 1, key: 'a', group: 'g' });
    await queue.enqueue({ payload: 2, key: 'b', group: 'g' });
    await tick();
    calls[0].reject(new HttpError(500));
    await tick();
    expect(statuses(queue.getItems())).toEqual(['a:failed', 'b:pending']);
    expect(calls).toHaveLength(1);
    await queue.discard(a.id);
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['a', 'b']);
  });
});

describe('finding 13: a send that never settles times out and cannot block stop()', () => {
  it('aborts the attempt after attemptTimeoutMs (default 30 s), retries it, and stop() resolves', async () => {
    const { queue, calls, clock, tick } = harness();
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    const { signal } = calls[0].context as SendContext & { signal?: { aborted: boolean } };
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    await clock.advance(29999);
    expect(queue.getItems()[0].status).toBe('inflight');
    await clock.advance(1);
    expect(signal!.aborted).toBe(true);
    const [item] = queue.getItems();
    expect(item).toMatchObject({ status: 'pending', attempts: 1, lastError: { kind: 'retryable' } });
    expect(item.lastError!.message).toMatch(/timed out after 30000 ms/);
    let stopped = false;
    void queue.stop().then(() => (stopped = true));
    await tick();
    expect(stopped).toBe(true);
  });

  it('reports a timeout as an AttemptTimeoutError and keeps the key blocked until the request settles', async () => {
    const { queue, calls, clock, events, tick } = harness({ attemptTimeoutMs: 1000 });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    await clock.advance(1000);
    const scheduled = events.find((event) => event.type === 'retry-scheduled') as { error: unknown } | undefined;
    expect(scheduled && scheduled.error).toBeInstanceOf(AttemptTimeoutError);
    // The first request ignores the signal: no second request with the key until it settles.
    await clock.advance(60000);
    expect(calls).toHaveLength(1);
    calls[0].reject(new Error('aborted late'));
    await clock.advance(10000);
    expect(calls.map((call) => call.context.key)).toEqual(['k', 'k']);
  });

  it('fetchSender passes the attempt signal to fetch', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
    }));
    const signal = new AbortController().signal;
    await fetchSender('https://x', undefined, { fetch })({ key: 'k', payload: 1 } as QueueItem, {
      key: 'k',
      attempt: 1,
      signal,
    } as SendContext);
    expect(fetch.mock.calls[0][1].signal).toBe(signal);
  });
});

describe('finding 14: the stored state stays within a size limit', () => {
  it('refuses to enqueue past maxStorageBytes, warns, and keeps what was stored', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = createMemoryStorage();
    const { queue } = harness({ maxStorageBytes: 2000 }, storage);
    await queue.enqueue({ payload: 'small', key: 'a' });
    const error = await queue.enqueue({ payload: 'x'.repeat(3000), key: 'b' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(QueueFullError);
    expect(warn).toHaveBeenCalled();
    expect(keys(queue.getItems())).toEqual(['a']);
    expect(await reloadedKeys(storage.data)).toEqual(['a']);
    storage.data.forEach((value) => expect(value.length).toBeLessThanOrEqual(2000));
    warn.mockRestore();
  });

  it('caps the quarantine at the same limit', async () => {
    const storage = createMemoryStorage({ [`${PREFIX}:a`]: 'x'.repeat(5000), [`${PREFIX}:b`]: 'y'.repeat(5000) });
    const { queue } = harness({ maxStorageBytes: 2000 }, storage);
    await queue.load();
    const raw = storage.data.get(`${PREFIX}:quarantine`)!;
    expect(raw.length).toBeLessThanOrEqual(2000);
    const entries = await readQuarantine(storage);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[entries.length - 1]).toMatchObject({ storageKey: `${PREFIX}:b`, truncated: true });
  });

  it('prunes failed and dead items older than a given age on request', async () => {
    const storage = createMemoryStorage();
    const { queue, calls, clock, tick } = harness({ retry: { maxAttempts: 1 } }, storage);
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'failed' });
    await queue.enqueue({ payload: 2, key: 'dead' });
    await queue.enqueue({ payload: 3, key: 'waiting', group: 'x' });
    await tick();
    calls[0].reject(new HttpError(500));
    await tick();
    calls[1].reject(new HttpError(400));
    await tick();
    expect(statuses(queue.getItems()).slice(0, 2)).toEqual(['failed:failed', 'dead:dead']);
    await clock.advance(500);
    expect(await queue.pruneFailed({ olderThanMs: 1000 })).toBe(0);
    await clock.advance(500);
    expect(await queue.pruneFailed({ olderThanMs: 1000 })).toBe(2);
    expect(keys(queue.getItems())).toEqual(['waiting']);
    expect(await reloadedKeys(storage.data)).toEqual(['waiting']);
  });
});
