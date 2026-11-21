import { HttpError } from '../classify';
import { encodeEnvelope } from '../persistence';
import { createIdempotentQueue } from '../queue';
import { createMemoryStorage, type MemoryStorage } from '../storage';
import type { QueueEvent, QueueItem, QueueOptions, QueueStorage, SendContext } from '../types';
import { FakeClock, flushMicrotasks } from './support/fakeClock';

type Call = {
  item: QueueItem<unknown>;
  context: SendContext;
  resolve(value?: unknown): void;
  reject(error: unknown): void;
};

/** A queue whose sends wait until the test answers them. */
function harness(overrides: Partial<QueueOptions> = {}, storage: MemoryStorage = createMemoryStorage()) {
  const clock = new FakeClock();
  const calls: Call[] = [];
  const open = new Set<Call>();
  const events: QueueEvent[] = [];
  let ids = 0;
  const queue = createIdempotentQueue({
    storage,
    send: (item, context) =>
      new Promise((resolve, reject) => {
        const call: Call = {
          item,
          context,
          resolve: (value) => {
            open.delete(call);
            resolve(value);
          },
          reject: (error) => {
            open.delete(call);
            reject(error);
          },
        };
        calls.push(call);
        open.add(call);
      }),
    now: () => clock.now,
    random: () => 0.5,
    timers: clock.timersFor('app'),
    generateKey: () => `generated-${++ids}`,
    retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 },
    ...overrides,
  });
  queue.subscribe((event) => events.push(event));
  const tick = () => clock.advance(0);
  return { clock, calls, open, events, queue, storage, tick };
}

const statuses = (items: readonly QueueItem[]) => items.map((item) => `${item.key}:${item.status}`);

