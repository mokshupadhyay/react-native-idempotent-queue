import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { countItems, useItemsWithEffect, useQueueItems, type QueueItemsState } from '../hook';
import { createIdempotentQueue } from '../queue';
import { createMemoryStorage } from '../storage';
import type { IdempotentQueue, QueueItem } from '../types';
import { flushMicrotasks } from './support/fakeClock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React 19 marks react-test-renderer deprecated; the warning is expected and only that one is hidden.
const consoleError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    consoleError(...args);
  });
});
afterAll(() => jest.restoreAllMocks());

function setup() {
  const answers: Array<() => void> = [];
  const queue = createIdempotentQueue({
    storage: createMemoryStorage(),
    send: () => new Promise<void>((resolve) => answers.push(resolve)),
    generateKey: (() => {
      let n = 0;
      return () => `k${++n}`;
    })(),
  });
  return { queue, answers };
}

function render(queue: IdempotentQueue, useHook: (queue: IdempotentQueue) => QueueItemsState | readonly QueueItem[]) {
  const renders: Array<QueueItemsState | readonly QueueItem[]> = [];
  function Probe() {
    renders.push(useHook(queue));
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  return { renders, renderer };
}

const settle = () =>
  act(async () => {
    await flushMicrotasks();
  });

describe('useQueueItems', () => {
  it('re-renders with items and counts as the queue changes', async () => {
    const { queue, answers } = setup();
    const { renders, renderer } = render(queue, useQueueItems);
    expect(renders[renders.length - 1]).toEqual({
      items: [],
      counts: { pending: 0, inflight: 0, succeeded: 0, failed: 0, dead: 0, total: 0 },
    });
    await act(async () => {
      await queue.start();
      await queue.enqueue({ payload: 1, key: 'a' });
      await queue.enqueue({ payload: 2, key: 'b' });
    });
    await settle();
    let last = renders[renders.length - 1] as QueueItemsState;
    expect(last.counts).toMatchObject({ inflight: 1, pending: 1, total: 2 });
    await act(async () => {
      answers[0]();
    });
    await settle();
    last = renders[renders.length - 1] as QueueItemsState;
    expect(last.counts).toMatchObject({ succeeded: 1, inflight: 1, pending: 0 });
    expect(last.items.map((item) => item.key)).toEqual(['a', 'b']);
    act(() => renderer.unmount());
    answers[1]();
    await queue.stop();
  });
});

describe('the React 16.8-17 fallback', () => {
  it('subscribes in an effect and picks up changes made before subscribing', async () => {
    const { queue, answers } = setup();
    const { renders, renderer } = render(queue, useItemsWithEffect);
    expect(renders[renders.length - 1]).toEqual([]);
    await act(async () => {
      await queue.start();
      await queue.enqueue({ payload: 1 });
    });
    await settle();
    expect((renders[renders.length - 1] as QueueItem[]).map((item) => item.status)).toEqual(['inflight']);
    await act(async () => {
      answers[0]();
    });
    await settle();
    expect((renders[renders.length - 1] as QueueItem[]).map((item) => item.status)).toEqual(['succeeded']);
    act(() => renderer.unmount());
    await queue.stop();
  });

  it('does not re-render for events that leave the items unchanged', async () => {
    const { queue } = setup();
    await queue.load();
    const { renders, renderer } = render(queue, useItemsWithEffect);
    const before = renders.length;
    await act(async () => {
      await queue.discard('missing');
    });
    expect(renders.length).toBe(before);
    act(() => renderer.unmount());
  });
});

describe('countItems', () => {
  it('counts every status', () => {
    const base = { id: '', key: '', payload: 0, attempts: 0, sequence: 0, createdAt: 0, updatedAt: 0, nextAttemptAt: 0 };
    const items = (['pending', 'dead', 'dead', 'failed'] as const).map((status, i) => ({ ...base, id: `${i}`, status }));
    expect(countItems(items)).toEqual({ pending: 1, inflight: 0, succeeded: 0, failed: 1, dead: 2, total: 4 });
  });
});
