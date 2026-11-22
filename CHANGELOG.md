# Changelog

## 0.1.1

Fixes from a review of 0.1.0. Each fix has a test in `src/__tests__/regressions.test.ts` that fails on 0.1.0.

### Fixed

- **A non-finite retry delay made the stored queue unreadable, so every item was lost after a restart.** A `Retry-After` of many digits parsed to `Infinity`, and a classifier could return `delayMs: Infinity`. `nextAttemptAt` was then written as `null`, both slots were quarantined on the next load, and the queue started empty. Now `parseRetryAfter` caps its result at 24 hours (`MAX_RETRY_DELAY_MS`); a classifier's `delayMs` is clamped to between 1 ms and 24 hours, and `NaN` falls back to the backoff delay; and every write is decoded with the load checks before it is stored, so a state that would not load is never written.
- **`discard()` of an item whose attempt was being recorded still sent it.** The attempt now checks after the write that the item is still there and still the same attempt, and does not call `send` otherwise.
- **A failing step in `clear()` left the old items on disk while memory was empty, so they were sent on the next launch, and the queue stayed stopped.** `clear()` now writes an empty state with a higher `seq` first, then removes the other slot, the quarantine and the written slot. Memory is emptied only after the empty state is stored. On a failure, memory and disk agree, and a queue that was running runs again.
- **`clear()` restarted a queue that `stop()` had stopped while `clear()` ran.** It now restarts only if the queue is still meant to run.
- **A failing attempt write could keep the JavaScript thread busy.** The attempt was handed back with its count lowered, so the backoff never grew. With `baseDelayMs: 0` or a zero jitter draw, and storage that rejects at once, the queue retried in a loop without yielding. Storage failures now have their own backoff (1 s, doubling to 1 minute) and do not use attempts. Every automatic retry waits at least 1 ms on a timer. `baseDelayMs` and `maxDelayMs` must now be at least 10.
- **`stop()` did not wait for pending writes, so a late write of a stopped queue could overwrite a newer queue's saved enqueue.** `stop()` now also waits for every write requested so far. A stopped queue writes only when one of its methods is called.
- **An `enqueue()` called just after `clear()` started resolved as saved and was then wiped.** `enqueue`, `retry`, `discard`, `pruneFailed`, `flush` and `start` now wait for a running `clear()`, so an item enqueued during `clear()` is kept and sent.
- **`flush()` changed items without an event, so `useQueueItems` showed stale data.** It now emits `updated` for each item it makes due.
- **`fetchSender` dropped headers given as a `Headers` instance or an array of pairs.** An `Authorization` header was lost, the server answered 401, and the item became `dead`. Every form of `HeadersInit` is now read.
- **The offline state of an earlier run survived `stop()` and `start()` when only `subscribeToConnectivity` was given.** `start()` now resets it to online and checks again.
- **A `failed` or `dead` item no longer lets later items of its group go first.** Before, the next item was sent, and a later `retry()` sent the first one after it. The group now waits until the item is retried to success or removed.

### Changed

- HTTP 409 is retryable, and `rateLimited` with its `Retry-After` when present. Stripe and the IETF `Idempotency-Key` draft use 409 for "a request with this key is still being processed"; calling it permanent marked the item `dead` while the server went on to apply it.
- Each attempt has a timeout, `attemptTimeoutMs` (default 30 s, `Infinity` turns it off). `send` receives an `AbortSignal` as `context.signal`, which is aborted on timeout. The attempt counts as a retryable failure with an `AttemptTimeoutError`, and the key is not sent again until the timed-out `send` settles. `fetchSender` passes the signal to `fetch`. A `send` that never settles no longer blocks `stop()`.
- Size guard: `maxStorageBytes` (default 1 MB) limits the stored state. `enqueue` warns and rejects with `QueueFullError` past it. The quarantine is capped at the same size, with its newest copy cut short and marked `truncated` when needed.

### Added

- `pruneFailed({ olderThanMs })` removes old `failed` and `dead` items.
- Exports `AttemptTimeoutError`, `QueueFullError`, `MAX_RETRY_DELAY_MS`, `DEFAULT_MAX_STORAGE_BYTES`, and the types `AbortSignalLike` and `HeadersLike`.
- Property test 5: for any classifier output and `Retry-After`, every written slot passes load validation and no item is lost across a restart.

## 0.1.0

First release.

- `createIdempotentQueue` with `enqueue`, `start`, `stop`, `flush`, `getItems`, `retry`, `discard`, `subscribe`, `clear` and `load`.
- Items are saved before `enqueue` resolves, and each attempt is saved before the request is sent. Every attempt of an item uses the same idempotency key.
- Deduplication by key, a guard that never sends a key twice at once, `concurrency`, and sequential `group`s.
- Recovery of items left in flight by a crash, with the same key.
- Exponential backoff with full jitter, `maxAttempts`, `Retry-After`, and a waiting state while offline that does not use attempts.
- `defaultClassifyError` for network errors and HTTP statuses, `HttpError`, `parseRetryAfter`.
- Storage in a versioned, checksummed envelope across two alternating keys, with serialised writes and a quarantine for unreadable data.
- `createMemoryStorage`, `createAsyncStorageAdapter` and `createNetInfoConnectivity`. The AsyncStorage and NetInfo packages are optional peers, loaded lazily.
- `fetchSender`, which adds an `Idempotency-Key` header and maps responses to `HttpError`.
- `useQueueItems`, which uses `useSyncExternalStore` on React 18+ and an effect subscription on React 16.8 and 17.
- UUID v4 keys from `crypto.randomUUID`, then `crypto.getRandomValues`, then a `Math.random` fallback that logs a warning. `keySource` and `getKeySource()` report which source was used.