describe('enqueue', () => {
  it('persists the item before resolving', async () => {
    const memory = createMemoryStorage();
    let release!: () => void;
    const storage: QueueStorage = {
      ...memory,
      setItem: (key, value) =>
        new Promise<void>((resolve) => {
          release = () => {
            memory.data.set(key, value);
            resolve();
          };
        }),
    };
    const queue = createIdempotentQueue({ storage, send: () => undefined });
    let resolved = false;
    const promise = queue.enqueue({ payload: { amount: 1 }, key: 'k1' }).then((item) => {
      resolved = true;
      return item;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false);
    release();
    const item = await promise;
    expect(item).toMatchObject({ key: 'k1', status: 'pending', attempts: 0, payload: { amount: 1 } });
    expect(Array.from(memory.data.values()).some((raw) => raw.includes('k1'))).toBe(true);
  });

  it('does not send an item before it is saved', async () => {
    const memory = createMemoryStorage();
    const waiting: Array<() => void> = [];
    const storage: QueueStorage = {
      ...memory,
      setItem: (key, value) =>
        new Promise<void>((resolve) => {
          waiting.push(() => {
            memory.data.set(key, value);
            resolve();
          });
        }),
    };
    const { queue, calls, tick } = harness({ storage });
    await queue.start();
    void queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    expect(calls).toHaveLength(0);
    waiting.shift()!(); // the enqueue write lands
    await tick();
    // The attempt is recorded before the request leaves.
    expect(calls).toHaveLength(0);
    expect(waiting).toHaveLength(1);
    waiting.shift()!();
    await tick();
    expect(calls).toHaveLength(1);
  });

  it('rejects and keeps nothing when the item cannot be saved', async () => {
    const storage = createMemoryStorage();
    storage.setItem = () => Promise.reject(new Error('disk full'));
    const { queue } = harness({}, storage);
    await expect(queue.enqueue({ payload: 1, key: 'k' })).rejects.toThrow('disk full');
    expect(queue.getItems()).toEqual([]);
  });

  it('deduplicates by key, including concurrent enqueues', async () => {
    const { queue, calls, tick } = harness();
    await queue.start();
    const [a, b] = await Promise.all([
      queue.enqueue({ payload: { amount: 1 }, key: 'pay-1' }),
      queue.enqueue({ payload: { amount: 999 }, key: 'pay-1' }),
    ]);
    expect(b.id).toBe(a.id);
    expect(b.payload).toEqual({ amount: 1 });
    await tick();
    const again = await queue.enqueue({ payload: { amount: 2 }, key: 'pay-1' });
    expect(again.id).toBe(a.id);
    expect(queue.getItems()).toHaveLength(1);
    expect(calls).toHaveLength(1);
    calls[0].resolve('ok');
    await tick();
    // A succeeded item still deduplicates until it is pruned.
    expect((await queue.enqueue({ payload: 3, key: 'pay-1' })).status).toBe('succeeded');
    expect(calls).toHaveLength(1);
  });

  it('creates one item when a duplicate enqueue outlives a discard of the first', async () => {
    // Found by property 2: the duplicate waited for the first write, the first item was
    // discarded and re-enqueued meanwhile, and the duplicate then added a second item.
    const memory = createMemoryStorage();
    const waiting: Array<() => void> = [];
    const storage: QueueStorage = {
      ...memory,
      setItem: (key, value) =>
        new Promise<void>((resolve) =>
          waiting.push(() => {
            memory.data.set(key, value);
            resolve();
          }),
        ),
    };
    const { queue, calls, open, tick } = harness({ storage, concurrency: 2 });
    await queue.start();
    void queue.enqueue({ payload: 1, key: 'k' });
    const duplicate = queue.enqueue({ payload: 2, key: 'k' });
    await tick();
    const first = queue.getItems()[0];
    void queue.discard(first.id);
    await tick();
    void queue.enqueue({ payload: 3, key: 'k' });
    while (waiting.length > 0) {
      waiting.shift()!();
      await tick();
    }
    const items = queue.getItems().filter((item) => item.key === 'k');
    expect(items).toHaveLength(1);
    expect((await duplicate).id).toBe(items[0].id);
    expect(open.size).toBeLessThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(1);
  });

  it('deduplicates against items loaded from storage', async () => {
    const storage = createMemoryStorage();
    const first = harness({}, storage);
    await first.queue.enqueue({ payload: 1, key: 'k' });
    const second = harness({}, storage);
    const item = await second.queue.enqueue({ payload: 2, key: 'k' });
    expect(item.payload).toBe(1);
    expect(second.queue.getItems()).toHaveLength(1);
  });

  it('generates a key when none is given and copies the payload', async () => {
    const { queue } = harness();
    const payload = { nested: { value: 1 } };
    const item = await queue.enqueue({ payload, metadata: { screen: 'checkout' } });
    payload.nested.value = 2;
    expect(item.key).toMatch(/^generated-/);
    expect(item.payload).toEqual({ nested: { value: 1 } });
    expect(item.metadata).toEqual({ screen: 'checkout' });
    expect(queue.keySource).toBe('custom');
  });

  it('validates its input', async () => {
    const { queue } = harness();
    await expect(queue.enqueue({ payload: 1, key: '' })).rejects.toThrow(TypeError);
    await expect(queue.enqueue({ payload: 1, key: 'x'.repeat(256) })).rejects.toThrow(TypeError);
    await expect(queue.enqueue({ payload: 1, group: '' })).rejects.toThrow(TypeError);
    await expect(queue.enqueue({ payload: () => 1 })).rejects.toThrow(/JSON/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(queue.enqueue({ payload: circular })).rejects.toThrow(/JSON/);
  });
});

describe('sending', () => {
  it('sends the payload with the item key and attempt number, and succeeds', async () => {
    const { queue, calls, events, tick } = harness();
    await queue.start();
    await queue.enqueue({ payload: { amount: 5 }, key: 'k' });
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].item.payload).toEqual({ amount: 5 });
    expect(calls[0].context).toEqual({ key: 'k', attempt: 1 });
    expect(queue.getItems()[0].status).toBe('inflight');
    calls[0].resolve({ id: 'receipt' });
    await tick();
    expect(queue.getItems()[0]).toMatchObject({ status: 'succeeded', attempts: 1, completedAt: 0 });
    expect(events.find((event) => event.type === 'succeeded')).toMatchObject({ result: { id: 'receipt' } });
  });

  it('retries with the same key after exponential backoff with jitter', async () => {
    const { queue, calls, clock, tick } = harness();
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    calls[0].reject(new TypeError('Network request failed'));
    await tick();
    // random() = 0.5, first ceiling 1000 ms.
    expect(queue.getItems()[0]).toMatchObject({ status: 'pending', nextAttemptAt: 500 });
    expect(queue.getItems()[0].lastError).toMatchObject({ kind: 'retryable', message: 'Network request failed' });
    await clock.advance(499);
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].context).toEqual({ key: 'k', attempt: 2 });
    calls[1].reject(new HttpError(503));
    await tick();
    expect(queue.getItems()[0].nextAttemptAt).toBe(500 + 1000);
  });

  it('marks an item failed after maxAttempts retryable errors and retry(id) resets it', async () => {
    const { queue, calls, clock, tick } = harness();
    await queue.start();
    const { id } = await queue.enqueue({ payload: 1, key: 'k' });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await clock.advance(10000);
      expect(calls).toHaveLength(attempt);
      calls[attempt - 1].reject(new HttpError(500));
      await tick();
    }
    await clock.advance(100000);
    expect(calls).toHaveLength(3);
    expect(queue.getItems()[0]).toMatchObject({ status: 'failed', attempts: 3, lastError: { status: 500 } });

    const retried = await queue.retry(id);
    expect(retried).toMatchObject({ status: 'pending', attempts: 0, key: 'k' });
    await tick();
    expect(calls).toHaveLength(4);
    expect(calls[3].context).toEqual({ key: 'k', attempt: 1 });
  });

  it('marks an item dead on a permanent error and never retries it', async () => {
    const { queue, calls, clock, tick } = harness();
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    calls[0].reject(new HttpError(422, 'Unprocessable'));
    await tick();
    await clock.advance(1000000);
    await queue.flush();
    expect(calls).toHaveLength(1);
    expect(queue.getItems()[0]).toMatchObject({
      status: 'dead',
      lastError: { kind: 'permanent', status: 422, message: 'Unprocessable' },
    });
  });

  it('waits for Retry-After, even when flushed', async () => {
    const { queue, calls, clock, tick } = harness();
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    calls[0].reject(new HttpError(429, undefined, { 'Retry-After': '5' }));
    await tick();
    expect(queue.getItems()[0]).toMatchObject({ nextAttemptAt: 5000, lastError: { kind: 'rateLimited' } });
    await queue.flush();
    expect(calls).toHaveLength(1);
    await clock.advance(4999);
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    expect(calls).toHaveLength(2);
  });

  it('flush makes backoff waits due now and resolves when idle', async () => {
    const { queue, calls, tick } = harness();
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    calls[0].reject(new HttpError(500));
    await tick();
    let flushed = false;
    void queue.flush().then(() => (flushed = true));
    await tick();
    expect(calls).toHaveLength(2);
    expect(flushed).toBe(false);
    calls[1].resolve();
    await tick();
    expect(flushed).toBe(true);
  });

  it('uses a custom classifier and treats a throwing classifier as retryable', async () => {
    const classifyError = jest
      .fn()
      .mockReturnValueOnce({ type: 'retryable', delayMs: 42 })
      .mockImplementationOnce(() => {
        throw new Error('bug');
      })
      .mockReturnValueOnce({ type: 'permanent' });
    const { queue, calls, clock, tick } = harness({ classifyError, retry: { maxAttempts: 10 } });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    calls[0].reject('first');
    await tick();
    expect(queue.getItems()[0].nextAttemptAt).toBe(42);
    expect(classifyError.mock.calls[0][1]).toMatchObject({ attempt: 1, now: 0 });
    await clock.advance(42);
    calls[1].reject('second');
    await tick();
    expect(queue.getItems()[0].status).toBe('pending');
    await clock.advance(10000);
    calls[2].reject('third');
    await tick();
    expect(queue.getItems()[0].status).toBe('dead');
  });
});

