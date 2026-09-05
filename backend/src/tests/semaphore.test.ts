import { describe, it, expect } from 'vitest';
import { Semaphore, KeyedSemaphore } from '../utils/semaphore';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Semaphore', () => {
  it('bounds concurrency to max', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBe(2);
    expect(sem.inUse).toBe(0);
    expect(sem.waiting).toBe(0);
  });

  it('queues callers past the limit and releases FIFO', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    let secondAcquired = false;
    const p2 = sem.acquire().then((r) => { secondAcquired = true; return r; });
    await tick();
    expect(secondAcquired).toBe(false); // blocked behind r1
    r1();
    const r2 = await p2;
    expect(secondAcquired).toBe(true);
    r2();
  });

  it('rejects an invalid max', () => {
    expect(() => new Semaphore(0)).toThrow();
  });
});

describe('KeyedSemaphore', () => {
  it('isolates budgets per key', async () => {
    const ks = new KeyedSemaphore(1);
    const a = await ks.acquire('tenant-1');
    // Different key is not blocked by tenant-1's held permit.
    let bAcquired = false;
    await ks.acquire('tenant-2').then((r) => { bAcquired = true; r(); });
    expect(bAcquired).toBe(true);
    a();
  });

  it('prunes idle keys so the map stays bounded', async () => {
    const ks = new KeyedSemaphore(2);
    const r = await ks.acquire('t1');
    expect(ks.size).toBe(1);
    r();
    expect(ks.size).toBe(0);
  });
});

describe('Semaphore acquire timeout (assessment 11-7)', () => {
  it('a waiter that gets no permit in time is rejected and leaves the queue', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    await expect(sem.acquire(20)).rejects.toThrow(/No execution slot/);
    expect(sem.waiting).toBe(0);
    // The permit is still held by the first caller and still releasable.
    expect(sem.inUse).toBe(1);
    release();
    expect(sem.inUse).toBe(0);
    // A later caller is served normally — the timed-out waiter left no debris.
    const r2 = await sem.acquire(20);
    r2();
  });

  it('a waiter served before its deadline is not rejected afterwards', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const pending = sem.acquire(200);
    release();
    const r2 = await pending;
    await new Promise((r) => setTimeout(r, 250));
    r2();
    expect(sem.inUse).toBe(0);
  });

  it('keyed: a timed-out waiter does not pin an idle key', async () => {
    const keyed = new KeyedSemaphore(1);
    const release = await keyed.acquire('t1');
    await expect(keyed.acquire('t1', 20)).rejects.toThrow();
    release();
    // The key was pruned when its last permit was released; acquiring again works.
    const r2 = await keyed.acquire('t1', 20);
    r2();
  });
});
