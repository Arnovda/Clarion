/**
 * Shared investigation types — used by /investigate page, /query chat
 * (when in investigate mode), and the InvestigationView renderer.
 *
 * Mirrors the backend SSE event shape from POST /api/investigations.
 */

export interface InvestigationStep {
  id: number;
  position: number;
  hypothesis: string;
  query_sql: string | null;
  finding: string | null;
  result_preview: Array<Record<string, unknown>> | null;
  result_row_count: number | null;
  status: 'running' | 'success' | 'failed' | 'skipped';
  error_message: string | null;
}

export interface Investigation {
  id: number;
  question: string;
  focus: string | null;
  status: 'running' | 'concluded' | 'failed' | 'cancelled';
  conclusion: string | null;
  conclusion_confidence: 'high' | 'medium' | 'low' | null;
  /** AI-written next questions, set on conclude. May be absent on older
   *  rows / clients — callers should fall back to a heuristic. */
  conclusion_followups?: string[];
  failure_reason: string | null;
  steps: InvestigationStep[];
}

export type InvestigationStreamStatus =
  | 'idle' | 'starting' | 'running' | 'done' | 'failed';

/** Backend SSE event union for the investigate stream. */
export type InvestigationSseEvent =
  | { type: 'step_started';   step: InvestigationStep }
  | { type: 'step_completed'; step: InvestigationStep }
  | { type: 'concluded';      investigation: Investigation }
  | { type: 'failed';         investigation: Investigation; reason: string };

/**
 * Merge a step into the list, replacing any existing entry with the same
 * id or position. The agent re-emits a step on each status change
 * (running → success/failed) so we replace, never duplicate.
 */
export function upsertStep(prev: InvestigationStep[], step: InvestigationStep): InvestigationStep[] {
  const idx = prev.findIndex((s) => s.id === step.id || s.position === step.position);
  if (idx === -1) return [...prev, step];
  const next = [...prev];
  next[idx] = step;
  return next;
}