describe('ordering and concurrency', () => {
  it('sends one item at a time by default, in enqueue order', async () => {
    const { queue, calls, tick } = harness();
    await queue.start();
    for (const key of ['a', 'b', 'c']) await queue.enqueue({ payload: key, key });
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['a']);
    calls[0].resolve();
    await tick();
    calls[1].resolve();
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['a', 'b', 'c']);
  });

  it('never exceeds the concurrency limit', async () => {
    const { queue, calls, open, tick } = harness({ concurrency: 3 });
    await queue.start();
    for (let i = 0; i < 8; i++) await queue.enqueue({ payload: i, key: `k${i}` });
    await tick();
    expect(open.size).toBe(3);
    calls[1].resolve();
    await tick();
    expect(open.size).toBe(3);
    expect(calls.map((call) => call.context.key)).toEqual(['k0', 'k1', 'k2', 'k3']);
    while (open.size > 0) {
      Array.from(open)[0].resolve();
      await tick();
      expect(open.size).toBeLessThanOrEqual(3);
    }
    expect(calls).toHaveLength(8);
  });

  it('keeps a group sequential and in order while other groups run in parallel', async () => {
    const { queue, calls, open, clock, tick } = harness({ concurrency: 4 });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'acct-1', group: 'account' });
    await queue.enqueue({ payload: 2, key: 'acct-2', group: 'account' });
    await queue.enqueue({ payload: 3, key: 'other', group: 'cart' });
    await queue.enqueue({ payload: 4, key: 'acct-3', group: 'account' });
    await queue.enqueue({ payload: 5, key: 'free' });
    await tick();
    expect(Array.from(open).map((call) => call.context.key).sort()).toEqual(['acct-1', 'free', 'other']);

    // A failed head of the group holds the rest of the group back.
    calls[0].reject(new HttpError(500));
    await tick();
    expect(Array.from(open).map((call) => call.context.key).sort()).toEqual(['free', 'other']);
    await clock.advance(10000);
    const retry = calls[calls.length - 1];
    expect(retry.context).toEqual({ key: 'acct-1', attempt: 2 });
    retry.resolve();
    await tick();
    expect(calls[calls.length - 1].context.key).toBe('acct-2');
    calls[calls.length - 1].resolve();
    await tick();
    expect(calls[calls.length - 1].context.key).toBe('acct-3');
  });

  it('lets a group continue after its head is dead', async () => {
    const { queue, calls, tick } = harness();
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'a', group: 'g' });
    await queue.enqueue({ payload: 2, key: 'b', group: 'g' });
    await tick();
    calls[0].reject(new HttpError(400));
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['a', 'b']);
  });
});

