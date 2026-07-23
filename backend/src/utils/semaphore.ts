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

export class Semaphore {
  private active = 0;
  private readonly queue: Array<(release: Release) => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1');
  }

  /** Acquire a permit. Resolves with a release function; call it exactly once. */
  acquire(): Promise<Release> {
    return new Promise<Release>((resolve) => {
      this.queue.push(resolve);
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

  async acquire(key: string): Promise<Release> {
    let sem = this.map.get(key);
    if (!sem) {
      sem = new Semaphore(this.perKeyMax);
      this.map.set(key, sem);
    }
    const release = await sem.acquire();
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
