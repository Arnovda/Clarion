/**
 * streamSSE — shared consumption loop for the backend's SSE endpoints.
 *
 * The browser's EventSource doesn't support POST bodies or Authorization
 * headers, so every streaming surface (dashboards batch-execute, /query
 * think + repair, bus-matrix build/refresh, profiling, ingestion,
 * re-suggest, investigations) uses `fetch(...).body.getReader()` and
 * parses the `data: ` lines itself. This module is the single copy of
 * that transport loop; callers keep their own event-handling logic.
 *
 * Wire contract (matches backend/src — every emitter writes
 * `res.write('data: ' + JSON.stringify(evt) + '\n\n')`, plus occasional
 * `: keepalive\n\n` comment blocks which are ignored here):
 *   - events are blocks separated by a blank line ('\n\n')
 *   - each block's `data: `-prefixed line(s) are parsed as JSON
 *   - malformed / non-data lines are skipped silently
 *
 * Abort semantics: pass an AbortSignal. When it fires, the reader is
 * cancelled and the function throws a DOMException named 'AbortError'
 * (the same error fetch itself throws on pre-response abort), so callers
 * can uniformly ignore `err.name === 'AbortError'`.
 */

import { getToken } from '@/lib/auth';

/** Thrown when the server responds non-2xx (or with no body). */
export class SSEHttpError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** Response body text (often a JSON error payload), or statusText. */
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`HTTP ${status}`);
    this.name = 'SSEHttpError';
    this.status = status;
    this.detail = detail;
  }
}

export interface StreamSSEOptions {
  /** Defaults to 'POST' (the common case — EventSource can't POST). */
  method?: 'GET' | 'POST';
  /** JSON-serialised into the request body when provided. */
  body?: unknown;
  /** Called once per parsed `data: ` event. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEvent: (data: any) => void;
  /** Abort mid-stream (component unmount, user cancel). */
  signal?: AbortSignal;
  /** Extra request headers (merged over the defaults). */
  headers?: Record<string, string>;
}

export async function streamSSE(url: string, opts: StreamSSEOptions): Promise<void> {
  const { body, onEvent, signal, headers } = opts;
  const method = opts.method ?? 'POST';
  const token = getToken();

  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'text/event-stream',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok || !res.body) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new SSEHttpError(res.status, detail || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatchBlock = (block: string) => {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let evt: unknown;
      try { evt = JSON.parse(line.slice(6)); } catch { continue; /* skip malformed */ }
      onEvent(evt);
    }
  };

  // When the signal fires mid-stream, cancel the reader so the pending
  // read() settles promptly instead of waiting for the next chunk.
  const onAbort = () => { void reader.cancel().catch(() => { /* ignore */ }); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (block.trim()) dispatchBlock(block);
      }
      if (done) break;
    }
    // Flush a final, unterminated event — some proxies (Azure Container
    // Apps' Envoy) cut the stream before the trailing blank line lands.
    if (buffer.trim()) dispatchBlock(buffer);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  // Make aborts deterministic: even when reader.cancel() ended the loop
  // "cleanly" (read resolved done:true) rather than rejecting, callers
  // must not mistake an abort for a normal end-of-stream.
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}
