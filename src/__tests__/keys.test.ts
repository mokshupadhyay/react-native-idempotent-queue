import { createIdempotentQueue } from '../queue';
import { getKeySource, resetKeySourceForTests, uuidV4, validateKey } from '../keys';
import { createMemoryStorage } from '../storage';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV4', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const setCrypto = (value: unknown) =>
    Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete (globalThis as { crypto?: unknown }).crypto;
    resetKeySourceForTests();
    jest.restoreAllMocks();
  });

  it('uses crypto.randomUUID first', () => {
    setCrypto({ randomUUID: () => '6F9619FF-8B86-4D01-B42D-00CF4FC964FF', getRandomValues: jest.fn() });
    expect(uuidV4()).toBe('6f9619ff-8b86-4d01-b42d-00cf4fc964ff');
    expect(getKeySource()).toBe('crypto.randomUUID');
  });

  it('falls back to crypto.getRandomValues with version and variant bits set', () => {
    setCrypto({
      getRandomValues: (array: Uint8Array) => {
        array.fill(0xff);
        return array;
      },
    });
    expect(getKeySource()).toBe('crypto.getRandomValues');
    const key = uuidV4();
    expect(key).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(key).toMatch(UUID_V4);
  });

  it('skips a randomUUID that throws or returns something else', () => {
    setCrypto({
      randomUUID: () => 'not-a-uuid',
      getRandomValues: (array: Uint8Array) => array.fill(1),
    });
    expect(uuidV4()).toMatch(UUID_V4);
    expect(getKeySource()).toBe('crypto.getRandomValues');
  });

  it('falls back to Math.random with a single warning and reports it', () => {
    setCrypto(undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(getKeySource()).toBe('Math.random');
    const keys = new Set(Array.from({ length: 200 }, () => uuidV4()));
    expect(keys.size).toBe(200);
    keys.forEach((key) => expect(key).toMatch(UUID_V4));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/Math\.random\(\).*guessable/);
    expect(getKeySource()).toBe('Math.random');
  });

  it('is exposed on the queue', () => {
    setCrypto({ randomUUID: () => '6f9619ff-8b86-4d01-b42d-00cf4fc964ff' });
    expect(createIdempotentQueue({ storage: createMemoryStorage(), send: () => 1 }).keySource).toBe(
      'crypto.randomUUID',
    );
    expect(
      createIdempotentQueue({ storage: createMemoryStorage(), send: () => 1, generateKey: () => 'x' }).keySource,
    ).toBe('custom');
  });

  it('produces valid v4 UUIDs with the platform crypto', () => {
    for (let i = 0; i < 50; i++) expect(uuidV4()).toMatch(UUID_V4);
  });
});

describe('validateKey', () => {
  it('accepts 1 to 255 characters', () => {
    expect(validateKey('a', 'key')).toBe('a');
    expect(validateKey('a'.repeat(255), 'key')).toHaveLength(255);
    expect(() => validateKey('', 'key')).toThrow(TypeError);
    expect(() => validateKey('a'.repeat(256), 'key')).toThrow(TypeError);
    expect(() => validateKey(5, 'key')).toThrow(TypeError);
  });

  it('rejects a generateKey that returns an invalid key', async () => {
    const queue = createIdempotentQueue({ storage: createMemoryStorage(), send: () => 1, generateKey: () => '' });
    await expect(queue.enqueue({ payload: 1 })).rejects.toThrow(/generateKey/);
  });
});
