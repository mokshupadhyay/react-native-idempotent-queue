import { backoffDelay, resolveRetryPolicy } from './backoff';
import { defaultClassifyError, httpDetails } from './classify';
import { getKeySource, uuidV4, validateKey } from './keys';
import { DEFAULT_STORAGE_KEY, QueuePersistence } from './persistence';
import type {
  EnqueueInput,
  ErrorClassification,
  IdempotentQueue,
  JsonObject,
  KeySource,
  QueueErrorKind,
  QueueEvent,
  QueueItem,
  QueueItemError,
  QueueListener,
  QueueOptions,
  QueueTimers,
} from './types';

const HOUR = 60 * 60 * 1000;
/**
 * Longer waits are split into wake-ups of at most a minute. Older React Native
 * releases warn about longer timers on Android.
 */
const MAX_TIMER_DELAY = 60 * 1000;
const MAX_ERROR_MESSAGE = 500;

const defaultTimers: QueueTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

function cloneJson<T>(value: T, name: string): T {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${name} must be JSON-serializable: ${String(error)}`);
  }
  if (text === undefined) throw new TypeError(`${name} must be JSON-serializable`);
  return JSON.parse(text) as T;
}

function errorMessage(error: unknown): string {
  let message: string;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    message = (error as { message: string }).message;
  } else {
    try {
      message = typeof error === 'string' ? error : String(error);
    } catch {
      message = 'Unknown error';
    }
  }
  return message.length > MAX_ERROR_MESSAGE ? message.slice(0, MAX_ERROR_MESSAGE) : message;
}

function toItemError(kind: QueueErrorKind, error: unknown, at: number): QueueItemError {
  const result: QueueItemError = { kind, message: errorMessage(error), at };
  const details = httpDetails(error);
  if (details) result.status = details.status;
  return result;
}

function isClassification(value: unknown): value is ErrorClassification {
  if (!value || typeof value !== 'object') return false;
  const { type, delayMs } = value as { type?: unknown; delayMs?: unknown };
  if (type === 'permanent') return true;
  if (type === 'retryable') return delayMs === undefined || (typeof delayMs === 'number' && !Number.isNaN(delayMs));
  if (type === 'rateLimited') return typeof delayMs === 'number' && !Number.isNaN(delayMs);
  return false;
}

function checkCount(name: string, value: number | undefined, fallback: number, min: number, integer: boolean): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value) || value < min || (integer && Math.floor(value) !== value)) {
    throw new TypeError(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}, got ${String(value)}`);
  }
  return value;
}

/**
 * Creates a queue. Nothing is read or sent until `start()` (or `load()`,
 * `enqueue()`) is called. Use one queue per `storageKey`.
 */
