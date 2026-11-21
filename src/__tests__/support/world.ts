import { HttpError } from '../../classify';
import { createIdempotentQueue } from '../../queue';
import type { IdempotentQueue, QueueItem, QueueOptions, QueueStorage, SendContext } from '../../types';
import { FakeClock, seededRandom } from './fakeClock';

/**
 * What happens to one request:
 * - `ok`: applied, answered.
 * - `lostRequest`: never reaches the server (network error).
 * - `lostResponse`: applied, then the answer is lost (network error).
 * - `http500`: the server fails before applying it.
 * - `http429`: rate limited with `Retry-After: 1`, not applied.
 * - `http400`: rejected as invalid, not applied (permanent).
 */
export type Fault = 'ok' | 'lostRequest' | 'lostResponse' | 'http500' | 'http429' | 'http400';

export type Payload = { key: string; n: number };

/** A server that applies each idempotency key at most once and replays the first answer. */
export class FakeServer {
  /** How many times each key's effect was applied. */
  readonly applied = new Map<string, number>();
  private readonly answers = new Map<string, { receipt: string }>();

  handle(key: string, payload: Payload): { receipt: string } {
    const stored = this.answers.get(key);
    if (stored) return stored;
    this.applied.set(key, (this.applied.get(key) || 0) + 1);
    const answer = { receipt: `${key}:${payload.n}` };
    this.answers.set(key, answer);
    return answer;
  }
}

export interface SendRecord {
  key: string;
  attempt: number;
  fault: Fault;
  /** Online when the request left. */
  online: boolean;
  process: number;
  /** What the app saw, set when the answer arrives. */
  outcome?: 'success' | 'network' | 'retryable' | 'rateLimited' | 'permanent';
  /** The network went down while the request was in flight, so the answer was lost. */
  lostToOffline?: boolean;
}

export interface WorldConfig {
  concurrency: number;
  storageLatency: number;
  sendLatency: number;
  useSubscription: boolean;
  seed: number;
  retry: QueueOptions['retry'];
  faults: Fault[];
}

type Process = {
  id: number;
  owner: string;
  queue: IdempotentQueue<Payload, { receipt: string }>;
  /** Sends in flight by key in this process. */
  inflight: Map<string, number>;
};

const never = <T>() => new Promise<T>(() => undefined);

/**
 * A device (storage that survives crashes), a network that can go offline and
 * a server, with one live app process at a time. `crash()` freezes the
 * current process forever and starts a new one on the same storage.
 */
export class World {
  readonly clock = new FakeClock();
  readonly disk = new Map<string, string>();
  readonly server = new FakeServer();
  readonly sends: SendRecord[] = [];
  /** Highest number of simultaneous sends seen for one key in one process. */
  maxSameKeyInFlight = 0;
  online = true;
  process!: Process;
  private processCount = 0;
  private faultIndex = 0;
  private listeners = new Set<(online: boolean) => void>();
  readonly random: () => number;

  constructor(readonly config: WorldConfig) {
    this.random = seededRandom(config.seed);
    this.process = this.spawn();
  }

  storageFor(owner: string): QueueStorage {
    const timers = this.clock.timersFor(owner);
    const latency = this.config.storageLatency;
    const write = (apply: () => void): Promise<void> => {
      if (this.clock.isDead(owner)) return never();
      if (latency === 0) {
        apply();
        return Promise.resolve();
      }
      // A write that has not landed when the process dies is lost.
      return new Promise((resolve) => {
        timers.setTimeout(() => {
          apply();
          resolve();
        }, latency);
      });
    };
    return {
      getItem: (key) => (this.clock.isDead(owner) ? never() : Promise.resolve(this.disk.has(key) ? this.disk.get(key)! : null)),
      setItem: (key, value) => write(() => this.disk.set(key, value)),
      removeItem: (key) => write(() => this.disk.delete(key)),
    };
  }

