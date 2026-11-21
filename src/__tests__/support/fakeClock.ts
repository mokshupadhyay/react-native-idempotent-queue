import type { QueueTimers } from '../../types';

/**
 * Drains pending promise callbacks without letting real time pass. The queue's
 * longest chain between two timer callbacks is a few dozen ticks.
 */
export async function flushMicrotasks(rounds = 400): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface Timer {
  at: number;
  order: number;
  callback: () => void;
  owner: string;
}

/**
 * A fake clock with timers grouped by owner. Killing an owner drops its
 * timers and ignores the ones it sets later, which is how a crashed process
 * stops: its storage writes never land and its requests never answer.
 */
export class FakeClock {
  now = 0;
  private order = 0;
  private timers = new Map<number, Timer>();
  private dead = new Set<string>();

  timersFor(owner: string): QueueTimers {
    return {
      setTimeout: (callback, ms) => {
        const id = ++this.order;
        if (!this.dead.has(owner)) {
          this.timers.set(id, { at: this.now + Math.max(0, ms || 0), order: id, callback, owner });
        }
        return id;
      },
      clearTimeout: (handle) => {
        this.timers.delete(handle as number);
      },
    };
  }

  kill(owner: string): void {
    this.dead.add(owner);
    this.timers.forEach((timer, id) => {
      if (timer.owner === owner) this.timers.delete(id);
    });
  }

  isDead(owner: string): boolean {
    return this.dead.has(owner);
  }

  pending(): number {
    return this.timers.size;
  }

  /** Runs every timer due within `ms`, in order, draining promises after each. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await flushMicrotasks();
      let next: [number, Timer] | undefined;
      this.timers.forEach((timer, id) => {
        if (timer.at > target) return;
        if (!next || timer.at < next[1].at || (timer.at === next[1].at && timer.order < next[1].order)) {
          next = [id, timer];
        }
      });
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].callback();
    }
    this.now = target;
    await flushMicrotasks();
  }
}

/** Deterministic `random()` in [0, 1) from a seed (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
