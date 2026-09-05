/**
 * Minimal async semaphore + keyed limiter.
 *
 * Used to bound how many heavy DuckDB queries run at once inside the shared
 * backend process. Without a cap, a burst of concurrent analytical scans each
 * claiming up to `memory_limit` of a 1 GiB replica OOM-kills the process and
 * takes down the API for every tenant (the "noisy neighbour" / blast-radius
 * risk). A global cap bounds total in-flight work; a per-key (per-tenant) cap
 * adds fairness so one tenant can't monopolise all the permits.
 *
 * Pure, dependency-free, unit-testable without a native build.
 */

export type Release = () => void;

/** Thrown by `acquire(timeoutMs)` when no permit frees up in time. */
export class SemaphoreTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`No execution slot became free within ${waitedMs} ms`);
    this.name = 'SemaphoreTimeoutError';
  }
}

export class Semaphore {
  private active = 0;
  private readonly queue: Array<(release: Release) => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1');
  }

  /**
   * Acquire a permit. Resolves with a release function; call it exactly once.
   *
   * `timeoutMs` (optional, 11-7 of the 2026-09-05 assessment): a caller that
   * has waited that long WITHOUT a permit is rejected with
   * `SemaphoreTimeoutError` and removed from the queue. Without a bound, a
   * burst that takes every permit leaves the next caller hanging for as
   * long as the permits are held — the per-query timeout only starts once a
   * permit is granted. A rejected waiter never holds a permit.
   */
  acquire(timeoutMs?: number): Promise<Release> {
    return new Promise<Release>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter = (release: Release) => {
        if (timer) clearTimeout(timer);
        resolve(release);
      };
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new SemaphoreTimeoutError(timeoutMs));
          }
        }, timeoutMs);
      }
      this.queue.push(waiter);
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.active < this.max && this.queue.length > 0) {
      this.active += 1;
      const resolve = this.queue.shift()!;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.dispatch();
      });
    }
  }

  /** Current number of held permits (for tests / diagnostics). */
  get inUse(): number {
    return this.active;
  }

  /** Number of callers waiting for a permit (for tests / diagnostics). */
  get waiting(): number {
    return this.queue.length;
  }
}

/**
 * A pool of independent semaphores keyed by an arbitrary string (e.g. a tenant
 * key). Each key gets its own concurrency budget. Idle keys are pruned when
 * their semaphore is fully released so the map can't grow unbounded across
 * many tenants.
 */
export class KeyedSemaphore {
  private readonly map = new Map<string, Semaphore>();

  constructor(private readonly perKeyMax: number) {}

  async acquire(key: string, timeoutMs?: number): Promise<Release> {
    let sem = this.map.get(key);
    if (!sem) {
      sem = new Semaphore(this.perKeyMax);
      this.map.set(key, sem);
    }
    let release: Release;
    try {
      release = await sem.acquire(timeoutMs);
    } catch (err) {
      // A timed-out waiter must not pin an otherwise idle key in the map.
      const s = this.map.get(key);
      if (s && s.inUse === 0 && s.waiting === 0) this.map.delete(key);
      throw err;
    }
    return () => {
      release();
      // Prune once fully idle to keep the map bounded.
      const s = this.map.get(key);
      if (s && s.inUse === 0 && s.waiting === 0) {
        this.map.delete(key);
      }
    };
  }

  /** For tests / diagnostics. */
  get size(): number {
    return this.map.size;
  }
}
