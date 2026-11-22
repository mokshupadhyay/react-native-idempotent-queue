import type { QueueErrorKind, QueueItem, QueueItemStatus, QueueStorage } from './types';

/**
 * Stored layout
 * -------------
 * The queue alternates between two slots, `<prefix>:a` and `<prefix>:b`. Each
 * write goes to the slot that does not hold the newest valid copy, so a write
 * torn by the app being killed leaves the previous copy intact. Each slot holds
 * an envelope:
 *
 *   { "format": "react-native-idempotent-queue", "version": 1,
 *     "seq": 12, "checksum": "<fnv-1a of data>", "data": "<JSON array of items>" }
 *
 * On load the valid envelope with the highest `seq` wins. A slot that fails to
 * parse, has an unknown version, a wrong checksum or an invalid item is copied
 * to `<prefix>:quarantine` and ignored; loading never throws for bad data.
 *
 * Every write is decoded with the same checks before it is stored, so the
 * queue never writes a slot that its next load would quarantine.
 */
export const DEFAULT_STORAGE_KEY = 'react-native-idempotent-queue';
export const FORMAT = 'react-native-idempotent-queue';
export const VERSION = 1;
export const MAX_QUARANTINE_ENTRIES = 5;
/**
 * Default `maxStorageBytes`: 1 MB. Android's AsyncStorage cannot read a value
 * larger than about 2 MB (the SQLite cursor window), so this leaves room.
 */
export const DEFAULT_MAX_STORAGE_BYTES = 1000 * 1000;

/** UTF-8 length of a string, which is roughly what a value takes in SQLite. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // A surrogate pair is one 4-byte character.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export type Slot = 'a' | 'b';

export interface StoredState {
  items: QueueItem[];
  seq: number;
}

export interface QuarantineEntry {
  at: number;
  storageKey: string;
  reason: string;
  /** The unreadable value, cut short when `truncated` is set. */
  raw: string;
  /** Checksum of the whole unreadable value, used to skip copying it twice. */
  rawChecksum?: string;
  /** Set when `raw` was cut to keep the quarantine within `maxStorageBytes`. */
  truncated?: boolean;
}

/** FNV-1a over UTF-16 code units, as 8 hex digits. Detects truncation and bit flips, not tampering. */
export function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ('0000000' + hash.toString(16)).slice(-8);
}

const STATUSES: QueueItemStatus[] = ['pending', 'inflight', 'succeeded', 'failed', 'dead'];
const ERROR_KINDS: QueueErrorKind[] = ['retryable', 'permanent', 'rateLimited', 'interrupted'];

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && isFinite(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Structural check of one stored item. Returns a reason when invalid. */
export function validateItem(value: unknown): string | undefined {
  if (!isObject(value)) return 'item is not an object';
  if (typeof value.id !== 'string' || value.id === '') return 'item.id is invalid';
  if (typeof value.key !== 'string' || value.key === '') return 'item.key is invalid';
  if (value.group !== undefined && typeof value.group !== 'string') return 'item.group is invalid';
  if (!('payload' in value)) return 'item.payload is missing';
  if (value.metadata !== undefined && !isObject(value.metadata)) return 'item.metadata is invalid';
  if (STATUSES.indexOf(value.status as QueueItemStatus) < 0) return 'item.status is invalid';
  if (!isFiniteNumber(value.attempts) || value.attempts < 0) return 'item.attempts is invalid';
  for (const field of ['sequence', 'createdAt', 'updatedAt', 'nextAttemptAt']) {
    if (!isFiniteNumber(value[field])) return `item.${field} is invalid`;
  }
  if (value.completedAt !== undefined && !isFiniteNumber(value.completedAt)) return 'item.completedAt is invalid';
  if (value.lastError !== undefined) {
    const error = value.lastError;
    if (
      !isObject(error) ||
      ERROR_KINDS.indexOf(error.kind as QueueErrorKind) < 0 ||
      typeof error.message !== 'string' ||
      !isFiniteNumber(error.at) ||
      (error.status !== undefined && !isFiniteNumber(error.status))
    ) {
      return 'item.lastError is invalid';
    }
  }
  return undefined;
}

export function encodeEnvelope(items: readonly QueueItem[], seq: number): string {
  const data = JSON.stringify(items);
  return JSON.stringify({ format: FORMAT, version: VERSION, seq, checksum: checksum(data), data });
}

export type DecodeResult = { ok: true; state: StoredState } | { ok: false; reason: string };

export function decodeEnvelope(raw: string): DecodeResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'envelope is not valid JSON' };
  }
  if (!isObject(envelope) || envelope.format !== FORMAT) return { ok: false, reason: 'unknown format' };
  if (envelope.version !== VERSION) return { ok: false, reason: `unsupported version ${String(envelope.version)}` };
  if (!isFiniteNumber(envelope.seq) || typeof envelope.data !== 'string' || typeof envelope.checksum !== 'string') {
    return { ok: false, reason: 'envelope fields are invalid' };
  }
  if (checksum(envelope.data) !== envelope.checksum) return { ok: false, reason: 'checksum mismatch' };
  let items: unknown;
  try {
    items = JSON.parse(envelope.data);
  } catch {
    return { ok: false, reason: 'data is not valid JSON' };
  }
  if (!Array.isArray(items)) return { ok: false, reason: 'data is not an array' };
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const item of items) {
    const reason = validateItem(item);
    if (reason) return { ok: false, reason };
    const { id, key } = item as QueueItem;
    if (ids.has(id)) return { ok: false, reason: `duplicate item id ${id}` };
    if (keys.has(key)) return { ok: false, reason: 'duplicate idempotency key' };
    ids.add(id);
    keys.add(key);
  }
  return { ok: true, state: { items: items as QueueItem[], seq: envelope.seq } };
}

