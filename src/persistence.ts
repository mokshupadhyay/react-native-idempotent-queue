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
 */
export const DEFAULT_STORAGE_KEY = 'react-native-idempotent-queue';
export const FORMAT = 'react-native-idempotent-queue';
export const VERSION = 1;
const MAX_QUARANTINE_ENTRIES = 5;

export type Slot = 'a' | 'b';

export interface StoredState {
  items: QueueItem[];
  seq: number;
}

export interface QuarantineEntry {
  at: number;
  storageKey: string;
  reason: string;
  raw: string;
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

  constructor(
    private readonly storage: QueueStorage,
    private readonly prefix: string,
    private readonly hooks: PersistenceHooks,
  ) {}

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
    if (best) {
      this.seq = best.state.seq;
      this.nextSlot = best.slot === 'a' ? 'b' : 'a';
      return best.state;
    }
    // Overwrite a corrupted slot first, keeping any other copy.
    this.seq = 0;
    this.nextSlot = bad.length === 1 ? bad[0].slot : 'a';
    return { items: [], seq: 0 };
  }

  /** Writes `read()` as it is when the write starts. */
  save(read: () => readonly QueueItem[]): Promise<void> {
    if (this.queued) return this.queued;
    const run = async () => {
      this.queued = undefined;
      const seq = this.seq + 1;
      const slot = this.nextSlot;
      await this.storage.setItem(this.slotKey(slot), encodeEnvelope(read(), seq));
      this.seq = seq;
      this.nextSlot = slot === 'a' ? 'b' : 'a';
    };
    const promise = this.chain.then(run, run);
    this.queued = promise;
    this.chain = promise.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  }

  /** Removes both slots and the quarantine, after the writes already requested. */
  clear(): Promise<void> {
    const run = async () => {
      await this.storage.removeItem(this.slotKey('a'));
      await this.storage.removeItem(this.slotKey('b'));
      await this.storage.removeItem(this.quarantineKey);
      this.seq = 0;
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

  /** Copies unreadable data aside so it can be inspected; never throws. */
  private async quarantine(storageKey: string, reason: string, raw: string): Promise<void> {
    this.hooks.onQuarantine(reason, storageKey);
    try {
      const existing = await this.storage.getItem(this.quarantineKey);
      let entries: QuarantineEntry[] = [];
      if (existing) {
        try {
          const parsed = JSON.parse(existing) as unknown;
          if (Array.isArray(parsed)) entries = parsed as QuarantineEntry[];
        } catch {
          entries = [];
        }
      }
      if (entries.some((entry) => entry && entry.raw === raw && entry.storageKey === storageKey)) return;
      entries.push({ at: this.hooks.now(), storageKey, reason, raw });
      await this.storage.setItem(this.quarantineKey, JSON.stringify(entries.slice(-MAX_QUARANTINE_ENTRIES)));
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
