import fc from 'fast-check';
import { defaultClassifyError, HttpError } from '../classify';
import { decodeEnvelope, QueuePersistence } from '../persistence';
import { createIdempotentQueue } from '../queue';
import { createMemoryStorage } from '../storage';
import type { IdempotentQueue, QueueItem, QueueStorage } from '../types';
import { FakeClock } from './support/fakeClock';
import { World, type Fault, type Payload, type WorldConfig } from './support/world';

/*
 * Property tests against a fake server that deduplicates by idempotency key.
 * Time is a fake clock; every timer, storage write and response runs on it.
 * Set NUM_RUNS to run more cases (default 120 per property).
 */
declare const process: { env: Record<string, string | undefined> };
const NUM_RUNS = Number(process.env.NUM_RUNS || 120);

/**
 * Counts of the interesting situations the generated cases reached. Each
 * property asserts its counters are non-zero, so a generator change that stops
 * producing crashes mid-flight (for example) fails loudly instead of passing.
 */
function coverage<K extends string>(...names: K[]) {
  const counts = {} as Record<K, number>;
  names.forEach((name) => (counts[name] = 0));
  return {
    counts,
    hit(name: K, condition = true) {
      if (condition) counts[name]++;
    },
    expectAllReached() {
      if (process.env.SHOW_COVERAGE) console.warn(JSON.stringify(counts));
      names.forEach((name) => expect({ [name]: counts[name] > 0 }).toEqual({ [name]: true }));
    },
  };
}
const KEYS = 6;
const keyName = (n: number) => `key-${n}`;
const groupOf = (n: number) => (n % 3 === 0 ? undefined : `group-${n % 3}`);

type Op =
  | { t: 'enqueue'; key: number }
  | { t: 'crash' }
  | { t: 'offline' }
  | { t: 'online' }
  | { t: 'advance'; ms: number }
  | { t: 'flush' }
  | { t: 'stop' }
  | { t: 'start' }
  | { t: 'discard'; index: number }
  | { t: 'retry'; index: number }
  | { t: 'resubmit'; index: number };

const enqueueOf = (keys: number) =>
  fc.record({ t: fc.constant('enqueue' as const), key: fc.integer({ min: 0, max: keys - 1 }) });
const enqueueOp = enqueueOf(KEYS);
const advanceOp = fc.record({ t: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 400 }) });
const simple = (t: 'crash' | 'offline' | 'online' | 'flush' | 'stop' | 'start') => fc.constant({ t } as Op);
const indexOp = (t: 'discard' | 'retry' | 'resubmit') =>
  fc.record({ t: fc.constant(t), index: fc.integer({ min: 0, max: 9 }) }) as fc.Arbitrary<Op>;

const networkFault = fc.constantFrom<Fault>('ok', 'ok', 'lostRequest', 'lostResponse', 'http500', 'http429');
const anyFault = fc.constantFrom<Fault>('ok', 'lostRequest', 'lostResponse', 'http500', 'http429', 'http400');

const worldConfig = (faults: fc.Arbitrary<Fault>, maxAttempts: fc.Arbitrary<number>, minSendLatency = 1) =>
  fc.record<WorldConfig>({
    concurrency: fc.integer({ min: 1, max: 3 }),
    storageLatency: fc.integer({ min: 0, max: 3 }),
    sendLatency: fc.integer({ min: minSendLatency, max: 40 }),
    useSubscription: fc.boolean(),
    seed: fc.integer(),
    retry: maxAttempts.map((value) => ({ maxAttempts: value, baseDelayMs: 20, maxDelayMs: 300 })),
    faults: fc.array(faults, { maxLength: 40 }),
  });

/** Runs every timer until `done()` or a generous simulated deadline. */
async function settle(world: World, done: () => boolean): Promise<void> {
  for (let i = 0; i < 3000 && !done(); i++) await world.clock.advance(50);
}

function enqueue(world: World, key: number, n: number, confirmed?: Set<string>) {
  const name = keyName(key);
  const group = groupOf(key);
  world.process.queue
    .enqueue({ payload: { key: name, n }, key: name, ...(group ? { group } : {}) })
    .then(
      () => confirmed && confirmed.add(name),
      () => undefined,
    );
}

