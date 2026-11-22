import { decodeEnvelope } from '../../persistence';
import { createIdempotentQueue } from '../../queue';
import { createMemoryStorage, type MemoryStorage } from '../../storage';
import type { QueueEvent, QueueItem, QueueOptions, QueueStorage, SendContext } from '../../types';
import { FakeClock } from './fakeClock';

export type Call = {
  item: QueueItem<unknown>;
  context: SendContext;
  resolve(value?: unknown): void;
  reject(error: unknown): void;
};

/** A queue on a fake clock whose sends wait until the test answers them. */
export function harness(overrides: Partial<QueueOptions> = {}, storage: QueueStorage = createMemoryStorage()) {
  const clock = new FakeClock();
  const calls: Call[] = [];
  const events: QueueEvent[] = [];
  let ids = 0;
  const queue = createIdempotentQueue({
    storage,
    send: (item, context) =>
      new Promise((resolve, reject) => {
        calls.push({ item, context, resolve, reject });
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
  return { clock, calls, events, queue, storage, tick };
}

/** Storage whose writes can be held until the test releases them. */
export function holdingStorage(memory: MemoryStorage = createMemoryStorage()) {
  const held: Array<() => void> = [];
  const state = { hold: false };
  const storage: QueueStorage = {
    getItem: (key) => memory.getItem(key),
    setItem: (key, value) =>
      state.hold
        ? new Promise<void>((resolve) =>
            held.push(() => {
              memory.data.set(key, value);
              resolve();
            }),
          )
        : memory.setItem(key, value),
    removeItem: (key) => memory.removeItem(key),
  };
  return { storage, memory, held, state };
}

/** Every slot value in `data` that does not pass load validation, with its reason. */
export function invalidSlots(data: Map<string, string>): string[] {
  const bad: string[] = [];
  data.forEach((value, key) => {
    if (!/:(a|b)$/.test(key)) return;
    const result = decodeEnvelope(value);
    if (!result.ok) bad.push(`${key}: ${result.reason}`);
  });
  return bad;
}

/** A copy of `data` as storage, so a second queue can load it without touching the first. */
export function copyOf(data: Map<string, string>): MemoryStorage {
  const initial: Record<string, string> = {};
  data.forEach((value, key) => (initial[key] = value));
  return createMemoryStorage(initial);
}

/** The keys a fresh queue finds in `data`. */
export async function reloadedKeys(data: Map<string, string>, options: Partial<QueueOptions> = {}): Promise<string[]> {
  const queue = createIdempotentQueue({ storage: copyOf(data), send: () => new Promise(() => undefined), ...options });
  await queue.load();
  return queue.getItems().map((item) => item.key);
}
