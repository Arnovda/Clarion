/**
 * Server-Sent Events bootstrap — the one place the SSE header dance and the
 * write-safely-to-a-maybe-disconnected-client logic lives.
 *
 * Before this helper the identical five-line block (Content-Type +
 * Cache-Control + Connection + flushHeaders + a local `emit`) was copy-pasted
 * ~12 times across seven route files, each with slightly different
 * error-swallowing. Use `startSSE(res)` instead.
 *
 * Usage:
 *   const sse = startSSE(res);
 *   sse.emit({ type: 'phase', text: 'Working…' });
 *   ...
 *   sse.end();               // closes the stream (safe to call twice)
 *   if (sse.closed) ...      // client disconnected — stop doing work
 *   sse.signal               // fires when the CLIENT went away — hand it to
 *                            // any long call (an Anthropic stream) so a
 *                            // user's Stop actually stops the work
 */
import type { Response } from 'express';
import { clientAbort } from '../utils/requestAbort';

export interface SseStream {
  /** Write one `data:` event. Safe after client disconnect (no-op + sets closed). */
  emit: (data: object) => void;
  /** End the response. Idempotent. */
  end: () => void;
  /** True once the client disconnected or end() was called. */
  readonly closed: boolean;
  /**
   * Aborted when the CLIENT disconnects — a user pressing Stop, a closed tab,
   * a navigation. Deliberately NOT aborted by our own `end()`: by then the
   * work is finished and trailing best-effort calls (persisting, usage
   * accounting) must still run.
   *
   * Pass it to anything expensive the request is driving. Without it a Stop
   * only stops the browser listening: the model keeps generating and the
   * tenant keeps paying for an answer nobody will see.
   */
  readonly signal: AbortSignal;
}

export interface SseOptions {
  /**
   * Site-specific header overrides/additions, applied after the defaults and
   * before flushHeaders. E.g. `{ 'Cache-Control': 'no-cache, no-transform' }`.
   */
  headers?: Record<string, string>;
}

export function startSSE(res: Response, opts?: SseOptions): SseStream {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering (nginx / Azure ingress) so events flush per-write
  // instead of arriving in bursts. Harmless where no such proxy exists.
  res.setHeader('X-Accel-Buffering', 'no');
  for (const [name, value] of Object.entries(opts?.headers ?? {})) {
    res.setHeader(name, value);
  }
  res.flushHeaders();

  let closed = false;
  // Only a CLIENT-side disconnect cancels the work: `end()` settles the
  // abort first, so the 'close' that follows our own end() is ignored.
  const abort = clientAbort(res);
  res.on('close', () => { closed = true; });

  return {
    emit(data: object): void {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true; // client went away mid-write
      }
    },
    end(): void {
      abort.settle();
      if (closed) return;
      closed = true;
      try { res.end(); } catch { /* already gone */ }
    },
    get closed(): boolean {
      return closed;
    },
    get signal(): AbortSignal {
      return abort.signal;
    },
  };
}