export interface PersistenceHooks {
  onQuarantine(reason: string, storageKey: string): void;
  onStorageError(error: unknown): void;
  now(): number;
}

export interface PersistenceOptions {
  /** Largest quarantine value, in UTF-8 bytes. Default `DEFAULT_MAX_STORAGE_BYTES`. */
  maxBytes?: number;
}

const other = (slot: Slot): Slot => (slot === 'a' ? 'b' : 'a');

/**
 * Reads and writes the queue's state. Writes run one at a time; a write
 * requested while another is waiting shares that waiting write, which reads
 * the newest state when it starts.
 */
export class QueuePersistence {
  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | undefined;
  private seq = 0;
  private nextSlot: Slot = 'a';
  /** Whether `seq` is known to be the highest valid one in storage. */
  private known = false;
  private readonly maxBytes: number;

  constructor(
    private readonly storage: QueueStorage,
    private readonly prefix: string,
    private readonly hooks: PersistenceHooks,
    options: PersistenceOptions = {},
  ) {
    this.maxBytes = options.maxBytes || DEFAULT_MAX_STORAGE_BYTES;
  }

  slotKey(slot: Slot): string {
    return `${this.prefix}:${slot}`;
  }

  get quarantineKey(): string {
    return `${this.prefix}:quarantine`;
  }

  /** Rejects only when storage itself fails to read; bad data is quarantined. */
  async load(): Promise<StoredState> {
    const slots: Slot[] = ['a', 'b'];
    const raws = await Promise.all(slots.map((slot) => this.storage.getItem(this.slotKey(slot))));
    let best: { slot: Slot; state: StoredState } | undefined;
    const bad: Array<{ slot: Slot; raw: string; reason: string }> = [];
    raws.forEach((raw, index) => {
      if (raw == null) return;
      const slot = slots[index];
      const result = decodeEnvelope(raw);
      if (!result.ok) {
        bad.push({ slot, raw, reason: result.reason });
        return;
      }
      if (!best || result.state.seq > best.state.seq) best = { slot, state: result.state };
    });
    for (const entry of bad) await this.quarantine(this.slotKey(entry.slot), entry.reason, entry.raw);
    this.known = true;
    if (best) {
      this.seq = Math.max(this.seq, best.state.seq);
      this.nextSlot = other(best.slot);
      return best.state;
    }
    // Overwrite a corrupted slot first, keeping any other copy.
    this.nextSlot = bad.length === 1 ? bad[0].slot : 'a';
    return { items: [], seq: this.seq };
  }

  /**
   * The stored size, in UTF-8 bytes, of a slot holding `items`. Throws if the
   * items cannot be encoded.
   */
  measure(items: readonly QueueItem[]): number {
    return utf8Length(encodeEnvelope(items, this.seq + 1));
  }

  /**
   * Writes `read()` as it is when the write starts. Rejects, without writing,
   * if the state would not pass load validation.
   */
  save(read: () => readonly QueueItem[]): Promise<void> {
    if (this.queued) return this.queued;
    const run = async () => {
      this.queued = undefined;
      const seq = this.seq + 1;
      const slot = this.nextSlot;
      const value = encodeEnvelope(read(), seq);
      // Never store a slot that the next load would quarantine.
      const check = decodeEnvelope(value);
      if (!check.ok) throw new Error(`Refusing to write a queue state that would not load: ${check.reason}`);
      await this.storage.setItem(this.slotKey(slot), value);
      this.seq = seq;
      this.nextSlot = other(slot);
    };
    const promise = this.chain.then(run, run);
    this.queued = promise;
    this.chain = promise.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  }

