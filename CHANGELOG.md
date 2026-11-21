# Changelog

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
