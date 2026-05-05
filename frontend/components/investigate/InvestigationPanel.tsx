'use client';

/**
 * <InvestigationPanel> — slide-over that runs and renders a "why?"
 * agent loop.
 *
 * Two modes:
 *   - "starting"  : we have a question + product, but the SSE stream
 *                   hasn't begun yet
 *   - "running"   : steps stream in live; each renders as a card with
 *                   spinner → finding
 *   - "concluded" : final summary at the top, full trail below
 *
 * Renders nothing when not opened — the parent controls visibility
 * via the `open` prop.
 *
 * Entry points wired today:
 *   - Morning brief bullets (each bullet has a "Why?" button)
 *   - Standalone /investigate page (free-form question, pick product)
 *
 * Future entry points (same component, different prop wiring):
 *   - Ask AI answer cards
 *   - Pulse panel entries
 *   - Dashboard widget drill-down
 */

import { useEffect, useRef, useState } from 'react';
import {
  X, Sparkles, Loader2, AlertCircle, Check, ChevronDown, ChevronUp,
  Search, ArrowRight,
} from 'lucide-react';
import { format as sqlFormatter } from 'sql-formatter';
import api from '@/lib/api';

interface Step {
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

interface Investigation {
  id: number;
  question: string;
  focus: string | null;
  status: 'running' | 'concluded' | 'failed' | 'cancelled';
  conclusion: string | null;
  conclusion_confidence: 'high' | 'medium' | 'low' | null;
  failure_reason: string | null;
  steps: Step[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** What to investigate. If `id` is set, we replay an existing
   *  investigation (no new SSE stream). Otherwise we kick off a new
   *  run from the question + product context. */
  question?: string;
  focus?: string | null;
  dataProductId?: number;
  pulseEntryId?: number | null;
  briefId?: number | null;
  /** Replay an already-completed investigation. */
  existingId?: number;
}

export default function InvestigationPanel({
  open, onClose,
  question, focus, dataProductId, pulseEntryId, briefId,
  existingId,
}: Props) {
  const [investigation, setInvestigation] = useState<Investigation | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [streamStatus, setStreamStatus] = useState<'idle' | 'starting' | 'running' | 'done' | 'failed'>('idle');
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Side-effect: kick off the right path when opened ────────────────────
  useEffect(() => {
    if (!open) return;

    if (existingId) {
      // Replay — no new run.
      setStreamStatus('starting');
      api.get(`/investigations/${existingId}`)
        .then((res) => {
          const inv = res.data.data as Investigation;
          setInvestigation(inv);
          setSteps(inv.steps);
          setStreamStatus(inv.status === 'concluded' ? 'done' : inv.status === 'failed' ? 'failed' : 'running');
        })
        .catch((err) => {
          setStreamStatus('failed');
          setErrorReason(err?.message ?? 'Failed to load');
        });
      return;
    }

    if (!question || !dataProductId) return;

    // New run — POST + consume SSE.
    setStreamStatus('starting');
    setErrorReason(null);
    setInvestigation(null);
    setSteps([]);

    const controller = new AbortController();
    abortRef.current = controller;

    void runInvestigation({
      question,
      focus: focus ?? null,
      dataProductId,
      pulseEntryId: pulseEntryId ?? null,
      briefId: briefId ?? null,
      signal: controller.signal,
      onEvent: (evt) => {
        if (evt.type === 'step_started') {
          setSteps((prev) => upsertStep(prev, evt.step));
          setStreamStatus('running');
        } else if (evt.type === 'step_completed') {
          setSteps((prev) => upsertStep(prev, evt.step));
        } else if (evt.type === 'concluded') {
          setInvestigation(evt.investigation);
          setSteps(evt.investigation.steps);
          setStreamStatus('done');
        } else if (evt.type === 'failed') {
          setErrorReason(evt.reason);
          setStreamStatus('failed');
        }
      },
    });

    return () => { controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existingId]);

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-[640px] bg-bg border-l border-line shadow-2xl flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-5 py-3.5 border-b border-line bg-raised">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Search className="w-4 h-4 text-ocean" strokeWidth={1.75} />
              <span className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ocean">
                Investigation
              </span>
              <StatusPill status={streamStatus} />
            </div>
            <h2 className="font-display text-[18px] leading-snug text-ink">
              {question || investigation?.question || 'Investigating…'}
            </h2>
            {(focus || investigation?.focus) && (
              <p className="text-[12px] text-muted mt-1">
                <span className="font-mono uppercase tracking-[0.1em] text-[10px] text-muted-2 mr-1.5">Focus</span>
                {focus || investigation?.focus}
              </p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-soft text-muted hover:text-ink" title="Close">
            <X className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {/* Conclusion (when done) */}
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

        {/* Trail */}
        <div className="px-5 py-4">
          <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 mb-3">
            {steps.length === 0 ? 'Planning the first step…' : `Trail · ${steps.length} step${steps.length === 1 ? '' : 's'}`}
          </div>

          {steps.length === 0 && streamStatus === 'starting' && (
            <div className="flex items-center gap-2 text-[12.5px] text-muted py-4">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Reading the schema and your pulse to plan the first move…</span>
            </div>
          )}

          <div className="space-y-2">
            {steps.map((step) => (
              <StepCard key={step.id} step={step} />
            ))}
          </div>

          {streamStatus === 'running' && steps.length > 0 && (
            <div className="flex items-center gap-2 text-[12px] text-muted py-3 mt-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Deciding the next step…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Step card — renders one step's hypothesis, status, finding, and a
// collapsible SQL + sample preview.
// ───────────────────────────────────────────────────────────────────────────

function StepCard({ step }: { step: Step }) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="border border-line rounded-md overflow-hidden bg-raised">
      {/* Header row */}
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
        <button
          onClick={() => setShowDetails((v) => !v)}
          className="p-1 rounded hover:bg-soft text-muted-2"
          title={showDetails ? 'Hide details' : 'Show SQL + preview'}
        >
          {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Details */}
      {showDetails && (
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

function StepBadge({ step }: { step: Step }) {
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

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    starting:  { label: 'starting',  cls: 'bg-ocean/10 text-ocean' },
    running:   { label: 'running',   cls: 'bg-ocean/10 text-ocean' },
    done:      { label: 'concluded', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    failed:    { label: 'failed',    cls: 'bg-red-50 text-red-700 border-red-200' },
    idle:      { label: '',          cls: '' },
  };
  const v = map[status] ?? map.idle;
  if (!v.label) return null;
  return (
    <span className={`px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-[0.1em] rounded border ${v.cls}`}>
      {v.label}
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────────────

function upsertStep(prev: Step[], step: Step): Step[] {
  const idx = prev.findIndex((s) => s.id === step.id || s.position === step.position);
  if (idx === -1) return [...prev, step];
  const next = [...prev];
  next[idx] = step;
  return next;
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

// ───────────────────────────────────────────────────────────────────────────
// SSE driver — uses fetch streaming so we can POST + read events from
// the same response (EventSource doesn't support POST).
// ───────────────────────────────────────────────────────────────────────────

interface RunOpts {
  question: string;
  focus: string | null;
  dataProductId: number;
  pulseEntryId: number | null;
  briefId: number | null;
  signal: AbortSignal;
  onEvent: (e: SseEvent) => void;
}

type SseEvent =
  | { type: 'step_started'; step: Step }
  | { type: 'step_completed'; step: Step }
  | { type: 'concluded'; investigation: Investigation }
  | { type: 'failed'; investigation: Investigation; reason: string };

async function runInvestigation(opts: RunOpts) {
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
    opts.onEvent({ type: 'failed', investigation: null as never, reason });
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
        const evt = JSON.parse(dataLine.slice(6)) as SseEvent;
        opts.onEvent(evt);
      } catch { /* ignore malformed event */ }
    }
  }
}
