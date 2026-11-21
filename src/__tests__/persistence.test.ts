import fc from 'fast-check';
import {
  checksum,
  decodeEnvelope,
  encodeEnvelope,
  QueuePersistence,
  readQuarantine,
  validateItem,
  VERSION,
} from '../persistence';
import { createMemoryStorage } from '../storage';
import type { QueueItem, QueueStorage } from '../types';
import { flushMicrotasks } from './support/fakeClock';

const item = (id: string, overrides: Partial<QueueItem> = {}): QueueItem => ({
  id,
  key: `key-${id}`,
  payload: { amount: 5 },
  status: 'pending',
  attempts: 0,
  sequence: 1,
  createdAt: 0,
  updatedAt: 0,
  nextAttemptAt: 0,
  ...overrides,
});

function setup(storage: QueueStorage = createMemoryStorage()) {
  const quarantined: string[] = [];
  const errors: unknown[] = [];
  const persistence = new QueuePersistence(storage, 'q', {
    onQuarantine: (reason) => quarantined.push(reason),
    onStorageError: (error) => errors.push(error),
    now: () => 42,
  });
  return { persistence, quarantined, errors };
}

describe('envelope', () => {
  it('round-trips items with a version and checksum', () => {
    const raw = encodeEnvelope([item('a')], 3);
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({ format: 'react-native-idempotent-queue', version: VERSION, seq: 3 });
    expect(parsed.checksum).toBe(checksum(parsed.data));
    expect(decodeEnvelope(raw)).toEqual({ ok: true, state: { items: [item('a')], seq: 3 } });
  });

  it.each([
    ['not JSON', '{"format":'],
    ['another format', JSON.stringify({ format: 'other', version: 1 })],
    ['a future version', JSON.stringify({ format: 'react-native-idempotent-queue', version: 2, seq: 1, data: '[]', checksum: checksum('[]') })],
    ['a checksum mismatch', encodeEnvelope([item('a')], 1).replace('"amount\\":5', '"amount\\":6')],
    ['data that is not an array', (() => { const data = '{}'; return JSON.stringify({ format: 'react-native-idempotent-queue', version: 1, seq: 1, data, checksum: checksum(data) }); })()],
    ['an invalid item', encodeEnvelope([{ ...item('a'), status: 'weird' } as unknown as QueueItem], 1)],
    ['duplicate keys', encodeEnvelope([item('a'), { ...item('b'), key: 'key-a' }], 1)],
  ])('rejects %s', (_name, raw) => {
    expect(decodeEnvelope(raw).ok).toBe(false);
  });

  it('rejects every truncation of a valid envelope', () => {
    const raw = encodeEnvelope([item('a'), item('b', { sequence: 2 })], 7);
    for (let length = 0; length < raw.length; length++) {
      expect(decodeEnvelope(raw.slice(0, length)).ok).toBe(false);
    }
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => decodeEnvelope(raw)).not.toThrow();
      }),
    );
  });

  it('validates item fields', () => {
    expect(validateItem(item('a'))).toBeUndefined();
    expect(validateItem({ ...item('a'), attempts: -1 })).toMatch(/attempts/);
    expect(validateItem({ ...item('a'), key: '' })).toMatch(/key/);
    expect(validateItem({ ...item('a'), lastError: { kind: 'retryable', message: 'x', at: 'now' } })).toMatch(
      /lastError/,
    );
    const { payload: _payload, ...withoutPayload } = item('a');
    expect(validateItem(withoutPayload)).toMatch(/payload/);
  });
});

