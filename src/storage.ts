import type { QueueStorage } from './types';

export interface MemoryStorage extends QueueStorage {
  /** The stored values, for inspection in tests. */
  readonly data: Map<string, string>;
}

/** Storage that lives only as long as the JavaScript runtime. For tests and prototypes. */
export function createMemoryStorage(initial?: Record<string, string>): MemoryStorage {
  const data = new Map<string, string>();
  if (initial) for (const key of Object.keys(initial)) data.set(key, initial[key]);
  return {
    data,
    getItem: (key) => Promise.resolve(data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

type AsyncStorageLike = {
  getItem(key: string): Promise<string | null | undefined>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

function isStorageLike(value: unknown): value is AsyncStorageLike {
  return (
    !!value &&
    typeof (value as AsyncStorageLike).getItem === 'function' &&
    typeof (value as AsyncStorageLike).setItem === 'function' &&
    typeof (value as AsyncStorageLike).removeItem === 'function'
  );
}

function loadAsyncStorage(): AsyncStorageLike {
  let mod: unknown;
  try {
    mod = require('@react-native-async-storage/async-storage');
  } catch (error) {
    throw new Error(
      'createAsyncStorageAdapter: @react-native-async-storage/async-storage is not installed. ' +
        'Install it, or pass the storage object: createAsyncStorageAdapter(AsyncStorage). ' +
        `Cause: ${String(error)}`,
    );
  }
  const candidate = mod && (mod as { default?: unknown }).default ? (mod as { default: unknown }).default : mod;
  if (!isStorageLike(candidate)) {
    throw new Error('createAsyncStorageAdapter: the AsyncStorage module has no getItem, setItem and removeItem.');
  }
  return candidate;
}

/**
 * Storage backed by `@react-native-async-storage/async-storage`. The package is
 * an optional peer dependency, required only when this function runs without
 * an argument. Pass an instance (for example `createAsyncStorage('payments')`
 * from version 3, or an encrypted store with the same three methods) to use it
 * instead.
 */
export function createAsyncStorageAdapter(asyncStorage?: AsyncStorageLike): QueueStorage {
  if (asyncStorage !== undefined && !isStorageLike(asyncStorage)) {
    throw new TypeError('createAsyncStorageAdapter: the argument needs getItem, setItem and removeItem.');
  }
  // Required here, not at import, so apps without the package can use the rest of the library.
  const store = asyncStorage || loadAsyncStorage();
  return {
    getItem: (key) => store.getItem(key),
    setItem: (key, value) => store.setItem(key, value),
    removeItem: (key) => store.removeItem(key),
  };
}
