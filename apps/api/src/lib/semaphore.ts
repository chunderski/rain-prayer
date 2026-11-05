/** A small counting semaphore: run(fn) waits for a free slot, so at most `max` fns run at once. */
export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
  setMax(n: number): void;
  readonly active: number;
  readonly waiting: number;
}

export function createSemaphore(max: number): Semaphore {
  let limit = Math.max(1, max);
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    while (active < limit && queue.length) {
      active++;
      queue.shift()!();
    }
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
        next();
      });
      try {
        return await fn();
      } finally {
        active--;
        next();
      }
    },
    setMax(n: number) {
      limit = Math.max(1, n);
      next();
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}
