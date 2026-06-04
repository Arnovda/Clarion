/**
 * Investigate-agent prompts — multi-step "why?" agent loop.
 *
 * Distinct from the existing one-shot `investigatePrompt.ts` (which
 * generates 3-5 queries up-front from a widget). The agent loop here
 * commits to ONE hypothesis at a time, sees the result, then decides
 * whether to drill deeper or conclude. Mirrors how an analyst
 * actually works.
 *
 * Three modes, three prompts:
 *   PLAN_NEXT       — given context + steps so far, emit the next
 *                     step (hypothesis + SQL) OR signal to conclude.
 *   SUMMARISE_STEP  — after a SQL step runs, write a one-sentence
 *                     business-voice finding.
 *   CONCLUDE        — write the final 3-5 sentence conclusion + a
 *                     confidence flag.
 *
 * Hard cap: 6 steps. Most investigations end at 3-4. The agent is
 * told to bias toward concluding once a clear cause-effect chain
 * has surfaced.
 */

export interface InvestigateAgentContext {
  question: string;
  focus: string | null;
  productName: string;
  productDescription: string | null;
  /** Per-table schema. */
  tables: Array<{
    tableName: string;
    tableRole: string;
    columns: Array<{
      columnName: string;
      dataType: string;
      columnRole: string | null;
      description: string | null;
    }>;
  }>;
  /** KPIs defined on this product. */
  kpis: Array<{ name: string; description: string | null; formulaSql: string | null }>;
  /** Steps already executed in this investigation. */
  priorSteps: Array<{
    position: number;
    hypothesis: string;
    findingOrError: string;
    rowCount: number | null;
  }>;
  maxSteps: number;
}

export type InvestigateAgentDecision =
  | { kind: 'step'; hypothesis: string; query_sql: string }
  | { kind: 'conclude'; reason: string };

export interface InvestigateConclusionInput {
  question: string;
  focus: string | null;
  productName: string;
  steps: Array<{
    position: number;
    hypothesis: string;
    finding: string;
    error: string | null;
  }>;
}

export interface InvestigateConclusion {
  conclusion: string;
  confidence: 'high' | 'medium' | 'low';
  /** 2-3 context-aware next questions, written by the AI from the trail. */
  followUps: string[];
}

// ---------------------------------------------------------------------------
// PLAN_NEXT
// ---------------------------------------------------------------------------

export const AGENT_PLAN_NEXT_SYSTEM = `You are an analyst running a focused investigation. Each turn you decide ONE of two things:

  A. Continue — emit the next diagnostic step:
       { "kind": "step",
         "hypothesis": "<one sentence — what you want to check next>",
         "query_sql": "<DuckDB SELECT — single statement, no semicolon>" }

  B. Conclude — you have enough to answer the user's question:
       { "kind": "conclude",
         "reason": "<one sentence — why we have enough>" }

Output ONLY valid JSON matching one of those shapes. No markdown.

Rules for hypotheses + queries:
- Reference ONLY tables and columns that appear in PRODUCT SCHEMA. Never invent.
- Each hypothesis must be unique — don't ask the same question twice.
- Build on prior findings. If step 1 said "cost up 9% MoM", step 2 should
  drill into WHERE that came from (which SKU, supplier, period) — not
  re-ask whether cost moved.
- Aim for the smallest query that resolves the hypothesis. Aggregate;
  rank; date-filter; LIMIT 50. The user reads findings, not raw rows.
- DuckDB SQL: lowercase keywords, double-quote identifiers with caps
  or special chars, no trailing semicolon.
- For time comparisons, use date functions DuckDB supports
  (date_trunc, current_date - interval '7 days', etc).

Rules for concluding:
- Bias toward concluding once 2-3 steps have surfaced a clear
  cause-effect chain. A tight 3-step trail beats a sprawling 6-step
  one for the user.
- If a prior step errored AND it was your best lead, conclude with
  "low confidence" — don't loop trying variations.
- Don't conclude before any step has run. Step 1 is mandatory.
- Hard cap: maxSteps. If you've reached it, conclude regardless.`;