export function createIdempotentQueue<TPayload = unknown, TResult = unknown>(
  options: QueueOptions<TPayload, TResult>,
): IdempotentQueue<TPayload, TResult> {
  type Item = QueueItem<TPayload>;
  type Event = QueueEvent<TPayload, TResult>;

  if (!options || typeof options !== 'object') throw new TypeError('createIdempotentQueue: options are required');
  const { storage, send } = options;
  if (
    !storage ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function'
  ) {
    throw new TypeError('createIdempotentQueue: storage needs getItem, setItem and removeItem');
  }
  if (typeof send !== 'function') throw new TypeError('createIdempotentQueue: send must be a function');

  const policy = resolveRetryPolicy(options.retry);
  const concurrency = checkCount('concurrency', options.concurrency, 1, 1, true);
  const keepSucceededMs = checkCount('keepSucceededMs', options.keepSucceededMs, 24 * HOUR, 0, false);
  const offlineRecheckMs = checkCount('offlineRecheckMs', options.offlineRecheckMs, 5000, 1, false);
  const now = options.now || (() => Date.now());
  const random = options.random || Math.random;
  const timers = options.timers || defaultTimers;
  const classify = options.classifyError || defaultClassifyError;
  const generateKey = options.generateKey || uuidV4;
  const keySource: KeySource = options.generateKey ? 'custom' : getKeySource();

  const listeners = new Set<QueueListener<TPayload, TResult>>();
  /** Items by id, in enqueue order. Updates keep their position. */
  const items = new Map<string, Item>();
  const idByKey = new Map<string, string>();
  let snapshot: readonly Item[] | null = null;
  let nextSequence = 1;

  let loaded = false;
  let loading: Promise<void> | undefined;
  let running = false;

  /** Keys with a request in flight, including one whose item was discarded. */
  const inflightKeys = new Set<string>();
  const busyGroups = new Set<string>();
  let active = 0;
  const tasks = new Set<Promise<void>>();
  /** Enqueued items whose first write has not finished. They are never sent. */
  const unconfirmed = new Map<string, Promise<void>>();

  let online = true;
  let unsubscribeConnectivity: (() => void) | undefined;
  let timer: unknown;
  let timerAt = Infinity;
  let pumpScheduled = false;
  let pumping = false;
  let pumpAgain = false;
  let idleWaiters: Array<() => void> = [];

  function emit(event: Event): void {
    if (event.type === 'storage-error' && listeners.size === 0) {
      console.warn('[react-native-idempotent-queue] Storage error:', event.error);
    }
    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.warn('[react-native-idempotent-queue] A queue listener threw:', error);
      }
    });
  }

  const persistence = new QueuePersistence(options.storage, options.storageKey || DEFAULT_STORAGE_KEY, {
    onQuarantine: (reason, storageKey) => emit({ type: 'quarantined', reason, storageKey }),
    onStorageError: (error) => emit({ type: 'storage-error', error }),
    now,
  });

  function getItems(): readonly Item[] {
    if (!snapshot) snapshot = Object.freeze(Array.from(items.values()));
    return snapshot;
  }

  function put(item: Item): void {
    items.set(item.id, item);
    idByKey.set(item.key, item.id);
    snapshot = null;
  }

  function remove(id: string): Item | undefined {
    const item = items.get(id);
    if (!item) return undefined;
    items.delete(id);
    if (idByKey.get(item.key) === id) idByKey.delete(item.key);
    snapshot = null;
    return item;
  }

  const save = () => persistence.save(getItems);
  const saveQuietly = () => save().then(undefined, (error: unknown) => emit({ type: 'storage-error', error }));

  function newId(): string {
    for (let i = 0; i < 5; i++) {
      const id = generateKey();
      if (!items.has(id)) return id;
    }
    throw new Error('createIdempotentQueue: generateKey keeps returning ids that already exist');
  }

  function load(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (!loading) {
      loading = persistence.load().then(
        (state) => {
          const t = now();
          const stored = state.items.slice().sort((a, b) => a.sequence - b.sequence) as Item[];
          for (let item of stored) {
            // Interrupted by the app stopping: the request may or may not have reached the server.
            if (item.status === 'inflight') {
              item =
                item.attempts >= policy.maxAttempts
                  ? {
                      ...item,
                      status: 'failed',
                      updatedAt: t,
                      lastError: {
                        kind: 'interrupted',
                        message: 'The app stopped while the last allowed attempt was in flight.',
                        at: t,
                      },
                    }
                  : { ...item, status: 'pending', updatedAt: t, nextAttemptAt: t };
            }
            put(item);
            if (item.sequence >= nextSequence) nextSequence = item.sequence + 1;
          }
          loaded = true;
          emit({ type: 'loaded', items: getItems() });
        },
        (error: unknown) => {
          loading = undefined;
          throw error;
        },
      );
    }
    return loading;
  }

  async function enqueue(input: EnqueueInput<TPayload>): Promise<Item> {
    if (!input || typeof input !== 'object') throw new TypeError('enqueue: input must be an object');
    const explicitKey = input.key !== undefined ? validateKey(input.key, 'enqueue: key') : undefined;
    if (input.group !== undefined && (typeof input.group !== 'string' || input.group === '')) {
      throw new TypeError('enqueue: group must be a non-empty string');
    }
    if (
      input.metadata !== undefined &&
      (input.metadata === null || typeof input.metadata !== 'object' || Array.isArray(input.metadata))
    ) {
      throw new TypeError('enqueue: metadata must be an object');
    }
    const payload = cloneJson(input.payload, 'enqueue: payload');
    const metadata = input.metadata === undefined ? undefined : cloneJson(input.metadata, 'enqueue: metadata');

    await load();

    let key = explicitKey;
    if (key !== undefined) {
      // Same key: return the item already queued instead of creating a second one.
      // Look again after every wait: the item may be discarded or replaced meanwhile.
      for (;;) {
        const existingId = idByKey.get(key);
        if (existingId === undefined) break;
        const confirming = unconfirmed.get(existingId);
        if (confirming) {
          await confirming.then(undefined, () => undefined);
          continue;
        }
        const existing = items.get(existingId);
        if (existing) return existing;
        break;
      }
    } else {
      key = validateKey(generateKey(), 'generateKey()');
      for (let i = 0; idByKey.has(key); i++) {
        if (i >= 5) throw new Error('enqueue: generateKey keeps returning keys that already exist');
        key = validateKey(generateKey(), 'generateKey()');
      }
    }

    const t = now();
    const item = {
      id: newId(),
      key,
      payload,
      status: 'pending',
      attempts: 0,
      sequence: nextSequence++,
      createdAt: t,
      updatedAt: t,
      nextAttemptAt: t,
    } as { -readonly [K in keyof Item]: Item[K] };
    if (input.group !== undefined) item.group = input.group;
    if (metadata !== undefined) item.metadata = metadata as JsonObject;
    put(item);

    // Saved before it can be sent, and before the caller hears it is queued.
    const write = save();
    unconfirmed.set(item.id, write);
    try {
      await write;
    } catch (error) {
      unconfirmed.delete(item.id);
      if (items.get(item.id) === item) {
        remove(item.id);
        emit({ type: 'removed', item });
        void saveQuietly();
      }
      throw error;
    }
    unconfirmed.delete(item.id);
    const current = items.get(item.id) || item;
    emit({ type: 'enqueued', item: current });
    schedulePump();
    return current;
  }

  function schedulePump(): void {
    if (pumpScheduled) return;
    pumpScheduled = true;
    Promise.resolve().then(() => {
      pumpScheduled = false;
      void runPump();
    });
  }

  async function runPump(): Promise<void> {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        await pumpOnce();
      } while (pumpAgain);
    } catch (error) {
      emit({ type: 'storage-error', error });
    } finally {
      pumping = false;
    }
    if (active === 0 && !pumpScheduled) resolveIdle();
  }

  function resolveIdle(): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  function clearTimer(): void {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    timerAt = Infinity;
  }

  function scheduleWake(at: number): void {
    if (timer !== undefined && timerAt === at) return;
    clearTimer();
    if (!running || at === Infinity) return;
    timerAt = at;
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, at - now()));
    timer = timers.setTimeout(() => {
      timer = undefined;
      timerAt = Infinity;
      schedulePump();
    }, delay);
  }

  /**
   * Removes succeeded items older than `keepSucceededMs`. Runs on every pass of
   * the queue (start, enqueue, each attempt, each wake-up) rather than on its
   * own timer, so an idle queue keeps no timer.
   */
  function prune(t: number): void {
    if (keepSucceededMs === Infinity) return;
    let removed = false;
    items.forEach((item) => {
      if (item.status !== 'succeeded') return;
      const completed = item.completedAt !== undefined ? item.completedAt : item.updatedAt;
      if (completed + keepSucceededMs <= t) {
        remove(item.id);
        removed = true;
        emit({ type: 'removed', item });
      }
    });
    if (removed) void saveQuietly();
  }

  /** Items that may start now, in order, and when the next waiting one becomes due. */
  function collectDue(t: number): { due: Item[]; wake: number } {
    const due: Item[] = [];
    let wake = Infinity;
    const blockedGroups = new Set(busyGroups);
    const claimedKeys = new Set<string>();
    items.forEach((item) => {
      if (item.status !== 'pending') return;
      if (item.group !== undefined) {
        // Only the oldest pending item of a group may go, and only when none is in flight.
        if (blockedGroups.has(item.group)) return;
        blockedGroups.add(item.group);
      }
      if (unconfirmed.has(item.id)) return;
      // Never two requests with the same key at once.
      if (inflightKeys.has(item.key) || claimedKeys.has(item.key)) return;
      if (item.nextAttemptAt > t) {
        if (item.nextAttemptAt < wake) wake = item.nextAttemptAt;
        return;
      }
      claimedKeys.add(item.key);
      due.push(item);
    });
    return { due, wake };
  }

  async function checkOnline(): Promise<boolean> {
    if (!options.isOnline) return online;
    try {
      return (await options.isOnline()) !== false;
    } catch {
      return true;
    }
  }

  async function pumpOnce(): Promise<void> {
    if (!running || !loaded) return;
    let t = now();
    prune(t);
    let { due, wake } = collectDue(t);
    let offline = false;
    if (due.length > 0 && active < concurrency) {
      const isOnline = await checkOnline();
      if (!running) return;
      t = now();
      if (isOnline) {
        ({ due, wake } = collectDue(t));
        for (const item of due) {
          if (active >= concurrency) break;
          startAttempt(item, t);
        }
      } else {
        offline = true;
      }
    }
    let at = wake;
    if (offline && !options.subscribeToConnectivity) at = Math.min(at, t + offlineRecheckMs);
    scheduleWake(at);
  }

  function startAttempt(item: Item, t: number): void {
    active++;
    inflightKeys.add(item.key);
    if (item.group !== undefined) busyGroups.add(item.group);
    const inflight: Item = { ...item, status: 'inflight', attempts: item.attempts + 1, updatedAt: t };
    put(inflight);
    emit({ type: 'attempt', item: inflight });
    const task = runAttempt(inflight).then(undefined, (error: unknown) => emit({ type: 'storage-error', error }));
    tasks.add(task);
    void task.then(() => tasks.delete(task));
  }

  /** Puts an item that was marked in flight but not sent back to `pending`. */
  function unsend(id: string, delayMs: number): void {
    const current = items.get(id);
    if (!current || current.status !== 'inflight') return;
    const t = now();
    const next: Item = {
      ...current,
      status: 'pending',
      attempts: current.attempts - 1,
      updatedAt: t,
      nextAttemptAt: t + delayMs,
    };
    put(next);
    emit({ type: 'updated', item: next });
  }

  async function runAttempt(item: Item): Promise<void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      inflightKeys.delete(item.key);
      if (item.group !== undefined) busyGroups.delete(item.group);
      schedulePump();
    };
    try {
      // The attempt is counted on disk before the request leaves.
      try {
        await save();
      } catch (error) {
        emit({ type: 'storage-error', error });
        unsend(item.id, backoffDelay(Math.max(1, item.attempts), policy, random));
        return;
      }
      if (!running) {
        unsend(item.id, 0);
        await saveQuietly();
        return;
      }

      let result: TResult | undefined;
      let failure: { error: unknown } | undefined;
      try {
        result = await send(item, { key: item.key, attempt: item.attempts });
      } catch (error) {
        failure = { error };
      }

      const current = items.get(item.id);
      // Discarded or cleared while in flight: the result is ignored.
      if (!current || current.status !== 'inflight') return;
      const t = now();
      let next: Item;
      let event: Event;
      if (!failure) {
        const { lastError: _ignored, ...rest } = current;
        next = { ...rest, status: 'succeeded', updatedAt: t, nextAttemptAt: t, completedAt: t };
        event = { type: 'succeeded', item: next, result: result as TResult };
      } else {
        const { error } = failure;
        let decision: ErrorClassification;
        try {
          const value: unknown = classify(error, { item: current, attempt: current.attempts, now: t });
          decision = isClassification(value) ? value : { type: 'retryable' };
        } catch {
          decision = { type: 'retryable' };
        }
        if (decision.type === 'permanent') {
          next = { ...current, status: 'dead', updatedAt: t, lastError: toItemError('permanent', error, t) };
          event = { type: 'dead', item: next, error };
        } else if (current.attempts >= policy.maxAttempts) {
          next = { ...current, status: 'failed', updatedAt: t, lastError: toItemError(decision.type, error, t) };
          event = { type: 'failed', item: next, error };
        } else {
          const delayMs =
            decision.delayMs !== undefined
              ? Math.max(0, decision.delayMs)
              : backoffDelay(current.attempts, policy, random);
          next = {
            ...current,
            status: 'pending',
            updatedAt: t,
            nextAttemptAt: t + delayMs,
            lastError: toItemError(decision.type, error, t),
          };
          event = { type: 'retry-scheduled', item: next, error, delayMs };
        }
      }
      put(next);
      await saveQuietly();
      emit(event);
    } finally {
      release();
    }
  }

  async function start(): Promise<void> {
    if (running) return load();
    running = true;
    if (options.subscribeToConnectivity && !unsubscribeConnectivity) {
      unsubscribeConnectivity = options.subscribeToConnectivity((value) => {
        online = value !== false;
        if (online) schedulePump();
      });
    }
    try {
      await load();
    } catch (error) {
      running = false;
      stopConnectivity();
      throw error;
    }
    schedulePump();
  }

  function stopConnectivity(): void {
    if (unsubscribeConnectivity) unsubscribeConnectivity();
    unsubscribeConnectivity = undefined;
  }

  async function stop(): Promise<void> {
    running = false;
    clearTimer();
    stopConnectivity();
    await Promise.all(Array.from(tasks));
    resolveIdle();
  }

  async function flush(): Promise<void> {
    await load();
    if (!running) return;
    const t = now();
    let changed = false;
    items.forEach((item) => {
      if (item.status !== 'pending' || item.nextAttemptAt <= t) return;
      // A server's Retry-After is respected even when flushing.
      if (item.lastError && item.lastError.kind === 'rateLimited') return;
      put({ ...item, nextAttemptAt: t, updatedAt: t });
      changed = true;
    });
    if (changed) void saveQuietly();
    const idle = new Promise<void>((resolve) => idleWaiters.push(resolve));
    schedulePump();
    await idle;
  }

  async function retry(id: string): Promise<Item> {
    await load();
    const item = items.get(id);
    if (!item) throw new Error(`retry: no item with id ${id}`);
    if (item.status === 'inflight' || item.status === 'succeeded') {
      throw new Error(`retry: the item is ${item.status}`);
    }
    const t = now();
    const next: Item = { ...item, status: 'pending', attempts: 0, nextAttemptAt: t, updatedAt: t };
    put(next);
    await save();
    emit({ type: 'updated', item: next });
    schedulePump();
    return next;
  }

  async function discard(id: string): Promise<boolean> {
    await load();
    const item = remove(id);
    if (!item) return false;
    emit({ type: 'removed', item });
    await save();
    return true;
  }

  async function clear(): Promise<void> {
    const wasRunning = running;
    await stop();
    try {
      await load();
    } catch {
      // Unreadable storage is removed below anyway.
    }
    items.clear();
    idByKey.clear();
    unconfirmed.clear();
    snapshot = null;
    await persistence.clear();
    loaded = true;
    emit({ type: 'cleared' });
    if (wasRunning) await start();
  }

  function subscribe(listener: QueueListener<TPayload, TResult>): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    enqueue,
    load,
    start,
    stop,
    flush,
    getItems,
    retry,
    discard,
    subscribe,
    clear,
    isRunning: () => running,
    keySource,
  };
}