describe('start, stop and recovery', () => {
  it('sends nothing before start or after stop, and resumes on start', async () => {
    const { queue, calls, tick } = harness();
    await queue.enqueue({ payload: 1, key: 'a' });
    await tick();
    expect(calls).toHaveLength(0);
    await queue.start();
    await tick();
    expect(calls).toHaveLength(1);

    await queue.enqueue({ payload: 2, key: 'b' });
    let stopped = false;
    const stopping = queue.stop().then(() => (stopped = true));
    await tick();
    // stop waits for the attempt in flight.
    expect(stopped).toBe(false);
    calls[0].resolve();
    await stopping;
    await tick();
    expect(calls).toHaveLength(1);
    expect(statuses(queue.getItems())).toEqual(['a:succeeded', 'b:pending']);

    await queue.flush(); // does nothing while stopped
    expect(calls).toHaveLength(1);
    await queue.start();
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['a', 'b']);
  });

  it('returns an item left inflight by a crash to pending and retries it with the same key', async () => {
    const storage = createMemoryStorage();
    const first = harness({}, storage);
    await first.queue.start();
    await first.queue.enqueue({ payload: 1, key: 'pay-1' });
    await first.tick();
    expect(first.calls).toHaveLength(1);
    expect(first.queue.getItems()[0].status).toBe('inflight');
    // The app is killed here: first.calls[0] never answers.

    const second = harness({}, storage);
    await second.queue.load();
    expect(second.queue.getItems()[0]).toMatchObject({ status: 'pending', attempts: 1, key: 'pay-1' });
    await second.queue.start();
    await second.tick();
    expect(second.calls[0].context).toEqual({ key: 'pay-1', attempt: 2 });
  });

  it('marks an item interrupted on its last allowed attempt as failed', async () => {
    const storage = createMemoryStorage();
    const first = harness({ retry: { maxAttempts: 1 } }, storage);
    await first.queue.start();
    await first.queue.enqueue({ payload: 1, key: 'k' });
    await first.tick();
    const second = harness({ retry: { maxAttempts: 1 } }, storage);
    await second.queue.start();
    await second.tick();
    expect(second.calls).toHaveLength(0);
    expect(second.queue.getItems()[0]).toMatchObject({ status: 'failed', lastError: { kind: 'interrupted' } });
  });

  it('does not send when the attempt cannot be recorded first', async () => {
    const storage = createMemoryStorage();
    const { queue, calls, events, tick } = harness({}, storage);
    await queue.enqueue({ payload: 1, key: 'k' });
    storage.setItem = () => Promise.reject(new Error('disk full'));
    await queue.start();
    await tick();
    expect(calls).toHaveLength(0);
    expect(queue.getItems()[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(events.some((event) => event.type === 'storage-error')).toBe(true);
  });

  it('quarantines corrupted storage and still starts', async () => {
    const storage = createMemoryStorage({ 'react-native-idempotent-queue:a': '{"truncated' });
    const { queue, events } = harness({}, storage);
    await queue.start();
    expect(queue.getItems()).toEqual([]);
    expect(events.find((event) => event.type === 'quarantined')).toMatchObject({ reason: 'envelope is not valid JSON' });
    await queue.enqueue({ payload: 1, key: 'k' });
    expect(storage.data.get('react-native-idempotent-queue:quarantine')).toContain('truncated');
  });

  it('rejects start when storage cannot be read, and can start again later', async () => {
    const storage = createMemoryStorage();
    const getItem = storage.getItem;
    storage.getItem = () => Promise.reject(new Error('locked'));
    const { queue } = harness({}, storage);
    await expect(queue.start()).rejects.toThrow('locked');
    expect(queue.isRunning()).toBe(false);
    storage.getItem = getItem;
    await queue.start();
    expect(queue.isRunning()).toBe(true);
  });

  it('keeps enqueue order across restarts', async () => {
    const storage = createMemoryStorage();
    const first = harness({}, storage);
    await first.queue.enqueue({ payload: 1, key: 'a' });
    await first.queue.enqueue({ payload: 2, key: 'b' });
    const second = harness({}, storage);
    const c = await second.queue.enqueue({ payload: 3, key: 'c' });
    expect(c.sequence).toBe(3);
    expect(second.queue.getItems().map((item) => item.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('long waits', () => {
  it('splits waits longer than a minute into one-minute timers', async () => {
    const delays: number[] = [];
    const clock = new FakeClock();
    const timers = clock.timersFor('app');
    const calls: number[] = [];
    let fail = true;
    const queue = createIdempotentQueue({
      storage: createMemoryStorage(),
      send: () => {
        calls.push(clock.now);
        if (fail) {
          fail = false;
          return Promise.reject(new HttpError(503, undefined, { 'Retry-After': '150' }));
        }
        return 'ok';
      },
      now: () => clock.now,
      timers: {
        setTimeout: (callback, ms) => {
          delays.push(ms);
          return timers.setTimeout(callback, ms);
        },
        clearTimeout: timers.clearTimeout,
      },
    });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await clock.advance(200000);
    expect(calls).toEqual([0, 150000]);
    expect(delays).toEqual([60000, 60000, 30000]);
    await queue.stop();
  });
});

describe('connectivity', () => {
  it('waits while offline without using attempts and resumes on reconnect', async () => {
    let online = false;
    let notify: (online: boolean) => void = () => undefined;
    const { queue, calls, clock, tick } = harness({
      isOnline: () => online,
      subscribeToConnectivity: (listener) => {
        notify = listener;
        return () => undefined;
      },
    });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await clock.advance(60000);
    expect(calls).toHaveLength(0);
    expect(queue.getItems()[0].attempts).toBe(0);
    online = true;
    notify(true);
    await tick();
    expect(calls).toHaveLength(1);
  });

  it('checks isOnline again every offlineRecheckMs without a subscription', async () => {
    let online = false;
    const isOnline = jest.fn(async () => online);
    const { queue, calls, clock, tick } = harness({ isOnline, offlineRecheckMs: 1000 });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    online = true;
    await clock.advance(999);
    expect(calls).toHaveLength(0);
    await clock.advance(1);
    expect(calls).toHaveLength(1);
  });

  it('treats a throwing isOnline as online', async () => {
    const { queue, calls, tick } = harness({
      isOnline: () => {
        throw new Error('unknown');
      },
    });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    expect(calls).toHaveLength(1);
  });
});

describe('discard, clear and prune', () => {
  it('discards an item in flight, ignores its result and keeps its key blocked until it settles', async () => {
    const { queue, calls, tick } = harness({ concurrency: 2 });
    await queue.start();
    const { id } = await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    expect(await queue.discard(id)).toBe(true);
    expect(queue.getItems()).toEqual([]);
    await queue.enqueue({ payload: 2, key: 'k' });
    await tick();
    expect(calls).toHaveLength(1);
    calls[0].resolve();
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].item.payload).toBe(2);
    expect(await queue.discard('missing')).toBe(false);
  });

  it('clear waits for attempts in flight, then removes everything', async () => {
    const storage = createMemoryStorage({ 'react-native-idempotent-queue:quarantine': '[]' });
    const { queue, calls, tick } = harness({}, storage);
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    const clearing = queue.clear();
    await tick();
    calls[0].resolve();
    await clearing;
    expect(queue.getItems()).toEqual([]);
    expect(Array.from(storage.data.keys())).toEqual([]);
    expect(queue.isRunning()).toBe(true);
  });

  it('prunes succeeded items after keepSucceededMs', async () => {
    const { queue, calls, clock, tick, storage } = harness({ keepSucceededMs: 60000 });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'old' });
    await tick();
    calls[0].resolve();
    await tick();
    await clock.advance(30000);
    await queue.enqueue({ payload: 2, key: 'new' });
    await tick();
    calls[1].resolve();
    await tick();
    await clock.advance(29999);
    await queue.flush();
    expect(statuses(queue.getItems())).toEqual(['old:succeeded', 'new:succeeded']);
    await clock.advance(1);
    // An idle queue keeps no timer; pruning happens at the next activity.
    expect(clock.pending()).toBe(0);
    await queue.flush();
    expect(statuses(queue.getItems())).toEqual(['new:succeeded']);
    const reloaded = harness({ keepSucceededMs: 60000 }, storage);
    await reloaded.queue.load();
    expect(statuses(reloaded.queue.getItems())).toEqual(['new:succeeded']);
    await clock.advance(30000);
    await queue.stop();
    await queue.start();
    expect(queue.getItems()).toEqual([]);
    // After pruning, the key is new again.
    await queue.enqueue({ payload: 3, key: 'old' });
    await tick();
    expect(calls).toHaveLength(3);
  });

  it('never prunes failed or dead items', async () => {
    const { queue, calls, clock, tick } = harness({ keepSucceededMs: 0, retry: { maxAttempts: 1 } });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'a' });
    await queue.enqueue({ payload: 2, key: 'b' });
    await tick();
    calls[0].reject(new HttpError(500));
    await tick();
    calls[1].reject(new HttpError(400));
    await clock.advance(1e9);
    expect(statuses(queue.getItems())).toEqual(['a:failed', 'b:dead']);
  });
});

describe('events and snapshots', () => {
  it('replaces the items array on change and reuses it otherwise', async () => {
    const { queue, tick } = harness();
    const before = queue.getItems();
    expect(queue.getItems()).toBe(before);
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    expect(queue.getItems()).not.toBe(before);
    expect(Object.isFrozen(queue.getItems())).toBe(true);
  });

  it('keeps going when a listener throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { queue, calls, tick } = harness();
    const unsubscribe = queue.subscribe(() => {
      throw new Error('listener bug');
    });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    unsubscribe();
    warn.mockRestore();
  });

  it('emits the lifecycle of an item', async () => {
    const { queue, calls, events, tick } = harness();
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    calls[0].reject(new HttpError(500));
    await tick();
    void queue.flush();
    await tick();
    calls[1].resolve('done');
    await tick();
    expect(events.map((event) => event.type)).toEqual([
      'loaded',
      'enqueued',
      'attempt',
      'retry-scheduled',
      'attempt',
      'succeeded',
    ]);
  });

  it('rejects invalid options', () => {
    const storage = createMemoryStorage();
    expect(() => createIdempotentQueue({ storage, send: undefined as never })).toThrow(TypeError);
    expect(() => createIdempotentQueue({ storage: {} as never, send: () => 1 })).toThrow(TypeError);
    expect(() => createIdempotentQueue({ storage, send: () => 1, concurrency: 0 })).toThrow(TypeError);
    expect(() => createIdempotentQueue({ storage, send: () => 1, concurrency: 1.5 })).toThrow(TypeError);
    expect(() => createIdempotentQueue({ storage, send: () => 1, retry: { maxAttempts: 0 } })).toThrow(TypeError);
  });

  it('uses the global timers by default', async () => {
    jest.useFakeTimers();
    try {
      let now = 0;
      const send = jest.fn().mockRejectedValueOnce(new HttpError(500)).mockResolvedValue('ok');
      const queue = createIdempotentQueue({
        storage: createMemoryStorage(),
        send,
        now: () => now,
        random: () => 0.5,
        retry: { baseDelayMs: 1000 },
      });
      await queue.start();
      await queue.enqueue({ payload: 1, key: 'k' });
      await flushMicrotasks();
      expect(send).toHaveBeenCalledTimes(1);
      now = 500;
      jest.advanceTimersByTime(500);
      await flushMicrotasks();
      expect(send).toHaveBeenCalledTimes(2);
      await flushMicrotasks();
      expect(queue.getItems()[0].status).toBe('succeeded');
      await queue.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads storage that holds an envelope written by an earlier version of the app', async () => {
    const stored: QueueItem = {
      id: 'i1',
      key: 'k',
      payload: { amount: 1 },
      status: 'pending',
      attempts: 0,
      sequence: 4,
      createdAt: 0,
      updatedAt: 0,
      nextAttemptAt: 0,
    };
    const storage = createMemoryStorage({ 'react-native-idempotent-queue:b': encodeEnvelope([stored], 9) });
    const { queue } = harness({}, storage);
    await queue.load();
    expect(queue.getItems()).toEqual([stored]);
  });
});