describe('QueuePersistence', () => {
  it('alternates slots so the previous copy survives a torn write', async () => {
    const storage = createMemoryStorage();
    const { persistence } = setup(storage);
    await persistence.load();
    await persistence.save(() => [item('a')]);
    await persistence.save(() => [item('a'), item('b', { sequence: 2 })]);
    expect(storage.data.has('q:a') && storage.data.has('q:b')).toBe(true);

    // The app dies halfway through the next write: the newest slot is torn.
    const newest = JSON.parse(storage.data.get('q:b')!).seq > JSON.parse(storage.data.get('q:a')!).seq ? 'q:b' : 'q:a';
    storage.data.set(newest, storage.data.get(newest)!.slice(0, 40));

    const reloaded = setup(storage);
    const state = await reloaded.persistence.load();
    expect(state.items.map((i) => i.id)).toEqual(['a']);
    expect(reloaded.quarantined).toEqual(['envelope is not valid JSON']);
  });

  it('keeps writing after a torn slot without overwriting the good one first', async () => {
    const storage = createMemoryStorage();
    const first = setup(storage);
    await first.persistence.load();
    await first.persistence.save(() => [item('a')]); // slot a, seq 1
    storage.data.set('q:b', 'garbage');
    const second = setup(storage);
    await second.persistence.load();
    await second.persistence.save(() => [item('a'), item('b', { sequence: 2 })]);
    // The write went to the corrupted slot b; slot a still holds the older copy.
    expect(decodeEnvelope(storage.data.get('q:a')!)).toMatchObject({ ok: true, state: { seq: 1 } });
    expect(decodeEnvelope(storage.data.get('q:b')!)).toMatchObject({ ok: true, state: { seq: 2 } });
  });

  it('quarantines unreadable data instead of throwing and starts empty', async () => {
    const storage = createMemoryStorage({ 'q:a': '\u0000\u0001not json', 'q:b': '{"format":"x"}' });
    const { persistence, quarantined } = setup(storage);
    await expect(persistence.load()).resolves.toEqual({ items: [], seq: 0 });
    expect(quarantined).toHaveLength(2);
    const entries = await readQuarantine(storage, 'q');
    expect(entries.map((entry) => entry.raw)).toEqual(['\u0000\u0001not json', '{"format":"x"}']);
    expect(entries[0]).toMatchObject({ at: 42, storageKey: 'q:a', reason: 'envelope is not valid JSON' });

    // Loading again does not duplicate quarantined copies.
    await setup(storage).persistence.load();
    expect(await readQuarantine(storage, 'q')).toHaveLength(2);
  });

  it('survives a quarantine that cannot be written', async () => {
    const storage = createMemoryStorage({ 'q:a': 'broken' });
    storage.setItem = () => Promise.reject(new Error('disk full'));
    const { persistence, errors } = setup(storage);
    await expect(persistence.load()).resolves.toEqual({ items: [], seq: 0 });
    expect(errors).toHaveLength(1);
  });

  it('never runs two writes at once and coalesces writes that wait', async () => {
    const memory = createMemoryStorage();
    let running = 0;
    let maxRunning = 0;
    const releases: Array<() => void> = [];
    const storage: QueueStorage = {
      ...memory,
      setItem: (key, value) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        return new Promise<void>((resolve) =>
          releases.push(() => {
            running--;
            memory.data.set(key, value);
            resolve();
          }),
        );
      },
    };
    const { persistence } = setup(storage);
    await persistence.load();
    let state = [item('a')];
    const first = persistence.save(() => state);
    // A write that has not started yet reads the newest state, so later saves join it.
    expect(persistence.save(() => state)).toBe(first);
    await flushMicrotasks();
    expect(releases).toHaveLength(1);
    // The first write is now running; the next two share one waiting write.
    state = [item('a'), item('b', { sequence: 2 })];
    const second = persistence.save(() => state);
    state = [item('a'), item('b', { sequence: 2 }), item('c', { sequence: 3 })];
    const third = persistence.save(() => state);
    expect(third).toBe(second);
    expect(third).not.toBe(first);
    await flushMicrotasks();
    expect(releases).toHaveLength(1);
    releases[0]();
    await first;
    await flushMicrotasks();
    expect(releases).toHaveLength(2);
    releases[1]();
    await third;
    await flushMicrotasks();
    expect(releases).toHaveLength(2);
    expect(maxRunning).toBe(1);
    const loaded = await setup(memory).persistence.load();
    expect(loaded.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('rejects a failed write and keeps the next one going', async () => {
    const memory = createMemoryStorage();
    let fail = true;
    const storage: QueueStorage = {
      ...memory,
      setItem: (key, value) => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error('io'));
        }
        return memory.setItem(key, value);
      },
    };
    const { persistence } = setup(storage);
    await persistence.load();
    await expect(persistence.save(() => [item('a')])).rejects.toThrow('io');
    await persistence.save(() => [item('a')]);
    expect((await setup(memory).persistence.load()).items).toHaveLength(1);
  });

  it('clear removes both slots and the quarantine', async () => {
    const storage = createMemoryStorage({ 'q:b': 'broken' });
    const { persistence } = setup(storage);
    await persistence.load();
    await persistence.save(() => [item('a')]);
    await persistence.clear();
    expect(Array.from(storage.data.keys())).toEqual([]);
  });
});
