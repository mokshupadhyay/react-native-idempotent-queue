/** A value that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object, used for item metadata. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * - `pending`: waiting to be sent, possibly until `nextAttemptAt`.
 * - `inflight`: `send` is running for this item.
 * - `succeeded`: `send` resolved. Kept for `keepSucceededMs`, then pruned.
 * - `failed`: every allowed attempt failed with a retryable error. Call `retry(id)` to try again.
 * - `dead`: the classifier called the last error permanent. Call `retry(id)` to try again anyway.
 */
export type QueueItemStatus = 'pending' | 'inflight' | 'succeeded' | 'failed' | 'dead';

/**
 * Why the last attempt did not succeed.
 * `interrupted` means the app stopped while the final allowed attempt was in flight.
 */
export type QueueErrorKind = 'retryable' | 'permanent' | 'rateLimited' | 'interrupted';

/** The last error of an item, as stored on the device. */
export interface QueueItemError {
  kind: QueueErrorKind;
  message: string;
  /** HTTP status when the error carried one. */
  status?: number;
  /** When the error happened, in `now()` milliseconds. */
  at: number;
}

/** One request in the queue. Items are immutable snapshots; every change creates a new object. */
export interface QueueItem<TPayload = unknown> {
  /** Local identifier, used by `retry`, `discard` and UI lists. */
  readonly id: string;
  /** Idempotency key sent with every attempt of this item. Never changes. */
  readonly key: string;
  /** Items with the same group are sent one at a time, in enqueue order. */
  readonly group?: string;
  readonly payload: TPayload;
  readonly metadata?: JsonObject;
  readonly status: QueueItemStatus;
  /** Attempts started so far, including one interrupted by the app stopping. */
  readonly attempts: number;
  /** Enqueue order, increasing across restarts. */
  readonly sequence: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** A `pending` item is not sent before this time. */
  readonly nextAttemptAt: number;
  /** When the item succeeded. */
  readonly completedAt?: number;
  readonly lastError?: QueueItemError;
}

/**
 * Key-value storage. `@react-native-async-storage/async-storage` matches this
 * interface; so do most encrypted stores with a small wrapper.
 */
