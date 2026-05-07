/**
 * runInvestigation — fetch-streamed POST /api/investigations driver.
 *
 * Lifted out of <InvestigationPanel> so the /query chat can drive an
 * investigate run without mounting the whole panel. Same protocol,
 * same SSE event shape (see investigationTypes.ts).
 *
 * The browser's EventSource doesn't support POST, so we use
 * `fetch(.., { body }).body.getReader()` and parse the data: lines
 * ourselves. Same approach as /query/think.
 */

import api from '@/lib/api';
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
  const token = (typeof window !== 'undefined') ? localStorage.getItem('clarion_token') ?? '' : '';
  const res = await fetch(`${baseUrl}/investigations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      question: opts.question,
      focus: opts.focus,
      data_product_id: opts.dataProductId,
      pulse_entry_id: opts.pulseEntryId,
      brief_id: opts.briefId,
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    let reason = `HTTP ${res.status}`;
    try { reason = (await res.json()).error ?? reason; } catch { /* ignore */ }
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

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        const evt = JSON.parse(dataLine.slice(6)) as InvestigationSseEvent;
        opts.onEvent(evt);
      } catch { /* ignore malformed event */ }
    }
  }
}