  private nextFault(): Fault {
    const { faults } = this.config;
    return this.faultIndex < faults.length ? faults[this.faultIndex++] : 'ok';
  }

  /** Makes every later request succeed. */
  stopFaults(): void {
    this.faultIndex = this.config.faults.length;
  }

  private spawn(): Process {
    const id = ++this.processCount;
    const owner = `process-${id}`;
    const timers = this.clock.timersFor(owner);
    const inflight = new Map<string, number>();
    const send = (item: QueueItem<Payload>, context: SendContext): Promise<{ receipt: string }> => {
      if (this.clock.isDead(owner)) return never();
      const count = (inflight.get(context.key) || 0) + 1;
      inflight.set(context.key, count);
      this.maxSameKeyInFlight = Math.max(this.maxSameKeyInFlight, count);
      const online = this.online;
      const fault = this.nextFault();
      const record: SendRecord = { key: context.key, attempt: context.attempt, fault, online, process: id };
      this.sends.push(record);
      let outcome: { value: { receipt: string } } | { error: unknown };
      if (!online || fault === 'lostRequest') {
        outcome = { error: new TypeError('Network request failed') };
      } else if (fault === 'http500') {
        outcome = { error: new HttpError(500) };
      } else if (fault === 'http429') {
        outcome = { error: new HttpError(429, undefined, { 'Retry-After': '1' }) };
      } else if (fault === 'http400') {
        outcome = { error: new HttpError(400) };
      } else {
        const value = this.server.handle(context.key, item.payload);
        outcome = fault === 'lostResponse' ? { error: new TypeError('Network request failed') } : { value };
      }
      return new Promise((resolve, reject) => {
        timers.setTimeout(() => {
          inflight.set(context.key, (inflight.get(context.key) || 1) - 1);
          if (!this.online) {
            // Whatever the server did, the answer does not reach an offline device.
            record.lostToOffline = true;
            outcome = { error: new TypeError('Network request failed') };
          }
          if ('error' in outcome) {
            const status = (outcome.error as { status?: number }).status;
            record.outcome =
              status === undefined ? 'network' : status === 400 ? 'permanent' : status === 429 ? 'rateLimited' : 'retryable';
            reject(outcome.error);
          } else {
            record.outcome = 'success';
            resolve(outcome.value);
          }
        }, this.config.sendLatency);
      });
    };
    const queue = createIdempotentQueue<Payload, { receipt: string }>({
      storage: this.storageFor(owner),
      send,
      retry: this.config.retry,
      concurrency: this.config.concurrency,
      isOnline: () => this.online,
      subscribeToConnectivity: this.config.useSubscription
        ? (listener) => {
            this.listeners.add(listener);
            return () => this.listeners.delete(listener);
          }
        : undefined,
      offlineRecheckMs: 100,
      now: () => this.clock.now,
      random: this.random,
      timers,
      generateKey: () => `id-${Math.floor(this.random() * 1e12).toString(36)}-${this.clock.now}`,
    });
    // A queue that never logs keeps test output readable.
    queue.subscribe(() => undefined);
    return { id, owner, queue, inflight };
  }

  setOnline(online: boolean): void {
    this.online = online;
    this.listeners.forEach((listener) => listener(online));
  }

  /** Kills the current process mid-whatever and starts a fresh one on the same disk. */
  crash(): Process {
    this.clock.kill(this.process.owner);
    this.listeners.clear();
    this.process = this.spawn();
    return this.process;
  }

  /** Copy of the disk, for loading a second queue without touching the live one. */
  snapshotStorage(): QueueStorage {
    const data = new Map(this.disk);
    return {
      getItem: (key) => Promise.resolve(data.has(key) ? data.get(key)! : null),
      setItem: (key, value) => {
        data.set(key, value);
        return Promise.resolve();
      },
      removeItem: (key) => {
        data.delete(key);
        return Promise.resolve();
      },
    };
  }
}
