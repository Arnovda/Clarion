import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStreamWithRetry, isOverloadedError } from '../ai/AIService';

/** An error shaped the way the SDK throws it: `.status` is what we branch on. */
function apiError(status: number, type?: string) {
  const e = new Error(`${status} {"type":"error","error":{"type":"${type ?? 'api_error'}"}}`) as Error & { status: number; type?: string };
  e.status = status;
  if (type) e.type = type;
  return e;
}

/**
 * A fake stream that either yields `events` or throws `failWith` — and, when
 * `failAfter` is set, throws only AFTER that many events were yielded (the
 * mid-stream case a retry must never touch).
 */
function fakeStream(opts: { events?: string[]; failWith?: Error; failAfter?: number }) {
  return {
    async *[Symbol.asyncIterator]() {
      const events = opts.events ?? [];
      for (let i = 0; i < events.length; i++) {
        if (opts.failWith && opts.failAfter !== undefined && i === opts.failAfter) throw opts.failWith;
        yield events[i];
      }
      if (opts.failWith && (opts.failAfter === undefined || opts.failAfter >= events.length)) throw opts.failWith;
    },
  };
}

async function drain<E>(it: AsyncIterable<E>): Promise<E[]> {
  const out: E[] = [];
  for await (const e of it) out.push(e);
  return out;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Run `p` while advancing fake timers so the backoff sleeps resolve. */
async function withBackoff<T>(p: Promise<T>): Promise<T> {
  const settled = p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
  await vi.runAllTimersAsync();
  const r = await settled;
  if (r.ok) return r.v;
  throw r.e;
}

describe('isOverloadedError', () => {
  it('recognises a 529 by status and by type', () => {
    expect(isOverloadedError(apiError(529, 'overloaded_error'))).toBe(true);
    expect(isOverloadedError({ status: 529 })).toBe(true);
    expect(isOverloadedError({ error: { type: 'overloaded_error' } })).toBe(true);
  });
  it('does not mistake other failures for overload', () => {
    expect(isOverloadedError(apiError(400))).toBe(false);
    expect(isOverloadedError(apiError(500))).toBe(false);
    expect(isOverloadedError(new Error('Binder Error'))).toBe(false);
    expect(isOverloadedError(undefined)).toBe(false);
  });
});

describe('openStreamWithRetry', () => {
  it('passes a healthy stream through untouched, every event exactly once', async () => {
    const make = vi.fn(() => fakeStream({ events: ['a', 'b', 'c'] }));
    const opened = await openStreamWithRetry(make, { callLabel: 't' });
    expect(await drain(opened.events)).toEqual(['a', 'b', 'c']);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('retries a 529 that arrives before any event, then delivers the events once', async () => {
    // The production case: the SDK's own attempts exhausted, 529 on open.
    const make = vi.fn()
      .mockReturnValueOnce(fakeStream({ failWith: apiError(529, 'overloaded_error') }))
      .mockReturnValueOnce(fakeStream({ events: ['x', 'y'] }));
    const opened = await withBackoff(openStreamWithRetry(make, { callLabel: 't' }));
    expect(await drain(opened.events)).toEqual(['x', 'y']);
    expect(make).toHaveBeenCalledTimes(2);
    // The real stream handed back is the one that worked, not the dead one.
    expect(opened.stream).toBe(make.mock.results[1].value);
  });

  it('also retries 503 / 500 / 429 — the same set callClaude retries', async () => {
    for (const status of [503, 500, 429]) {
      const make = vi.fn()
        .mockReturnValueOnce(fakeStream({ failWith: apiError(status) }))
        .mockReturnValueOnce(fakeStream({ events: ['ok'] }));
      const opened = await withBackoff(openStreamWithRetry(make, { callLabel: 't' }));
      expect(await drain(opened.events), String(status)).toEqual(['ok']);
      expect(make, String(status)).toHaveBeenCalledTimes(2);
    }
  });

  it('does NOT retry a 400 — that is the request, not capacity', async () => {
    const make = vi.fn(() => fakeStream({ failWith: apiError(400) }));
    await expect(openStreamWithRetry(make, { callLabel: 't' })).rejects.toThrow('400');
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('never retries once an event has been consumed — that would replay output', async () => {
    // A 529 after the first event cannot happen in practice, but a 5xx
    // mid-stream can; retrying then would stream the same text twice.
    const make = vi.fn(() => fakeStream({ events: ['a', 'b'], failWith: apiError(503), failAfter: 1 }));
    const opened = await openStreamWithRetry(make, { callLabel: 't' });
    await expect(drain(opened.events)).rejects.toThrow('503');
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('gives up after the backoff schedule and reports the last error', async () => {
    const make = vi.fn(() => fakeStream({ failWith: apiError(529, 'overloaded_error') }));
    await expect(withBackoff(openStreamWithRetry(make, { callLabel: 't' }))).rejects.toThrow('529');
    // MAX_RETRIES = 3 → four attempts in total.
    expect(make).toHaveBeenCalledTimes(4);
  });

  it('stops retrying the moment the asker has aborted', async () => {
    const ac = new AbortController();
    const make = vi.fn(() => {
      ac.abort(); // the user pressed Stop while the first attempt was failing
      return fakeStream({ failWith: apiError(529, 'overloaded_error') });
    });
    await expect(openStreamWithRetry(make, { callLabel: 't', abortSignal: ac.signal })).rejects.toThrow('529');
    expect(make).toHaveBeenCalledTimes(1);
  });
});
