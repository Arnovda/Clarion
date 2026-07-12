/**
 * runInvestigation — fetch-streamed POST /api/investigations driver.
 *
 * Lifted out of <InvestigationPanel> so the /query chat can drive an
 * investigate run without mounting the whole panel. Same protocol,
 * same SSE event shape (see investigationTypes.ts).
 *
 * Transport is the shared streamSSE helper (lib/sse.ts); this module
 * keeps the investigation-specific error shaping: a non-OK response is
 * surfaced as a synthetic 'failed' event (with the server's JSON error
 * message when present) rather than a thrown error, and an abort (panel
 * closed / unmount) returns quietly.
 */

import api from '@/lib/api';
import { streamSSE, SSEHttpError } from '@/lib/sse';
import type { InvestigationSseEvent } from './investigationTypes';

interface RunOpts {
  question: string;
  focus: string | null;
  dataProductId: number;
  pulseEntryId: number | null;
  briefId: number | null;
  signal: AbortSignal;
  onEvent: (e: InvestigationSseEvent) => void;
}

export async function runInvestigation(opts: RunOpts): Promise<void> {
  const baseUrl = (api.defaults?.baseURL ?? '/api').replace(/\/$/, '');
  try {
    await streamSSE(`${baseUrl}/investigations`, {
      body: {
        question: opts.question,
        focus: opts.focus,
        data_product_id: opts.dataProductId,
        pulse_entry_id: opts.pulseEntryId,
        brief_id: opts.briefId,
      },
      signal: opts.signal,
      onEvent: (evt) => opts.onEvent(evt as InvestigationSseEvent),
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return; // caller cancelled
    if (err instanceof SSEHttpError) {
      let reason = `HTTP ${err.status}`;
      try { reason = JSON.parse(err.detail).error ?? reason; } catch { /* ignore */ }
      // We don't have an Investigation object yet at this stage — emit a
      // failed event with a synthetic placeholder so the renderer can
      // show the failure banner. The runtime cast keeps the union honest.
      opts.onEvent({
        type: 'failed',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        investigation: null as any,
        reason,
      });
      return;
    }
    throw err; // network / stream errors propagate to the caller, as before
  }
}
