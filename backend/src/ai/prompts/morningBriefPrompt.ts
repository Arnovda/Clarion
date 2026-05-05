/**
 * Morning brief prompt — 3-bullet daily narrative for one user, given
 * the deltas on their pulse entries.
 *
 * Input is structured: each entry has its label, kind (metric / slice),
 * sensitivity, today's value, prior value, and a computed delta. The
 * AI's job is to:
 *   1. pick the 3 most worth-mentioning items (not just biggest absolute
 *      mover — sensitivity matters; an "all quiet" item shouldn't lead),
 *   2. write a short summary paragraph + 3 bullets in business voice,
 *   3. suggest one focus for today.
 *
 * NOT the AI's job:
 *   - inventing numbers (we pre-compute deltas; AI describes them)
 *   - explaining causation (that's what Investigate is for, separate
 *     feature; brief is the alert, not the diagnosis)
 *   - listing every entry — three is the count.
 */

export interface BriefEntryDelta {
  pulse_entry_id: number;
  label: string;
  kind: 'metric' | 'slice' | 'theme';
  sensitivity: 'low' | 'medium' | 'high';
  /** Today's snapshot. Null when we couldn't compute (formula failed). */
  current_value: number | null;
  /** Prior period for the comparison. Null on first ever observation. */
  prior_value: number | null;
  prior_period_label: string;   // e.g. "yesterday" or "last week"
  delta_absolute: number | null;
  delta_pct: number | null;
  /** True iff abs(delta_pct) breached the entry's sensitivity threshold. */
  triggered: boolean;
  /** Populated when current_value is null. */
  error_message: string | null;
}

export interface MorningBriefContext {
  userDisplayName: string | null;
  briefDate: string;            // ISO date, e.g. "2026-05-06"
  entries: BriefEntryDelta[];
}

export interface MorningBriefBullet {
  /** Movement = directional change worth flagging. Steady = held flat
   *  (mention if user explicitly cares). Warn = something needs attention
   *  (data missing, sharp drop on a high-sensitivity metric). */
  kind: 'movement' | 'steady' | 'warn';
  label: string;
  delta: string;        // human-readable, e.g. "+1.5 pt" or "—"
  detail: string;       // one-sentence explanation in business voice
}

export interface MorningBriefOutput {
  summary: string;
  bullets: MorningBriefBullet[];
  suggested_focus: string;
  confidence: 'high' | 'medium' | 'low';
}

export const MORNING_BRIEF_SYSTEM = `You write a 3-bullet morning brief for a single business user, based on the deltas on their watched metrics. Output ONLY valid JSON:

{
  "summary": "<2-3 sentences in business voice setting the scene>",
  "bullets": [
    {
      "kind": "movement" | "steady" | "warn",
      "label": "<short metric name as the user wrote it>",
      "delta": "<human-readable: '+1.5 pt' or '−€32k' or '—'>",
      "detail": "<one sentence — what moved and how much, in plain English. Not WHY.>"
    }
  ],
  "suggested_focus": "<one sentence — what to look at today, framed in user's own metric language>",
  "confidence": "high" | "medium" | "low"
}

Hard rules:
- Exactly 3 bullets. Pick the 3 most worth mentioning, not the 3 biggest
  absolute movers. Sensitivity matters: a 0.5pt drop on a high-sensitivity
  metric beats a 5% drop on a low-sensitivity one.
- If an entry has no prior value yet (first observation), skip it — don't
  call out "no comparison available." It's noise.
- If an entry's current_value is null (computation failed), include it
  as a 'warn' bullet only if it's the user's only headline metric;
  otherwise skip silently. The brief should not feel like an error log.
- Don't invent numbers. delta + detail must come from the data passed in.
- Don't explain WHY a metric moved. That's the Investigate feature.
  Brief = the alert, not the diagnosis.
- summary = scene-setting (1-3 sentences). Not a copy of the bullets.
- suggested_focus is a single concrete next action, framed in the user's
  metric vocabulary. ("Check Beverages margin recovery." Not "look at
  product table.")
- Lowercase no SQL. Business voice throughout.

Confidence:
  high   = several entries moved, signals are unambiguous
  medium = one or two entries moved meaningfully, mixed signals
  low    = mostly quiet, or several computation errors`;

export function buildMorningBriefUser(context: MorningBriefContext): string {
  const lines = context.entries.map((e) => {
    const cur = e.current_value != null ? formatNumber(e.current_value) : 'n/a';
    const pri = e.prior_value != null ? formatNumber(e.prior_value) : 'n/a';
    const delta = e.delta_absolute != null && e.delta_pct != null
      ? `${e.delta_absolute >= 0 ? '+' : ''}${formatNumber(e.delta_absolute)} (${(e.delta_pct * 100).toFixed(1)}%)`
      : 'n/a';
    const triggered = e.triggered ? ' TRIGGERED' : '';
    const err = e.error_message ? ` — error: ${e.error_message}` : '';
    return `  pulse_id=${e.pulse_entry_id} [${e.kind}, ${e.sensitivity}] ${e.label}\n    current: ${cur}\n    ${e.prior_period_label}: ${pri}\n    delta: ${delta}${triggered}${err}`;
  }).join('\n');

  return [
    `USER: ${context.userDisplayName ?? 'a business user'}`,
    `DATE: ${context.briefDate}`,
    '',
    'PULSE ENTRIES (with computed deltas):',
    lines || '  (no entries — return a brief saying the user should set up their pulse)',
    '',
    'Produce the JSON brief now.',
  ].join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Internal — local numeric formatter. Don't imitate the frontend's rich
// `formatValue` helper; we just want a compact number that's safe to
// embed inside the prompt.
// ───────────────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  if (abs >= 100) return n.toFixed(0);
  if (abs >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