describe('property 1: every enqueued key is applied exactly once and ends succeeded', () => {
  it('holds across crashes, offline periods and lost responses', async () => {
    const seen = coverage('resentAfterCrash', 'lostResponse', 'duplicateEnqueue', 'lostToOffline', 'lostUnconfirmedEnqueue');
    await fc.assert(
      fc.asyncProperty(
        worldConfig(networkFault, fc.constant(Infinity)),
        fc.array(
          fc.oneof(
            { weight: 4, arbitrary: enqueueOp },
            { weight: 4, arbitrary: advanceOp },
            { weight: 2, arbitrary: simple('crash') },
            { weight: 1, arbitrary: simple('offline') },
            { weight: 1, arbitrary: simple('online') },
            { weight: 1, arbitrary: simple('flush') },
          ),
          { maxLength: 40, size: 'medium' },
        ),
        async (config, ops) => {
          const world = new World(config);
          void world.process.queue.start();
          /** Keys the app asked for, and the payload it used first. */
          const requested = new Map<string, number>();
          const confirmed = new Set<string>();
          let n = 0;
          for (const op of ops) {
            if (op.t === 'enqueue') {
              const name = keyName(op.key);
              seen.hit('duplicateEnqueue', requested.has(name));
              if (!requested.has(name)) requested.set(name, n);
              enqueue(world, op.key, n++, confirmed);
            } else if (op.t === 'crash') {
              seen.hit('lostUnconfirmedEnqueue', Array.from(requested.keys()).some((key) => !confirmed.has(key)));
              world.crash();
              void world.process.queue.start();
              // An app re-enqueues, with the same key, anything it was not told was saved.
              requested.forEach((first, name) => {
                if (!confirmed.has(name)) enqueue(world, Number(name.slice(4)), first, confirmed);
              });
            } else if (op.t === 'offline') world.setOnline(false);
            else if (op.t === 'online') world.setOnline(true);
            else if (op.t === 'flush') void world.process.queue.flush();
            else if (op.t === 'advance') await world.clock.advance(op.ms);
            await world.clock.advance(0);
          }

          world.setOnline(true);
          world.stopFaults();
          const allSucceeded = () => {
            const items = world.process.queue.getItems();
            return Array.from(requested.keys()).every(
              (key) => confirmed.has(key) && items.some((item) => item.key === key && item.status === 'succeeded'),
            );
          };
          await settle(world, allSucceeded);

          const items = world.process.queue.getItems();
          for (const key of requested.keys()) {
            expect(confirmed.has(key)).toBe(true);
            expect(world.server.applied.get(key)).toBe(1);
            const matching = items.filter((item) => item.key === key);
            expect(matching).toHaveLength(1);
            expect(matching[0].status).toBe('succeeded');
          }
          expect(items).toHaveLength(requested.size);

          seen.hit('lostResponse', world.sends.some((send) => send.online && send.fault === 'lostResponse'));
          seen.hit('lostToOffline', world.sends.some((send) => send.lostToOffline === true));
          seen.hit(
            'resentAfterCrash',
            Array.from(requested.keys()).some((key) => {
              const processes = new Set(world.sends.filter((send) => send.key === key).map((send) => send.process));
              return processes.size > 1;
            }),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
    seen.expectAllReached();
  });
});

describe('property 2: the same key is never in flight twice at the same time', () => {
  it('holds with concurrency, groups, discards of items in flight and re-enqueues', async () => {
    const seen = coverage('discardInFlight', 'reenqueueWhileOldInFlight', 'parallelDifferentKeys');
    await fc.assert(
      fc.asyncProperty(
        worldConfig(anyFault, fc.integer({ min: 1, max: 5 }), 10),
        fc.array(
          fc.oneof(
            { weight: 4, arbitrary: enqueueOf(3) },
            { weight: 3, arbitrary: advanceOp },
            { weight: 2, arbitrary: indexOp('discard') },
            { weight: 2, arbitrary: indexOp('resubmit') },
            { weight: 1, arbitrary: indexOp('retry') },
            { weight: 1, arbitrary: simple('flush') },
            { weight: 1, arbitrary: simple('offline') },
            { weight: 1, arbitrary: simple('online') },
          ),
          { maxLength: 40, size: 'medium' },
        ),
        async (config, ops) => {
          const world = new World(config);
          const { queue } = world.process;
          void queue.start();
          let n = 0;
          for (const op of ops) {
            const items = queue.getItems();
            if (op.t === 'enqueue') enqueue(world, op.key, n++);
            else if (op.t === 'discard' && items.length > 0) {
              // Prefer items in flight: that is when a re-enqueue could overlap.
              const inflight = items.filter((item) => item.status === 'inflight');
              seen.hit('discardInFlight', inflight.length > 0);
              const pool = inflight.length > 0 ? inflight : items;
              void queue.discard(pool[op.index % pool.length].id);
            } else if (op.t === 'resubmit' && items.length > 0) {
              // Cancel and send again with the same key, as a "try again" button might.
              const inflight = items.filter((item) => item.status === 'inflight');
              const pool = inflight.length > 0 ? inflight : items;
              const item = pool[op.index % pool.length];
              void queue.discard(item.id).then(() => {
                seen.hit('reenqueueWhileOldInFlight', (world.process.inflight.get(item.key) || 0) > 0);
                enqueue(world, Number(item.key.slice(4)), n++);
              });
            } else if (op.t === 'retry' && items.length > 0) {
              queue.retry(items[op.index % items.length].id).catch(() => undefined);
            } else if (op.t === 'flush') void queue.flush();
            else if (op.t === 'offline') world.setOnline(false);
            else if (op.t === 'online') world.setOnline(true);
            else if (op.t === 'advance') await world.clock.advance(op.ms);
            await world.clock.advance(0);
            seen.hit('parallelDifferentKeys', queue.getItems().filter((item) => item.status === 'inflight').length > 1);
          }
          world.setOnline(true);
          await settle(world, () => queue.getItems().every((item) => item.status !== 'inflight' && item.status !== 'pending'));
          expect(world.maxSameKeyInFlight).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
    seen.expectAllReached();
  });
});

describe('property 3: permanent errors are never retried; retryable errors use at most maxAttempts', () => {
  it('holds for any mix of errors, offline periods and stop/start', async () => {
    const seen = coverage('dead', 'failed', 'succeededAfterRetry', 'rateLimited', 'heldBackByGroup');
    await fc.assert(
      fc.asyncProperty(
        worldConfig(anyFault, fc.integer({ min: 1, max: 4 })),
        fc.array(
          fc.oneof(
            { weight: 4, arbitrary: enqueueOp },
            { weight: 4, arbitrary: advanceOp },
            { weight: 1, arbitrary: simple('offline') },
            { weight: 1, arbitrary: simple('online') },
            { weight: 1, arbitrary: simple('flush') },
            { weight: 1, arbitrary: simple('stop') },
            { weight: 1, arbitrary: simple('start') },
          ),
          { maxLength: 40, size: 'medium' },
        ),
        fc.constantFrom<Fault>('ok', 'http500', 'lostResponse'),
        async (config, ops, tail) => {
          // After the scripted faults, every request ends the same way.
          const world = new World({ ...config, faults: config.faults.concat(new Array(200).fill(tail)) });
          const { queue } = world.process;
          const maxAttempts = config.retry!.maxAttempts!;
          void queue.start();
          let n = 0;
          for (const op of ops) {
            if (op.t === 'enqueue') enqueue(world, op.key, n++);
            else if (op.t === 'offline') world.setOnline(false);
            else if (op.t === 'online') world.setOnline(true);
            else if (op.t === 'flush') void queue.flush();
            else if (op.t === 'stop') void queue.stop();
            else if (op.t === 'start') void queue.start();
            else if (op.t === 'advance') await world.clock.advance(op.ms);
            await world.clock.advance(0);
          }
          world.setOnline(true);
          void queue.start();
          const terminal = (item: QueueItem) => item.status !== 'pending' && item.status !== 'inflight';
          // A failed or dead item holds back the later items of its group.
          const heldBack = (item: QueueItem, items: readonly QueueItem[]) =>
            item.status === 'pending' &&
            item.group !== undefined &&
            items.some(
              (other) =>
                other.group === item.group &&
                other.sequence < item.sequence &&
                (other.status === 'failed' || other.status === 'dead'),
            );
          const settled = () => {
            const items = queue.getItems();
            return items.every((item) => terminal(item) || heldBack(item, items));
          };
          await settle(world, settled);

          const finalItems = queue.getItems();
          for (const item of finalItems) {
            const held = heldBack(item, finalItems);
            seen.hit('heldBackByGroup', held);
            expect(terminal(item) || held).toBe(true);
            const sends = world.sends.filter((record) => record.key === item.key);
            expect(sends.length).toBeLessThanOrEqual(maxAttempts);
            const permanent = sends.findIndex((record) => record.outcome === 'permanent');
            if (permanent >= 0) {
              expect(permanent).toBe(sends.length - 1);
              expect(item.status).toBe('dead');
            } else {
              expect(item.status).not.toBe('dead');
            }
            if (item.status === 'failed') expect(sends).toHaveLength(maxAttempts);
            expect(item.attempts).toBe(sends.length);
            seen.hit('dead', item.status === 'dead');
            seen.hit('failed', item.status === 'failed' && maxAttempts > 1);
            seen.hit('succeededAfterRetry', item.status === 'succeeded' && sends.length > 1);
            seen.hit('rateLimited', sends.some((send) => send.outcome === 'rateLimited'));
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
    seen.expectAllReached();
  });
});

/** What a reload must show for a live item: interrupted attempts return to `pending`. */
function afterReload(item: QueueItem, maxAttempts: number) {
  const status =
    item.status === 'inflight' ? (item.attempts >= maxAttempts ? 'failed' : 'pending') : item.status;
  return {
    id: item.id,
    key: item.key,
    group: item.group,
    payload: item.payload,
    sequence: item.sequence,
    attempts: item.attempts,
    status,
  };
}

describe('property 4: reloading from storage gives the same items as the live queue', () => {
  it('holds after every prefix of operations', async () => {
    const seen = coverage('comparedInFlight', 'comparedAfterCrash', 'comparedTerminal', 'comparedWhileStopped');
    await fc.assert(
      fc.asyncProperty(
        worldConfig(anyFault, fc.integer({ min: 1, max: 4 })).map((config) => ({ ...config, storageLatency: 0 })),
        fc.array(
          fc.oneof(
            { weight: 4, arbitrary: enqueueOp },
            { weight: 3, arbitrary: advanceOp },
            { weight: 1, arbitrary: indexOp('discard') },
            { weight: 1, arbitrary: indexOp('retry') },
            { weight: 1, arbitrary: simple('crash') },
            { weight: 1, arbitrary: simple('offline') },
            { weight: 1, arbitrary: simple('online') },
            { weight: 1, arbitrary: simple('flush') },
            { weight: 1, arbitrary: simple('stop') },
            { weight: 1, arbitrary: simple('start') },
          ),
          { maxLength: 40, size: 'medium' },
        ),
        async (config, ops) => {
          const world = new World(config);
          const maxAttempts = config.retry!.maxAttempts!;
          void world.process.queue.start();
          let n = 0;
          for (const op of ops) {
            const { queue } = world.process;
            const items = queue.getItems();
            if (op.t === 'enqueue') enqueue(world, op.key, n++);
            else if (op.t === 'crash') {
              world.crash();
              void world.process.queue.start();
            } else if (op.t === 'discard' && items.length > 0) void queue.discard(items[op.index % items.length].id);
            else if (op.t === 'retry' && items.length > 0) {
              queue.retry(items[op.index % items.length].id).catch(() => undefined);
            } else if (op.t === 'offline') world.setOnline(false);
            else if (op.t === 'online') world.setOnline(true);
            else if (op.t === 'flush') void world.process.queue.flush();
            else if (op.t === 'stop') void queue.stop();
            else if (op.t === 'start') void queue.start();
            else if (op.t === 'advance') await world.clock.advance(op.ms);
            await world.clock.advance(0);

            const live = world.process.queue;
            await live.load();
            const reloaded = createIdempotentQueue<Payload>({
              storage: world.snapshotStorage(),
              send: () => new Promise(() => undefined),
              retry: config.retry,
            });
            await reloaded.load();
            const liveItems = live.getItems();
            seen.hit('comparedInFlight', liveItems.some((item) => item.status === 'inflight'));
            seen.hit('comparedAfterCrash', op.t === 'crash' && liveItems.length > 0);
            seen.hit('comparedTerminal', liveItems.some((item) => item.status !== 'pending' && item.status !== 'inflight'));
            seen.hit('comparedWhileStopped', !live.isRunning() && liveItems.length > 0);
            expect(reloaded.getItems().map((item) => afterReload(item, maxAttempts))).toEqual(
              liveItems.map((item) => afterReload(item, maxAttempts)),
            );
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
    seen.expectAllReached();
  });
});

describe('property 5: every written slot passes load validation and no item is lost across a restart', () => {
  const awkwardNumber = fc.constantFrom(NaN, Infinity, -Infinity, -1, -0, 0, 1, 250, 1e15, 1e308, Number.MAX_VALUE);
  /** What the classifier returns for one error; `default` uses `defaultClassifyError`. */
  const classifierOutput = fc.oneof(
    fc.constant('default' as const),
    fc.record({ type: fc.constantFrom('retryable', 'rateLimited'), delayMs: awkwardNumber }),
    fc.constantFrom<unknown>({ type: 'retryable' }, { type: 'permanent' }, { type: 'rateLimited' }, { type: 'other' }, null, 'x'),
  );
  const retryAfter = fc.constantFrom(
    '9'.repeat(400),
    '99999999999999999999',
    '86400.5',
    '3',
    '0',
    '-1',
    '1e400',
    'Fri, 31 Dec 9999 23:59:59 GMT',
    'Thu, 01 Jan 1970 00:00:00 GMT',
    'soon',
  );
  const answer = fc.oneof(
    fc.constant({ t: 'ok' as const }),
    fc.constant({ t: 'network' as const }),
    { weight: 3, arbitrary: fc.record({
      t: fc.constant('http' as const),
      status: fc.constantFrom(400, 408, 409, 429, 500, 503),
      retryAfter: fc.option(retryAfter, { nil: undefined }),
    }) },
  );
  type Answer = { t: 'ok' } | { t: 'network' } | { t: 'http'; status: number; retryAfter?: string };
  type Step = { answer: Answer; classification: unknown };

  type Op5 =
    | { t: 'enqueue'; key: number }
    | { t: 'advance'; ms: number }
    | { t: 'crash' | 'flush' | 'stop' | 'start' }
    | { t: 'retry' | 'discard'; index: number };
  const op5: fc.Arbitrary<Op5> = fc.oneof(
    { weight: 4, arbitrary: fc.record({ t: fc.constant('enqueue' as const), key: fc.integer({ min: 0, max: 5 }) }) },
    { weight: 5, arbitrary: fc.record({ t: fc.constant('advance' as const), ms: fc.constantFrom(5, 50, 400, 60000) }) },
    { weight: 1, arbitrary: fc.constantFrom<Op5>({ t: 'crash' }, { t: 'flush' }, { t: 'stop' }, { t: 'start' }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constantFrom('retry' as const, 'discard' as const), index: fc.nat(9) }) },
  );

  it('holds for any classifier output, Retry-After value and sequence of operations', async () => {
    const seen = coverage('nonFiniteDelay', 'hugeRetryAfter', 'comparedAfterCrash', 'comparedWaiting');
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ answer, classification: classifierOutput }), { minLength: 1, maxLength: 30 }),
        fc.constantFrom(1, 3, Infinity),
        fc.array(op5, { minLength: 1, maxLength: 40, size: 'medium' }),
        async (script: Step[], maxAttempts, ops) => {
          const clock = new FakeClock();
          const disk = new Map<string, string>();
          const invalid: string[] = [];
          const storageErrors: unknown[] = [];
          const never = <T>() => new Promise<T>(() => undefined);
          let next = 0;
          let ids = 0;
          let processes = 0;
          const retry = { maxAttempts, baseDelayMs: 20, maxDelayMs: 300 };

          const spawn = () => {
            const owner = `p${++processes}`;
            const timers = clock.timersFor(owner);
            const storage: QueueStorage = {
              getItem: (key) => (clock.isDead(owner) ? never() : Promise.resolve(disk.has(key) ? disk.get(key)! : null)),
              setItem: (key, value) => {
                if (clock.isDead(owner)) return never();
                if (/:(a|b)$/.test(key)) {
                  const result = decodeEnvelope(value);
                  if (!result.ok) invalid.push(result.reason);
                }
                disk.set(key, value);
                return Promise.resolve();
              },
              removeItem: (key) => {
                if (clock.isDead(owner)) return never();
                disk.delete(key);
                return Promise.resolve();
              },
            };
            const queue: IdempotentQueue<Payload> = createIdempotentQueue<Payload>({
              storage,
              retry,
              now: () => clock.now,
              timers,
              random: () => 0.5,
              generateKey: () => `id-${++ids}`,
              send: () =>
                new Promise((resolve, reject) => {
                  const step: Step = script[next++] || { answer: { t: 'ok' }, classification: 'default' };
                  timers.setTimeout(() => {
                    const { answer: a } = step;
                    if (a.t === 'ok') return resolve('ok');
                    const error =
                      a.t === 'network'
                        ? new TypeError('Network request failed')
                        : new HttpError(a.status, undefined, a.retryAfter === undefined ? {} : { 'Retry-After': a.retryAfter });
                    seen.hit('hugeRetryAfter', a.t === 'http' && a.retryAfter !== undefined && a.retryAfter.length > 15);
                    reject(Object.assign(error, { classification: step.classification }));
                  }, 5);
                }),
              classifyError: (error, context) => {
                const output = (error as { classification?: unknown }).classification;
                if (output === 'default' || output === undefined) return defaultClassifyError(error, context);
                const delay = output && typeof output === 'object' ? (output as { delayMs?: unknown }).delayMs : undefined;
                seen.hit('nonFiniteDelay', typeof delay === 'number' && !Number.isFinite(delay));
                return output as never;
              },
            });
            queue.subscribe((event) => {
              if (event.type === 'storage-error') storageErrors.push(event.error);
            });
            return { owner, queue };
          };

          let current = spawn();
          void current.queue.start();
          for (const op of ops) {
            const { queue } = current;
            const items = queue.getItems();
            if (op.t === 'enqueue') {
              queue.enqueue({ payload: { key: `key-${op.key}`, n: 0 }, key: `key-${op.key}`, group: op.key % 2 ? 'g' : undefined }).catch(() => undefined);
            } else if (op.t === 'crash') {
              clock.kill(current.owner);
              current = spawn();
              void current.queue.start();
            } else if (op.t === 'flush') void queue.flush();
            else if (op.t === 'stop') void queue.stop();
            else if (op.t === 'start') void queue.start();
            else if (op.t === 'retry' && items.length > 0) queue.retry(items[op.index % items.length].id).catch(() => undefined);
            else if (op.t === 'discard' && items.length > 0) void queue.discard(items[op.index % items.length].id);
            else if (op.t === 'advance') await clock.advance(op.ms);
            await clock.advance(0);

            const live = current.queue;
            await live.load();
            const liveItems = live.getItems();
            for (const item of liveItems) expect(Number.isFinite(item.nextAttemptAt)).toBe(true);
            const copy: Record<string, string> = {};
            disk.forEach((value, key) => (copy[key] = value));
            const reloaded = createIdempotentQueue<Payload>({
              storage: createMemoryStorage(copy),
              send: () => new Promise(() => undefined),
              retry,
            });
            await reloaded.load();
            seen.hit('comparedAfterCrash', op.t === 'crash' && liveItems.length > 0);
            seen.hit('comparedWaiting', liveItems.some((item) => item.status === 'pending' && item.nextAttemptAt > clock.now));
            expect(reloaded.getItems().map((item) => afterReload(item, maxAttempts))).toEqual(
              liveItems.map((item) => afterReload(item, maxAttempts)),
            );
          }
          expect(invalid).toEqual([]);
          expect(storageErrors).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
    seen.expectAllReached();
  });

  it('the storage layer never writes a slot that would fail to load', async () => {
    const field = fc.constantFrom<unknown>(0, 1, -1, NaN, Infinity, -Infinity, 1e308, '3', undefined);
    const anyItem = fc.record({
      id: fc.constantFrom('a', 'b', ''),
      key: fc.constantFrom('k1', 'k2', ''),
      payload: fc.jsonValue(),
      status: fc.constantFrom('pending', 'inflight', 'succeeded', 'failed', 'dead', 'unknown'),
      attempts: field,
      sequence: field,
      createdAt: field,
      updatedAt: field,
      nextAttemptAt: field,
    });
    await fc.assert(
      fc.asyncProperty(fc.array(fc.array(anyItem, { maxLength: 3 }), { minLength: 1, maxLength: 6 }), async (states) => {
        const storage = createMemoryStorage();
        const persistence = new QueuePersistence(storage, 'q', {
          onQuarantine: () => undefined,
          onStorageError: () => undefined,
          now: () => 0,
        });
        await persistence.load();
        for (const state of states) {
          await persistence.save(() => state as unknown as QueueItem[]).catch(() => undefined);
          storage.data.forEach((value, key) => {
            if (/:(a|b)$/.test(key)) expect(decodeEnvelope(value)).toMatchObject({ ok: true });
          });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
