# react-native-idempotent-queue

[![npm](https://img.shields.io/npm/v/react-native-idempotent-queue?label=npm)](https://www.npmjs.com/package/react-native-idempotent-queue)
[![license](https://img.shields.io/npm/l/react-native-idempotent-queue)](https://github.com/mokshupadhyay/react-native-idempotent-queue/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-mokshupadhyay%2Freact--native--idempotent--queue-181717?logo=github)](https://github.com/mokshupadhyay/react-native-idempotent-queue)

A queue for requests that change state on a server, such as a payment, a transfer or an order, so they survive a flaky mobile network and an app that gets killed.

- **Saved before it is sent.** `enqueue` resolves only after the request is written to storage. Each attempt is recorded on disk before the request leaves.
- **One idempotency key per request.** The key is created once and sent with every attempt: after a timeout, a 5xx, a lost response, or an app restart in the middle of a request.
- **Never sent in parallel with itself.** A key is never in flight twice, even after an attempt times out. Items in the same `group` go one at a time, in order, and a failed item holds back the rest of its group.
- **Retries that behave.** Exponential backoff with full jitter, `maxAttempts`, `Retry-After` (capped at 24 hours), a per-attempt timeout, and a waiting state while offline that does not use up attempts.
- **Safe storage.** A versioned envelope with a checksum, two alternating slots so a torn write keeps the previous copy, a check of every write before it is stored, a size limit, and a quarantine for unreadable data instead of a crash.
- **JavaScript only.** No native code, so it works on the old and the New Architecture, in Expo Go, and with React Native 0.60+ and React 16.8+.

## What it guarantees, and what it does not

Read this before using it for money.

- **At-least-once delivery with a stable key.** The library keeps sending a request, always with the same idempotency key, until `send` succeeds, the error is permanent, or `maxAttempts` is used up.
- **An exactly-once effect depends on your server.** Your server must honour the idempotency key. It stores the result of the first request with a given key and, for any repeat with that key, returns that stored result without doing the work again. Without that, a retry can charge a customer twice.
- **A success lost to a crash is sent again.** If the server applied a request but the app died, or the network dropped, before the response arrived, the queue cannot know it succeeded. It sends the request again with the same key, and the server must replay the stored response.
- **No ordering across groups.** Items in the same `group` are sent in enqueue order, one at a time. A `failed` or `dead` item holds back the later items of its group until you `retry` it and it succeeds, or `discard` it. Items in different groups, or without a group, can be sent and finish in any order when `concurrency` is above 1. A retry or a failure of one item does not hold back items outside its group.
- **Payloads are stored on the device in plain text** unless your storage adapter encrypts them. AsyncStorage does not encrypt. For sensitive data (card numbers, tokens, personal data), either keep it out of the payload (send a server-side reference instead) or use an encrypted storage adapter (see [Sensitive data](#sensitive-data)).
- **Delivery needs the app to run.** The queue sends while your JavaScript is running. It does not schedule background work. Call `start()` at launch and pending items are sent then.

## Install

```sh
npm install react-native-idempotent-queue
```

Optional, for the ready-made adapters:

```sh
npm install @react-native-async-storage/async-storage   # persistent storage
npm install @react-native-community/netinfo             # connectivity
cd ios && pod install
```

Both are optional peer dependencies. They are loaded only when you call `createAsyncStorageAdapter()` or `createNetInfoConnectivity()` without an argument.

The library is tested with Jest against simulated storage, clocks and networks (see [Testing](#testing)). It has not been run in a production app yet. Please [report issues](https://github.com/mokshupadhyay/react-native-idempotent-queue/issues).

## Usage with `fetch`

```ts
import {
  createIdempotentQueue,
  createAsyncStorageAdapter,
  fetchSender,
} from 'react-native-idempotent-queue';

type Payment = { amount: number; currency: string; to: string };

export const payments = createIdempotentQueue<Payment>({
  storage: createAsyncStorageAdapter(),
  send: fetchSender('https://api.example.com/payments', () => ({
    headers: { Authorization: `Bearer ${getToken()}` },
  })),
});

payments.start();

// In a screen
const item = await payments.enqueue({
  payload: { amount: 2500, currency: 'EUR', to: 'acct_42' },
  group: 'payments',
});
// The payment is saved on the device now and will be sent, and retried, with item.key.
```

`fetchSender(url, init?, options?)` returns a `send` function that, for each attempt:

- uses `init.method`, or `POST`;
- sets the `Idempotency-Key` header (or `options.headerName`) to the item's key. A header with the same name in `init` is ignored, so it cannot override the key. `init.headers` may be a plain object, an array of `[name, value]` pairs or a `Headers` instance;
- passes the attempt's `signal` to `fetch`, so an attempt that times out is aborted. A `signal` in `init` is used instead;
- sends the payload as the body: a string as it is, anything else as JSON with `Content-Type: application/json` unless you set a content type;
- resolves with the response body (parsed when it is JSON) for a 2xx response, and throws an `HttpError` with `status`, `headers` and `body` otherwise.

`url` and `init` can be functions of the item. Pass `init` as a function when headers such as a token must be read at send time. A network failure rejects as `fetch` does and is retried.

**Your server must honour the header.** Stripe, Adyen and many payment APIs do. For your own API, store `(key, response)` when you first handle a key and return the stored response when the key is seen again.

### Your own `send`

Any function works. It receives the item and `{ key, attempt, signal }`, and resolves on success or throws on failure. `signal` is aborted when the attempt times out; pass it to your HTTP client so the request is cancelled. It is `undefined` if the runtime has no `AbortController`:

```ts
const orders = createIdempotentQueue({
  storage,
  send: async (item, { key, signal }) => {
    const response = await api.post('/orders', item.payload, { headers: { 'Idempotency-Key': key }, signal });
    return response.data;
  },
});
```

The default classifier reads `status` and the `Retry-After` header from errors shaped like `{ status, headers }` and from Axios errors (`{ response: { status, headers } }`). Pass `classifyError` for anything else.

## Usage with AsyncStorage and NetInfo

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import {
  createAsyncStorageAdapter,
  createIdempotentQueue,
  createNetInfoConnectivity,
  fetchSender,
} from 'react-native-idempotent-queue';

export const queue = createIdempotentQueue({
  storage: createAsyncStorageAdapter(AsyncStorage), // or createAsyncStorageAdapter() to load it lazily
  ...createNetInfoConnectivity(NetInfo), // { isOnline, subscribeToConnectivity }
  send: fetchSender('https://api.example.com/transfers'),
  retry: { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 5 * 60 * 1000 },
});
```

While offline, items wait without using attempts and the queue sends them when NetInfo reports a connection. NetInfo's "unknown" state (`null`) counts as online: an attempt that fails is retried, while waiting on an unknown state could stall the queue.

With AsyncStorage 3, `createAsyncStorage('payments')` gives a separate database. Pass it the same way: `createAsyncStorageAdapter(createAsyncStorage('payments'))`.

## Showing the queue in the UI

```tsx
import { useQueueItems } from 'react-native-idempotent-queue';

function PendingPayments() {
  const { items, counts } = useQueueItems(payments);
  return (
    <>
      <Text>{counts.pending + counts.inflight} sending, {counts.failed + counts.dead} need attention</Text>
      {items
        .filter((item) => item.status === 'failed' || item.status === 'dead')
        .map((item) => (
          <Row
            key={item.id}
            title={item.lastError?.message}
            onRetry={() => payments.retry(item.id)}
            onRemove={() => payments.discard(item.id)}
          />
        ))}
    </>
  );
}
```

`useQueueItems` uses `useSyncExternalStore` on React 18 and later, and an effect subscription on React 16.8 and 17. `counts` has one entry per status and `total`.

## Item states

| Status | Meaning | Next |
| --- | --- | --- |
| `pending` | Waiting to be sent, possibly until `nextAttemptAt` | `inflight` |
| `inflight` | `send` is running | `succeeded`, `pending` (retry), `failed`, `dead` |
| `succeeded` | `send` resolved | Pruned after `keepSucceededMs` |
| `failed` | Every allowed attempt failed with a retryable error | `retry(id)`, `discard(id)` or `pruneFailed()` |
| `dead` | The error was permanent (for example HTTP 400 or 422) | `retry(id)`, `discard(id)` or `pruneFailed()` |

A `failed` or `dead` item holds back the later items of its `group`. They stay `pending` until it is retried and succeeds, or is removed. Without this, the second payment of a group could go through while the first is waiting for the user to retry it, and the retry would then run out of order.

When the queue loads, an item left `inflight` by a crash goes back to `pending` and is sent again with the same key. The interrupted attempt counts toward `maxAttempts`. If it was the last allowed attempt, the item becomes `failed` with `lastError.kind === 'interrupted'`.

Succeeded items are kept for `keepSucceededMs` (24 hours by default), so enqueuing the same key again, for example after a double tap, returns the succeeded item instead of sending again. They are removed at the next queue activity after that time. An idle queue keeps no timer for this.

## API

### `createIdempotentQueue(options)`

| Option | Default | |
| --- | --- | --- |
| `storage` | required | `{ getItem, setItem, removeItem }`, each returning a promise |
| `send(item, { key, attempt, signal })` | required | Sends one item. Resolve on success, throw on failure. `attempt` starts at 1. `signal` is aborted when the attempt times out |
| `classifyError(error, { item, attempt, now })` | `defaultClassifyError` | Returns `{ type: 'retryable', delayMs? }`, `{ type: 'permanent' }` or `{ type: 'rateLimited', delayMs }` |
| `retry` | `{ maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 60000 }` | `maxAttempts` counts the first attempt and may be `Infinity`. `baseDelayMs` and `maxDelayMs` must be finite and at least 10 |
| `isOnline()` | always online | May return a promise. While offline, items wait and do not use attempts |
| `subscribeToConnectivity(listener)` | | Returns an unsubscribe function. Without it, an offline queue checks `isOnline` every `offlineRecheckMs` |
| `offlineRecheckMs` | `5000` | |
| `concurrency` | `1` | Items sent at the same time. Items with the same `group` are always sequential |
| `attemptTimeoutMs` | `30000` | How long one attempt may run. Then `context.signal` is aborted and the attempt counts as a retryable failure (an `AttemptTimeoutError`). `Infinity` turns it off |
| `maxStorageBytes` | `1000000` | Largest stored value, in UTF-8 bytes. `enqueue` rejects with `QueueFullError` past it, and the quarantine is cut to it |
| `keepSucceededMs` | 24 hours | |
| `storageKey` | `'react-native-idempotent-queue'` | Prefix of the stored keys. Use one queue per prefix |
| `generateKey()` | UUID v4 | Generates idempotency keys and item ids |
| `now()`, `random()`, `timers` | `Date.now`, `Math.random`, global timers | Injectable for tests |

The retry delay after the n-th failed attempt is a random integer in `[0, min(maxDelayMs, baseDelayMs × 2^(n−1)))` ("full jitter"), raised to 1 ms if it comes out as 0. A classifier's `delayMs` (for example from `Retry-After`) replaces it. It is clamped to between 1 ms and 24 hours (`MAX_RETRY_DELAY_MS`), so `Infinity`, negative and huge values never reach storage; `NaN` falls back to the backoff delay. The 1 ms floor means the next attempt always waits for a timer, so a `send` that fails at once cannot keep the JavaScript thread busy.

When an attempt times out, the queue aborts `context.signal` and schedules a retry, but it does not send the item's key again until that `send` settles. `fetchSender` settles as soon as the signal aborts. A custom `send` that ignores the signal and never settles keeps its item waiting until the app restarts; that is the price of never having one key in flight twice.

When the attempt cannot be recorded in storage before sending, nothing is sent and no attempt is used. The item waits 1 second, then 2, 4 and so on up to 1 minute, and each failure emits `storage-error`.

### The queue

| Method | |
| --- | --- |
| `enqueue({ payload, key?, group?, metadata? })` | Saves the item, then resolves with it. Rejects if it could not be saved, and with `QueueFullError` (after a warning) if the stored state would exceed `maxStorageBytes`. A key that is already queued returns the existing item and creates nothing. `payload` and `metadata` must be JSON-serializable; keys are 1 to 255 characters |
| `start()` | Loads storage, returns interrupted items to `pending` and starts sending. Rejects if storage cannot be read |
| `stop()` | Stops starting attempts. Resolves when the attempts in flight have settled or timed out and every storage write requested so far has finished. After that the queue writes only when you call one of its methods, so a stopped queue cannot overwrite a newer queue on the same storage |
| `flush()` | Makes waiting items due now, emits `updated` for each, and resolves when nothing is in flight or due. A server's `Retry-After` is still respected. Does nothing while stopped |
| `getItems()` | Items in enqueue order. The array is frozen and replaced on every change, so it can be compared by reference |
| `retry(id)` | Returns a `failed`, `dead` or `pending` item to `pending` with zero attempts, due now, with the same key |
| `discard(id)` | Removes an item. If it is in flight, its result is ignored and its key stays blocked until that request settles. If its attempt is still being recorded, it is not sent |
| `pruneFailed({ olderThanMs? })` | Removes `failed` and `dead` items last updated at least `olderThanMs` ago (default 0, so all of them) and resolves with how many were removed |
| `clear()` | Waits for attempts in flight and pending writes, then deletes every item and the stored data, including quarantined copies. See [Clearing](#clearing) |
| `subscribe(listener)` | Events: `loaded`, `enqueued`, `attempt`, `succeeded` (with `result`), `retry-scheduled` (with `error`, `delayMs`), `failed`, `dead`, `updated`, `removed`, `cleared`, `storage-error`, `quarantined`. Returns an unsubscribe function |
| `load()` | Reads storage without sending. Called by `start`, `enqueue` and the other methods |
| `isRunning()`, `keySource` | |

### `defaultClassifyError`

| Error | Decision |
| --- | --- |
| No HTTP status: network failure, timeout, abort, anything else thrown | retryable |
| 408, 409, 425, 429, 500–599 | retryable, or `rateLimited` for the `Retry-After` delay (seconds or an HTTP date, at most 24 hours) when present |
| Any other status: other 4xx, and 1xx–3xx thrown as errors | permanent |

409 is retryable because servers that implement idempotency keys, such as Stripe and the IETF `Idempotency-Key` header draft, answer 409 while a request with the same key is still being processed. Calling it permanent would mark the item `dead` while the server goes on to charge. If your API uses 409 for conflicts that never clear, pass a `classifyError` that returns `permanent` for them; otherwise the item retries until `maxAttempts`.

A classifier that throws or returns something invalid counts as retryable. An attempt that times out counts as retryable without asking the classifier.

### Idempotency keys

The default `generateKey` makes a UUID v4 from the first source available:

1. `crypto.randomUUID()`;
2. `crypto.getRandomValues()`, for example from [`react-native-get-random-values`](https://github.com/LinusU/react-native-get-random-values);
3. `Math.random()`. This fallback is not cryptographically secure. Keys are unique in practice but guessable, and a warning is logged the first time it is used.

React Native does not provide `crypto` by default, so without a polyfill the fallback is used. `queue.keySource` and `getKeySource()` report the source (`'crypto.randomUUID'`, `'crypto.getRandomValues'`, `'Math.random'` or `'custom'`). Install a polyfill, or pass `generateKey`, when keys must not be guessable. When the server issues the key, or the request has a natural unique id (an order id), pass it as `key`.

### Other exports

`createMemoryStorage()`, `createAsyncStorageAdapter(storage?)`, `createNetInfoConnectivity(netInfo?)`, `isNetInfoStateOnline(state)`, `HttpError`, `AttemptTimeoutError`, `QueueFullError`, `parseRetryAfter(value, now)`, `backoffDelay`, `backoffCeiling`, `DEFAULT_RETRY_POLICY`, `MAX_RETRY_DELAY_MS`, `DEFAULT_MAX_STORAGE_BYTES`, `uuidV4()`, `getKeySource()`, `readQuarantine(storage, storageKey?)`, `countItems(items)`, and every type.

## Storage format and corrupted data

The queue writes its whole state to one of two keys, `<storageKey>:a` and `<storageKey>:b`, alternating between them. A write that is torn when the app is killed leaves the other key with the previous state. Writes run one at a time and never interleave. Each value is an envelope:

```json
{ "format": "react-native-idempotent-queue", "version": 1, "seq": 12, "checksum": "1f0c9a3b", "data": "[...items]" }
```

On load, the valid envelope with the highest `seq` wins. A value that is not JSON, has another format or version, fails its checksum, or holds an invalid item is copied to `<storageKey>:quarantine`, reported with a `quarantined` event and ignored. Loading does not throw because of bad data. `readQuarantine(storage)` returns the copies for inspection. Only a failing `getItem` makes `start()` reject.

Before each write, the queue decodes the envelope it is about to store with the same checks. A state that would fail them (for example a time that is not a finite number) is not written: the write rejects and the previous copy stays.

The checksum (FNV-1a) catches truncation and accidental corruption. It does not protect against someone who can edit the device's storage.

### Size

Each write stores every item, so keep the queue small. Android's AsyncStorage cannot read back a value larger than about 2 MB. `enqueue` therefore rejects with `QueueFullError`, and logs a warning, when the stored value would exceed `maxStorageBytes` (1 MB by default, counted in UTF-8 bytes). The quarantine keeps at most 5 copies and at most `maxStorageBytes` in total: older copies are dropped first, then the newest is cut short and marked `truncated`. Call `pruneFailed({ olderThanMs })` to remove old `failed` and `dead` items, and keep large data out of the payload.

### Clearing

To wipe the queue, call `queue.clear()`. It works in an order that is safe if the app is killed or a step fails:

1. it writes an empty state with a higher `seq`, through the usual alternating write;
2. it removes the other slot, then the quarantine, then the slot from step 1.

From step 1 on, every load finds an empty queue, and only then is the queue emptied in memory. If step 1 fails, `clear()` rejects and nothing changes, on disk or in memory. If a later step fails, `clear()` rejects, the queue is empty, and what is left on disk is never loaded again; calling `clear()` again removes it. Either way a queue that was running runs again afterwards, unless `stop()` was called while `clear()` ran.

Calls to `enqueue`, `retry`, `discard`, `pruneFailed`, `flush` and `start` made while `clear()` runs wait for it to finish. An item enqueued during `clear()` is therefore kept and sent; an item whose `enqueue` was called before `clear()` is removed by it.

Removing `<storageKey>` from storage by hand does nothing, because the data lives in `<storageKey>:a` and `<storageKey>:b`. If an old item survives that way, enqueuing its key again returns the old item instead of sending, which is the deduplication working as intended.

## Sensitive data

The payload is stored as JSON in whatever `storage` you pass. AsyncStorage keeps it unencrypted in the app's sandbox. For sensitive data:

- send a reference (a cart id, a server-side payment intent) instead of the data itself; or
- pass an encrypted store with `getItem`, `setItem` and `removeItem`, for example [`react-native-encrypted-storage`](https://github.com/emeraldsanto/react-native-encrypted-storage) or a wrapper around [`react-native-keychain`](https://github.com/oblador/react-native-keychain) or [`expo-secure-store`](https://docs.expo.dev/versions/latest/sdk/securestore/). Check the store's size limits: the queue writes its whole state to one key.

Never put card numbers or long-lived secrets in a payload stored in plain text. Payloads are not written to logs; error messages from `send` are stored in `lastError.message`, truncated to 500 characters.

## Testing

```sh
npm install
npm run typecheck
npm test
npm run build
```

Besides unit tests, `src/__tests__/properties.test.ts` uses [fast-check](https://github.com/dubzzz/fast-check) to generate sequences of enqueues, crashes (dropping the in-memory queue and reloading from storage at any step), offline periods, lost requests and lost responses, against a fake server that deduplicates by key. It checks that:

1. every enqueued key ends with its effect applied exactly once on the server and its item `succeeded`;
2. the same key is never in flight twice at the same time;
3. a permanent error is never retried, and a retryable error is attempted at most `maxAttempts` times;
4. reloading from storage after any prefix of operations gives the same items as the live queue;
5. for any classifier output (`NaN`, `Infinity`, negative or huge delays, invalid values) and any `Retry-After`, every value written to a slot passes load validation and reloading gives the same items as the live queue, also after crashes; and the storage layer never writes a slot that would fail to load, whatever items it is given.

`src/__tests__/regressions.test.ts` holds one test or more for each issue fixed in 0.1.1. Each of them failed on 0.1.0.

Everything runs on a fake clock, so no test waits on real time. `NUM_RUNS=2000 npm test` runs more cases. `node scripts/mutation-check.mjs` breaks the source in small ways and confirms each property catches its break. The results are in [docs/MUTATION_EVIDENCE.md](docs/MUTATION_EVIDENCE.md).

## How it works

- `src/queue.ts` owns the items, the attempt loop, recovery and deduplication.
- `src/persistence.ts` is the envelope, the two slots, the serialised writes and the quarantine.
- `src/backoff.ts` and `src/classify.ts` decide when to try again. `src/errors.ts` holds `AttemptTimeoutError` and `QueueFullError`.
- `src/keys.ts` generates keys. `src/storage.ts` and `src/connectivity.ts` are the optional adapters. `src/fetchSender.ts` and `src/hook.ts` are the `fetch` helper and the React hook.

## License

MIT