  /** Resolves when every write requested so far, and any requested meanwhile, has finished. */
  async idle(): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = this.chain;
      await chain;
    } while (chain !== this.chain);
  }

  /**
   * Deletes the stored state, after the writes already requested, in an order
   * that is safe if the app dies or a step fails:
   *
   * 1. write an empty state with a higher `seq`, through the usual alternating
   *    write (a torn write leaves the previous copy, as for any write);
   * 2. remove the other slot, which now holds an older state;
   * 3. remove the quarantine;
   * 4. remove the slot written in step 1.
   *
   * After step 1 every load finds an empty queue, so `onEmptied` is called
   * then. A failure in a later step rejects but leaves only data that never
   * loads again: an older `seq` beside the empty state, or the empty state.
   * When storage could not be read, the seq is unknown, so the slots are
   * removed directly and `onEmptied` runs only once all of them are gone.
   */
  clear(onEmptied: () => void = () => undefined): Promise<void> {
    const run = async () => {
      this.queued = undefined;
      if (!this.known) {
        try {
          await this.load();
        } catch {
          await this.storage.removeItem(this.slotKey('a'));
          await this.storage.removeItem(this.slotKey('b'));
          await this.storage.removeItem(this.quarantineKey);
          this.nextSlot = 'a';
          onEmptied();
          return;
        }
      }
      const slot = this.nextSlot;
      const seq = this.seq + 1;
      await this.storage.setItem(this.slotKey(slot), encodeEnvelope([], seq));
      this.seq = seq;
      this.nextSlot = other(slot);
      onEmptied();
      await this.storage.removeItem(this.slotKey(other(slot)));
      await this.storage.removeItem(this.quarantineKey);
      await this.storage.removeItem(this.slotKey(slot));
      // `seq` keeps growing, so a copy that survived anywhere stays older.
      this.nextSlot = 'a';
    };
    const promise = this.chain.then(run, run);
    this.queued = undefined;
    this.chain = promise.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  }

  /**
   * Copies unreadable data aside so it can be inspected; never throws. Keeps
   * at most `MAX_QUARANTINE_ENTRIES` entries and `maxBytes` in total: older
   * entries are dropped first, then the newest is cut short.
   */
  private async quarantine(storageKey: string, reason: string, raw: string): Promise<void> {
    this.hooks.onQuarantine(reason, storageKey);
    try {
      const existing = await this.storage.getItem(this.quarantineKey);
      let entries: QuarantineEntry[] = [];
      if (existing) {
        try {
          const parsed = JSON.parse(existing) as unknown;
          if (Array.isArray(parsed)) entries = parsed.filter((entry) => isObject(entry)) as unknown as QuarantineEntry[];
        } catch {
          entries = [];
        }
      }
      const rawChecksum = checksum(raw);
      const seen = entries.some(
        (entry) =>
          entry.storageKey === storageKey && (entry.raw === raw || (entry.truncated && entry.rawChecksum === rawChecksum)),
      );
      if (seen) return;
      entries.push({ at: this.hooks.now(), storageKey, reason, raw, rawChecksum });
      entries = entries.slice(-MAX_QUARANTINE_ENTRIES);
      const size = () => utf8Length(JSON.stringify(entries));
      while (entries.length > 1 && size() > this.maxBytes) entries.shift();
      const last = entries[entries.length - 1];
      let excess = size() - this.maxBytes;
      while (excess > 0 && last.raw.length > 0) {
        // Cut by the excess (at least a sixth of what is left), as JSON escaping makes sizes uneven.
        const cut = Math.max(excess, Math.ceil(last.raw.length / 6));
        last.raw = last.raw.slice(0, Math.max(0, last.raw.length - cut));
        last.truncated = true;
        excess = size() - this.maxBytes;
      }
      if (excess > 0) return;
      await this.storage.setItem(this.quarantineKey, JSON.stringify(entries));
    } catch (error) {
      this.hooks.onStorageError(error);
    }
  }
}

/** Reads the quarantined copies of unreadable data, newest last. */
export async function readQuarantine(
  storage: QueueStorage,
  storageKey = DEFAULT_STORAGE_KEY,
): Promise<QuarantineEntry[]> {
  const raw = await storage.getItem(`${storageKey}:quarantine`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QuarantineEntry[]) : [];
  } catch {
    return [];
  }
}
