import * as React from 'react';
import type { IdempotentQueue, QueueItem, QueueItemStatus } from './types';

export type QueueCounts = Record<QueueItemStatus, number> & { total: number };

export interface QueueItemsState<TPayload = unknown> {
  items: readonly QueueItem<TPayload>[];
  counts: QueueCounts;
}

type Source<TPayload> = Pick<IdempotentQueue<TPayload, any>, 'getItems' | 'subscribe'>;

export function countItems(items: readonly QueueItem<unknown>[]): QueueCounts {
  const counts: QueueCounts = { pending: 0, inflight: 0, succeeded: 0, failed: 0, dead: 0, total: items.length };
  for (const item of items) counts[item.status]++;
  return counts;
}

type UseSyncExternalStore = <T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T) => T;

/** React 18+ path. */
export function useItemsWithSyncExternalStore<TPayload>(
  queue: Source<TPayload>,
  useSyncExternalStore: UseSyncExternalStore,
): readonly QueueItem<TPayload>[] {
  const subscribe = React.useCallback((onChange: () => void) => queue.subscribe(() => onChange()), [queue]);
  return useSyncExternalStore(subscribe, queue.getItems);
}

/** React 16.8 and 17 path: subscribe in an effect and re-read the snapshot. */
export function useItemsWithEffect<TPayload>(queue: Source<TPayload>): readonly QueueItem<TPayload>[] {
  const [, forceRender] = React.useReducer((count: number) => count + 1, 0);
  const items = queue.getItems();
  const rendered = React.useRef(items);
  rendered.current = items;
  React.useEffect(() => {
    const check = () => {
      // getItems() returns the same array until something changes.
      if (queue.getItems() !== rendered.current) forceRender();
    };
    const unsubscribe = queue.subscribe(check);
    // Catch changes made between render and subscription.
    check();
    return unsubscribe;
  }, [queue]);
  return items;
}

const builtInSyncExternalStore = (React as unknown as { useSyncExternalStore?: UseSyncExternalStore })
  .useSyncExternalStore;

/**
 * The queue's items and a count per status, re-rendering on every change.
 * Uses `useSyncExternalStore` on React 18+ and an effect subscription on
 * React 16.8 and 17.
 */
export function useQueueItems<TPayload = unknown>(queue: Source<TPayload>): QueueItemsState<TPayload> {
  const items = builtInSyncExternalStore
    ? useItemsWithSyncExternalStore(queue, builtInSyncExternalStore)
    : useItemsWithEffect(queue);
  return React.useMemo(() => ({ items, counts: countItems(items) }), [items]);
}
