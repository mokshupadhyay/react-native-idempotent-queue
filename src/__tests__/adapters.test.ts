import { createNetInfoConnectivity, isNetInfoStateOnline, type NetInfoStateLike } from '../connectivity';
import { createAsyncStorageAdapter, createMemoryStorage } from '../storage';

describe('createMemoryStorage', () => {
  it('stores, reads and removes strings', async () => {
    const storage = createMemoryStorage({ a: '1' });
    expect(await storage.getItem('a')).toBe('1');
    expect(await storage.getItem('missing')).toBeNull();
    await storage.setItem('b', '2');
    await storage.removeItem('a');
    expect(Array.from(storage.data.entries())).toEqual([['b', '2']]);
  });
});

describe('createAsyncStorageAdapter', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('wraps a storage object passed to it', async () => {
    const memory = createMemoryStorage();
    const adapter = createAsyncStorageAdapter(memory);
    await adapter.setItem('k', 'v');
    expect(await adapter.getItem('k')).toBe('v');
    await adapter.removeItem('k');
    expect(memory.data.size).toBe(0);
    expect(() => createAsyncStorageAdapter({} as never)).toThrow(TypeError);
  });

  // Runs before the test that mocks the package.
  it('explains how to fix a missing package', () => {
    jest.isolateModules(() => {
      const { createAsyncStorageAdapter: create } = require('../storage');
      expect(() => create()).toThrow(/@react-native-async-storage\/async-storage is not installed/);
    });
  });

  it('loads the package lazily when called without an argument', () => {
    const memory = createMemoryStorage();
    jest.doMock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: memory }), {
      virtual: true,
    });
    jest.isolateModules(() => {
      const { createAsyncStorageAdapter: create } = require('../storage');
      const adapter = create();
      return adapter.setItem('k', 'v');
    });
    expect(memory.data.get('k')).toBe('v');
  });
});

describe('createNetInfoConnectivity', () => {
  function fakeNetInfo(initial: NetInfoStateLike) {
    const listeners = new Set<(state: NetInfoStateLike) => void>();
    return {
      listeners,
      fetch: jest.fn(async () => initial),
      addEventListener: (listener: (state: NetInfoStateLike) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (state: NetInfoStateLike) => listeners.forEach((listener) => listener(state)),
    };
  }

  it('reads isConnected and isInternetReachable, counting unknown as online', () => {
    expect(isNetInfoStateOnline({ isConnected: true, isInternetReachable: true })).toBe(true);
    expect(isNetInfoStateOnline({ isConnected: true, isInternetReachable: null })).toBe(true);
    expect(isNetInfoStateOnline({ isConnected: null, isInternetReachable: null })).toBe(true);
    expect(isNetInfoStateOnline({ isConnected: false, isInternetReachable: null })).toBe(false);
    expect(isNetInfoStateOnline({ isConnected: true, isInternetReachable: false })).toBe(false);
    expect(isNetInfoStateOnline(null)).toBe(true);
  });

  it('fetches until subscribed, then uses the last event', async () => {
    const netInfo = fakeNetInfo({ isConnected: false });
    const connectivity = createNetInfoConnectivity(netInfo);
    expect(await connectivity.isOnline()).toBe(false);
    const seen: boolean[] = [];
    const unsubscribe = connectivity.subscribeToConnectivity((online) => seen.push(online));
    netInfo.emit({ isConnected: true, isInternetReachable: true });
    expect(connectivity.isOnline()).toBe(true);
    netInfo.emit({ isConnected: true, isInternetReachable: false });
    expect(connectivity.isOnline()).toBe(false);
    expect(seen).toEqual([true, false]);
    unsubscribe();
    expect(netInfo.listeners.size).toBe(0);
    expect(netInfo.fetch).toHaveBeenCalledTimes(1);
  });

  it('loads the package lazily and explains a missing one', () => {
    jest.isolateModules(() => {
      const { createNetInfoConnectivity: create } = require('../connectivity');
      expect(() => create()).toThrow(/@react-native-community\/netinfo is not installed/);
    });
    const netInfo = fakeNetInfo({ isConnected: true });
    jest.doMock('@react-native-community/netinfo', () => ({ __esModule: true, default: netInfo }), { virtual: true });
    jest.isolateModules(() => {
      const { createNetInfoConnectivity: create } = require('../connectivity');
      create().subscribeToConnectivity(() => undefined);
    });
    expect(netInfo.listeners.size).toBe(1);
  });
});