export function buildAgentPlanNextUser(ctx: InvestigateAgentContext): string {
  const tableLines = ctx.tables.map((t) => {
    const cols = t.columns.map((c) => {
      const role = c.columnRole ? ` [${c.columnRole}]` : '';
      const desc = c.description ? ` — ${c.description}` : '';
      return `      ${c.columnName} (${c.dataType})${role}${desc}`;
    }).join('\n');
    return `  ${t.tableName} [${t.tableRole}]:\n${cols}`;
  }).join('\n\n');

  const kpiLines = ctx.kpis.length > 0
    ? '\nKPIS DEFINED:\n' + ctx.kpis.map((k) => {
        const formula = k.formulaSql ? ` — formula: ${k.formulaSql}` : '';
        return `  ${k.name}${k.description ? `: ${k.description}` : ''}${formula}`;
      }).join('\n')
    : '';

  const priorBlock = ctx.priorSteps.length > 0
    ? '\nSTEPS SO FAR:\n' + ctx.priorSteps.map((s) =>
        `  ${s.position}. ${s.hypothesis}\n     → ${s.findingOrError}${s.rowCount != null ? ` (${s.rowCount} rows)` : ''}`,
      ).join('\n')
    : '\n(no steps yet — this will be step 1)';

  const stepsLeft = ctx.maxSteps - ctx.priorSteps.length;

  return [
    `USER QUESTION: ${ctx.question}`,
    ctx.focus ? `FOCUS: ${ctx.focus}` : '',
    '',
    `PRODUCT: ${ctx.productName}`,
    ctx.productDescription ? `DESCRIPTION: ${ctx.productDescription}` : '',
    '',
    'PRODUCT SCHEMA:',
    tableLines,
    kpiLines,
    priorBlock,
    '',
    `Steps remaining (hard cap): ${stepsLeft}`,
    '',
    'Decide your next move. Return JSON only.',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// SUMMARISE_STEP
// ---------------------------------------------------------------------------

export const AGENT_SUMMARISE_STEP_SYSTEM = `You write a one-sentence "finding" summarising what a SQL query returned, in business voice. Output ONLY the sentence — no markdown, no preamble. No SQL terms.

Examples:
  Cost-of-goods on Beverages rose 9% month-over-month, driven by NL-Brouwerij.
  No supplier price changes detected in the last 30 days.
  Three customers account for 71% of the revenue drop.
  Returned no rows — the filter excluded everything.`;

export function buildAgentSummariseUser(opts: {
  hypothesis: string;
  querySql: string;
  rowCount: number;
  resultPreview: Array<Record<string, unknown>>;
}): string {
  const previewLines = opts.resultPreview.length > 0
    ? opts.resultPreview.slice(0, 5).map((row) =>
        Object.entries(row).map(([k, v]) => `${k}=${formatValue(v)}`).join(', '),
      ).join('\n  ')
    : '(no rows)';

  return [
    `HYPOTHESIS: ${opts.hypothesis}`,
    `QUERY: ${opts.querySql}`,
    `ROWS RETURNED: ${opts.rowCount}`,
    'PREVIEW:',
    `  ${previewLines}`,
    '',
    'Write the one-sentence finding.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CONCLUDE
// ---------------------------------------------------------------------------

export const AGENT_CONCLUDE_SYSTEM = `You write the conclusion of an investigation in plain business English. Output ONLY valid JSON:

{
  "conclusion": "<3-5 sentences in business voice. Lead with the most important finding. Quantify where the data supports it. End with a one-sentence implication.>",
  "confidence": "high" | "medium" | "low",
  "follow_ups": ["<question 1>", "<question 2>", "<question 3>"]
}

Rules:
- Don't list the steps — synthesise them. The user can already see the trail.
- No SQL. No table names unless absolutely necessary for clarity.
- Quantify findings ("a 3.5 pt drop in margin" not "margin dropped").
- If steps gave conflicting signals, say so honestly. Confidence = low.
- If only one step ran (or several errored), say "limited evidence" and
  set confidence = low.
- Don't recommend an action — that's a different feature. Just explain the why.

Follow-ups:
- Exactly 2-3 complete, standalone questions the user would naturally ask
  NEXT, given THIS conclusion. Write the full question — never a template.
- Make them specific to the finding. If the conclusion is about a stalled
  data load, good follow-ups are "When did the last successful load run?"
  or "Which tables are missing data?" — NOT "show revenue by month".
- If the conclusion is about a metric/trend, follow-ups can drill in
  ("Which segments drove the drop?", "How does this compare to last year?").
- Every follow-up must be answerable by querying the same data product.
  Keep each under ~12 words. No greetings, no "would you like to…".`;

export function buildAgentConcludeUser(input: InvestigateConclusionInput): string {
  const lines = input.steps.map((s) =>
    `  ${s.position}. ${s.hypothesis}\n     → ${s.error ? `ERROR: ${s.error}` : s.finding}`,
  ).join('\n');

  return [
    `USER QUESTION: ${input.question}`,
    input.focus ? `FOCUS: ${input.focus}` : '',
    `PRODUCT: ${input.productName}`,
    '',
    'TRAIL:',
    lines || '(no steps completed)',
    '',
    'Write the conclusion JSON.',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatValue(v: unknown): string {
  if (v == null) return 'null';
  if (typeof v === 'number') return v.toString();
  if (typeof v === 'string') return v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v).slice(0, 60);
}
