'use client';

/**
 * <InvestigationView> — pure renderer for an investigation trail.
 *
 * No state, no slide-over chrome, no SSE driver. Just shows whatever
 * the parent gives it: a list of steps, optional conclusion, status
 * pill. Used by:
 *   - <InvestigationPanel> (the slide-over wrapping this view)
 *   - The /query chat when the user's question routes to investigate
 *     mode (renders inside a chat message bubble)
 *
 * Visual structure:
 *   1. Conclusion banner (only when status === 'concluded')
 *   2. Failure banner (only when status === 'failed')
 *   3. Trail header + steps
 */

import { useState } from 'react';
import {
  Loader2, AlertCircle, ChevronDown, ChevronUp, ArrowRight,
} from 'lucide-react';
import { format as sqlFormatter } from 'sql-formatter';
import type {
  Investigation,
  InvestigationStep,
  InvestigationStreamStatus,
} from '@/lib/investigationTypes';

interface Props {
  investigation: Investigation | null;
  steps: InvestigationStep[];
  streamStatus: InvestigationStreamStatus;
  errorReason: string | null;
  /**
   * REQUIRED, same contract as app/query/thinking.tsx — see the SQL
   * VISIBILITY note there. Step cards expand to raw SQL + result previews;
   * CLAUDE.md's non-negotiable is "never show raw SQL to a business user",
   * and this view renders inside the chat bubble for every role. Required
   * rather than optional-defaulting-to-false so a new call site must make
   * the decision explicitly.
   */
  canSeeSql: boolean;
}

export default function InvestigationView({
  investigation, steps, streamStatus, errorReason, canSeeSql,
}: Props) {
  return (
    <div>
      {/* Conclusion banner */}
      {investigation?.status === 'concluded' && investigation.conclusion && (
        <div className="px-5 py-4 border-b border-line bg-ocean/[0.04]">
          <div className="flex items-baseline gap-2 mb-1.5">
            <span className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ocean">Conclusion</span>
            {investigation.conclusion_confidence && (
              <span className={`text-[10px] font-mono uppercase tracking-[0.1em] ${
                investigation.conclusion_confidence === 'low' ? 'text-amber-700' : 'text-muted-2'
              }`}>
                {investigation.conclusion_confidence} confidence
              </span>
            )}
          </div>
          <p className="font-display text-[15.5px] leading-relaxed text-ink m-0 whitespace-pre-wrap">
            {investigation.conclusion}
          </p>
        </div>
      )}

      {/* Failure */}
      {streamStatus === 'failed' && (
        <div className="px-5 py-4 border-b border-red-200 bg-red-50">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 text-red-600 flex-shrink-0" strokeWidth={1.75} />
            <div className="text-[13px] text-red-900">
              <div className="font-medium mb-0.5">Investigation failed</div>
              <div className="text-[12.5px]">
                {errorReason ?? investigation?.failure_reason ?? 'Unknown error'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Trail — suppressed when this is a rehydrated message from
          conversation history (status concluded/failed but no steps
          stored). Live runs always have at least one step by the time
          the stream concludes, so this only suppresses the empty
          "0 steps" header on reload. */}
      {!(steps.length === 0 && (streamStatus === 'done' || streamStatus === 'failed')) && (
        <div className="px-5 py-4">
          <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 mb-3">
            {steps.length === 0
              ? 'Planning the first step…'
              : `Trail · ${steps.length} step${steps.length === 1 ? '' : 's'}`}
          </div>

          {steps.length === 0 && streamStatus === 'starting' && (
            <div className="flex items-center gap-2 text-[12.5px] text-muted py-4">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Reading the schema and your pulse to plan the first move…</span>
            </div>
          )}

          <div className="space-y-2">
            {steps.map((step) => (
              <StepCard key={step.id} step={step} canSeeSql={canSeeSql} />
            ))}
          </div>

          {streamStatus === 'running' && steps.length > 0 && (
            <div className="flex items-center gap-2 text-[12px] text-muted py-3 mt-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Deciding the next step…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Step card — renders one step's hypothesis, status, finding, optional SQL
// ───────────────────────────────────────────────────────────────────────────

function StepCard({ step, canSeeSql }: { step: InvestigationStep; canSeeSql: boolean }) {
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div className="border border-line rounded-md overflow-hidden bg-raised">
      <div className="px-3 py-2.5 flex items-start gap-3">
        <StepBadge step={step} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-ink leading-snug">{step.hypothesis}</div>
          {step.finding && (
            <div className="text-[12.5px] text-ink-2 leading-relaxed mt-1.5">
              <ArrowRight className="w-3 h-3 inline-block mr-1 -mt-0.5 text-ocean" strokeWidth={1.75} />
              {step.finding}
            </div>
          )}
          {step.error_message && (
            <div className="text-[12px] text-red-700 leading-relaxed mt-1.5">
              <AlertCircle className="w-3 h-3 inline-block mr-1 -mt-0.5" strokeWidth={1.75} />
              {step.error_message}
            </div>
          )}
        </div>
        {canSeeSql && (
          <button
            onClick={() => setShowDetails((v) => !v)}
            className="p-1 rounded hover:bg-soft text-muted-2"
            title={showDetails ? 'Hide details' : 'Show SQL + preview'}
          >
            {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
      {canSeeSql && showDetails && (
        <div className="px-3 pb-3 border-t border-line bg-bg space-y-2 pt-2.5">
          {step.query_sql && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2 mb-1">Query</div>
              <pre className="text-[11px] font-mono bg-softer rounded px-2 py-1.5 overflow-x-auto leading-[1.5] text-ink-2">
                {prettySql(step.query_sql)}
              </pre>
            </div>
          )}
          {step.result_preview && step.result_preview.length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2 mb-1">
                Preview {step.result_row_count != null ? `· ${step.result_row_count} row${step.result_row_count === 1 ? '' : 's'}` : ''}
              </div>
              <PreviewTable rows={step.result_preview} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepBadge({ step }: { step: InvestigationStep }) {
  if (step.status === 'running') {
    return (
      <span className="flex-shrink-0 mt-0.5 w-6 h-6 rounded-full bg-ocean/10 flex items-center justify-center">
        <Loader2 className="w-3 h-3 text-ocean animate-spin" />
      </span>
    );
  }
  if (step.status === 'failed') {
    return (
      <span className="flex-shrink-0 mt-0.5 w-6 h-6 rounded-full bg-red-50 border border-red-200 flex items-center justify-center">
        <AlertCircle className="w-3 h-3 text-red-600" strokeWidth={1.75} />
      </span>
    );
  }
  return (
    <span className="flex-shrink-0 mt-0.5 w-6 h-6 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center text-[10px] font-mono text-emerald-700">
      {step.position}
    </span>
  );
}

function PreviewTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0) return null;
  const cols = Object.keys(rows[0]);
  return (
    <div className="overflow-x-auto border border-line rounded">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="bg-soft text-muted-2 text-left">
            {cols.map((c) => <th key={c} className="px-2 py-1 font-mono uppercase tracking-[0.06em] text-[9.5px]">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-line">
              {cols.map((c) => (
                <td key={c} className="px-2 py-1 font-mono text-ink-2 whitespace-nowrap">
                  {formatCell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function prettySql(sql: string): string {
  try { return sqlFormatter(sql, { language: 'duckdb', tabWidth: 2, keywordCase: 'lower' }); }
  catch { return sql; }
}
function formatCell(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toString() : v.toFixed(2);
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 37) + '…' : v;
  return JSON.stringify(v).slice(0, 50);
}
