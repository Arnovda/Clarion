/**
 * Client-disconnect → AbortSignal, for routes that drive expensive work.
 *
 * A user pressing Stop, closing the tab or navigating away severs the HTTP
 * connection. Without a signal that only stops the BROWSER listening: the
 * Anthropic stream keeps generating, the warehouse query keeps running, and
 * the tenant pays for an answer nobody will ever see.
 *
 * The one subtlety this exists to get right: `res.on('close')` fires on a
 * NORMAL completion too. Aborting there would cancel the tail of a request
 * that already succeeded — persistence, usage accounting, audit rows. So the
 * route calls `settle()` when it is done, and a `close` after that is a no-op.
 *
 *   const abort = clientAbort(res);
 *   try   { await something({ signal: abort.signal }); }
 *   finally { abort.settle(); }
 */
import type { Response } from 'express';

export interface ClientAbort {
  /** Aborted when the CLIENT went away before `settle()` was called. */
  readonly signal: AbortSignal;
  /** Mark the response as finished by us — later disconnects are ignored. */
  settle: () => void;
}

export function clientAbort(res: Response): ClientAbort {
  const controller = new AbortController();
  let settled = false;
  res.on('close', () => { if (!settled) controller.abort(); });
  return {
    get signal(): AbortSignal { return controller.signal; },
    settle(): void { settled = true; },
  };
}
