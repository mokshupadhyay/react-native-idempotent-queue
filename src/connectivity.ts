/** The parts of a NetInfo state the queue reads. */
export interface NetInfoStateLike {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
}

/** The parts of `@react-native-community/netinfo` the adapter uses. */
export interface NetInfoLike {
  fetch(): Promise<NetInfoStateLike>;
  addEventListener(listener: (state: NetInfoStateLike) => void): () => void;
}

export interface Connectivity {
  isOnline(): boolean | Promise<boolean>;
  subscribeToConnectivity(listener: (online: boolean) => void): () => void;
}

/**
 * Online unless NetInfo says otherwise. `null` (not known yet) counts as
 * online: an attempt that fails offline is retried, while waiting on an
 * unknown state could stall the queue.
 */
export function isNetInfoStateOnline(state: NetInfoStateLike | null | undefined): boolean {
  if (!state) return true;
  return state.isConnected !== false && state.isInternetReachable !== false;
}

function isNetInfoLike(value: unknown): value is NetInfoLike {
  return (
    !!value &&
    typeof (value as NetInfoLike).fetch === 'function' &&
    typeof (value as NetInfoLike).addEventListener === 'function'
  );
}

function loadNetInfo(): NetInfoLike {
  let mod: unknown;
  try {
    mod = require('@react-native-community/netinfo');
  } catch (error) {
    throw new Error(
      'createNetInfoConnectivity: @react-native-community/netinfo is not installed. ' +
        'Install it, or pass the module: createNetInfoConnectivity(NetInfo). ' +
        `Cause: ${String(error)}`,
    );
  }
  const candidate = mod && (mod as { default?: unknown }).default ? (mod as { default: unknown }).default : mod;
  if (!isNetInfoLike(candidate)) {
    throw new Error('createNetInfoConnectivity: the NetInfo module has no fetch and addEventListener.');
  }
  return candidate;
}

/**
 * `isOnline` and `subscribeToConnectivity` backed by
 * `@react-native-community/netinfo`, an optional peer dependency required only
 * when this function runs without an argument. Spread the result into the
 * queue options.
 */
export function createNetInfoConnectivity(netInfo?: NetInfoLike): Connectivity {
  if (netInfo !== undefined && !isNetInfoLike(netInfo)) {
    throw new TypeError('createNetInfoConnectivity: the argument needs fetch and addEventListener.');
  }
  const info = netInfo || loadNetInfo();
  let last: boolean | undefined;
  return {
    isOnline: () => (last !== undefined ? last : info.fetch().then(isNetInfoStateOnline, () => true)),
    subscribeToConnectivity: (listener) => {
      const unsubscribe = info.addEventListener((state) => {
        last = isNetInfoStateOnline(state);
        listener(last);
      });
      return () => {
        last = undefined;
        unsubscribe();
      };
    },
  };
}
