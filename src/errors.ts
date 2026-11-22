/**
 * Recorded as the error of an attempt that did not settle within
 * `attemptTimeoutMs`. The attempt counts toward `maxAttempts` and is retried
 * like a network failure; the classifier is not consulted.
 */
export class AttemptTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`The attempt timed out after ${timeoutMs} ms`);
    // Keep `instanceof` working when the class is compiled to ES5 by an app's Babel config.
    Object.setPrototypeOf(this, AttemptTimeoutError.prototype);
    this.name = 'AttemptTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown by `enqueue` when saving the new item would make the stored state
 * larger than `maxStorageBytes`. Nothing is saved.
 */
export class QueueFullError extends Error {
  /** The size the stored state would have had, in UTF-8 bytes. */
  readonly size: number;
  readonly limit: number;

  constructor(size: number, limit: number) {
    super(
      `enqueue: the stored queue would take ${size} bytes, more than maxStorageBytes (${limit}). ` +
        'Discard or prune failed and dead items, or keep large data out of the payload.',
    );
    Object.setPrototypeOf(this, QueueFullError.prototype);
    this.name = 'QueueFullError';
    this.size = size;
    this.limit = limit;
  }
}