export interface QueueStorage {
  getItem(key: string): Promise<string | null | undefined>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** What `send` receives besides the item. */
export interface SendContext {
  /** The item's idempotency key. Send it to the server with every attempt. */
  key: string;
  /** 1 for the first attempt, 2 for the first retry, and so on. */
  attempt: number;
}

/** The classifier's decision about an error thrown by `send`. */
export type ErrorClassification =
  /** Try again after the backoff delay, or after `delayMs` when given. */
  | { type: 'retryable'; delayMs?: number }
  /** Never try again automatically. The item becomes `dead`. */
  | { type: 'permanent' }
  /** The server asked to wait. Try again after `delayMs`. */
  | { type: 'rateLimited'; delayMs: number };

export interface ClassifyContext<TPayload = unknown> {
  item: QueueItem<TPayload>;
  attempt: number;
  /** Current time from the queue's clock, for parsing HTTP dates. */
  now: number;
}

export type ErrorClassifier<TPayload = unknown> = (
  error: unknown,
  context: ClassifyContext<TPayload>,
) => ErrorClassification;

export interface RetryPolicy {
  /** Total attempts, including the first. `Infinity` retries forever. Default 8. */
  maxAttempts?: number;
  /** Upper bound of the first retry delay. Default 1000. */
  baseDelayMs?: number;
  /** Upper bound of any backoff delay. Default 60000. */
  maxDelayMs?: number;
}

/** Injectable timers, mainly for tests. */
export interface QueueTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Where the default key generator got its randomness from. */
export type KeySource = 'crypto.randomUUID' | 'crypto.getRandomValues' | 'Math.random' | 'custom';

export interface QueueOptions<TPayload = unknown, TResult = unknown> {
  storage: QueueStorage;
  /**
   * Sends one item. Resolve when the server accepted it; throw (or reject) otherwise.
   * Called again with the same `context.key` after a failure or a restart.
   */
  send: (item: QueueItem<TPayload>, context: SendContext) => Promise<TResult> | TResult;
  /** Default: `defaultClassifyError`, for HTTP-like and network errors. */
  classifyError?: ErrorClassifier<TPayload>;
  retry?: RetryPolicy;
  /** Checked before sending. Offline items wait without using attempts. */
  isOnline?: () => boolean | Promise<boolean>;
  /**
   * Calls the listener when connectivity changes and returns an unsubscribe
   * function. Without it, an offline queue checks `isOnline` again every
   * `offlineRecheckMs`.
   */
  subscribeToConnectivity?: (listener: (online: boolean) => void) => () => void;
  /** How long an offline queue waits before checking `isOnline` again. Default 5000. */
  offlineRecheckMs?: number;
  /** Items sent at the same time. Items with the same `group` are always sequential. Default 1. */
  concurrency?: number;
  /**
   * How long succeeded items stay, to deduplicate repeated enqueues of a key.
   * They are removed at the next queue activity after this time. Default 24 hours.
   */
  keepSucceededMs?: number;
  /** Storage key prefix. Use one queue per prefix. Default `'react-native-idempotent-queue'`. */
  storageKey?: string;
  /** Generates idempotency keys and item ids. Default: UUID v4, see `getKeySource()`. */
  generateKey?: () => string;
  now?: () => number;
  /** Returns a number in [0, 1). Used for backoff jitter. Default `Math.random`. */
  random?: () => number;
  timers?: QueueTimers;
}

export interface EnqueueInput<TPayload = unknown> {
  /** Must be JSON-serializable. It is stored on the device. */
  payload: TPayload;
  /** Idempotency key. Generated when omitted. An existing key returns the existing item. */
  key?: string;
  group?: string;
  metadata?: JsonObject;
}

/** Events delivered to `subscribe` listeners. Every event may follow a change of `getItems()`. */
export type QueueEvent<TPayload = unknown, TResult = unknown> =
  | { type: 'loaded'; items: readonly QueueItem<TPayload>[] }
  | { type: 'enqueued'; item: QueueItem<TPayload> }
  | { type: 'attempt'; item: QueueItem<TPayload> }
  | { type: 'succeeded'; item: QueueItem<TPayload>; result: TResult }
  | { type: 'retry-scheduled'; item: QueueItem<TPayload>; error: unknown; delayMs: number }
  | { type: 'failed'; item: QueueItem<TPayload>; error: unknown }
  | { type: 'dead'; item: QueueItem<TPayload>; error: unknown }
  | { type: 'updated'; item: QueueItem<TPayload> }
  | { type: 'removed'; item: QueueItem<TPayload> }
  | { type: 'cleared' }
  | { type: 'storage-error'; error: unknown }
  | { type: 'quarantined'; reason: string; storageKey: string };

export type QueueListener<TPayload = unknown, TResult = unknown> = (
  event: QueueEvent<TPayload, TResult>,
) => void;

export interface IdempotentQueue<TPayload = unknown, TResult = unknown> {
  /** Saves the item, then resolves with it. Rejects if it could not be saved. */
  enqueue(input: EnqueueInput<TPayload>): Promise<QueueItem<TPayload>>;
  /** Reads storage (once) without sending anything. `start`, `enqueue` and `flush` call it. */
  load(): Promise<void>;
  /** Loads, returns interrupted items to `pending` and starts sending. */
  start(): Promise<void>;
  /** Stops starting new attempts. Resolves when the attempts in flight have settled. */
  stop(): Promise<void>;
  /**
   * Makes waiting items due now (except items waiting for a server's
   * `Retry-After`) and resolves when nothing is in flight or due.
   * Does nothing while the queue is stopped.
   */
  flush(): Promise<void>;
  /** Current items in enqueue order. The array is replaced, never mutated, on change. */
  getItems(): readonly QueueItem<TPayload>[];
  /** Returns a `failed`, `dead` or `pending` item to `pending` with zero attempts, due now, same key. */
  retry(id: string): Promise<QueueItem<TPayload>>;
  /**
   * Removes an item. An item in flight is removed now; its result is ignored and
   * its key stays blocked until the request settles.
   */
  discard(id: string): Promise<boolean>;
  subscribe(listener: QueueListener<TPayload, TResult>): () => void;
  /** Waits for attempts in flight, then deletes every item and the stored data, including quarantined copies. */
  clear(): Promise<void>;
  /** Whether `start` was called without a later `stop`. */
  isRunning(): boolean;
  /** Where item ids and generated keys get their randomness from. */
  readonly keySource: KeySource;
}
