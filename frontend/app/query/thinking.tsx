'use client';

/**
 * Two components for visualising what Claude is doing while a query runs.
 *
 * - `ThinkingBubble`: the PROGRESS TIMELINE — named steps in domain language
 *   ("Understanding your question" → "Looking at Sales, Receivables" →
 *   "Running the numbers" → "Writing the answer"), with the live reasoning
 *   streaming into a FIXED-HEIGHT, AUTO-SCROLLING pane under the active
 *   step. Owner feedback 2026-08-27: the first version clamped this to two
 *   lines, which made the reasoning impossible to actually follow — the
 *   pane now shows the full stream (~10 lines visible, pinned to the
 *   bottom, scrollback available) while the layout stays bounded. The
 *   component unmounts when the answer lands; the durable receipt is the
 *   answer card's trust line.
 * - `ThinkingPanel`:  the repair loop, framed as DILIGENCE — "Double-checking
 *   the result", not an incident log. Renders the loop's narrative events
 *   and the inline clarification input.
 *
 * Both consume ephemeral state that is never persisted to the conversation.
 *
 * SQL VISIBILITY — read before adding a prop or a call site.
 * These panels can show the generated SQL, the repair loop's diagnostic SQL
 * and its revised SQL. CLAUDE.md's non-negotiable is "never show raw SQL to
 * a business user"; the role table gives the show-query toggle to admin AND
 * analyst (owner decision 2026-08-27) and to nobody else. Both components
 * therefore take a REQUIRED `canSeeSql` flag and hide every SQL block when
 * it is false. Since the same date, the backend ALSO strips SQL/rows/raw
 * errors from the repair events for viewer roles — the prop is the second
 * fence, not the only one.
 *
 * The progress narrative (steps, table names, reasoning tail, row COUNTS,
 * clarifying questions) stays visible to everyone — it is what makes the
 * wait legible, and it carries no query text.
 */

import { useState, useEffect, useRef } from 'react';
import {
  AssistantIdentity, LiveThought, WorkStep, fmtElapsed, useNow,
} from '@/components/brand/AssistantKit';
import { formatSql } from './utils';
import { humanizeTableName } from '@/lib/humanize';
import type { RepairState } from './types';

// ─── Progress timeline ───────────────────────────────────────────────────────

type StepState = 'done' | 'active' | 'pending';

// The same pieces as the Studio coworker and the dashboard assistant
// (components/brand/AssistantKit): the mark as the status, a ticking
// "Working 6s", steps that spin and settle to ticks, reasoning with a cursor.
const STEP_STATUS = { done: 'done', active: 'running', pending: 'pending' } as const;

export function ThinkingBubble({
  phase, liveText, sql, confidence, tables, canSeeSql, bare,
}: {
  phase:      string;
  liveText:   string;
  sql:        string | null;
  confidence: number | null;
  /** Table names from the `tables` SSE event — labels the "Looking at …" step. */
  tables:     string[];
  /** See the SQL VISIBILITY note at the top of this file. */
  canSeeSql:  boolean;
  /** Worksheet canvas: render the timeline content without the chat
   *  avatar/width chrome — it IS the pending step's result region. */
  bare?:      boolean;
}) {
  // Map the backend's phase strings onto the step sequence. Unknown phases
  // (e.g. 'Generating forecast...') fall back to the first step staying
  // active, which is honest enough.
  const running = phase === 'Running your query…';
  const writing = phase === 'Writing the answer…' || phase === 'Formatting answer…';
  const understandingDone = tables.length > 0 || running || writing;

  // Keep the reasoning pane pinned to the newest text as it streams — the
  // reader follows the tail, and can scroll back if they want the start.
  const reasoningRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = reasoningRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveText]);

  // The card mounts when the question is sent, so its own clock is the wait.
  const [startedAt] = useState(() => Date.now());
  const now = useNow(true);
  const elapsed = now ? now - startedAt : 0;

  const tableLabel = tables.slice(0, 3).map(humanizeTableName).join(', ')
    + (tables.length > 3 ? '…' : '');

  const steps: Array<{ key: string; label: string; state: StepState; sub?: string }> = [
    {
      key: 'understand',
      label: 'Understanding your question',
      state: understandingDone ? 'done' : 'active',
      // The FULL live reasoning while this step is active — rendered in a
      // fixed-height auto-scrolling pane below, so it is followable without
      // the layout growing without bound.
      sub: !understandingDone && liveText ? liveText : undefined,
    },
    ...(tables.length > 0
      ? [{ key: 'tables', label: `Looking at ${tableLabel}`, state: 'done' as StepState }]
      : []),
    {
      key: 'run',
      label: 'Running the numbers',
      state: running ? 'active' : writing ? 'done' : 'pending',
    },
    {
      key: 'write',
      label: 'Writing the answer',
      state: writing ? 'active' : 'pending',
    },
  ];

  return (
    <div className={bare ? '' : 'flex justify-start'}>
      <div className={`${bare ? 'w-full' : 'max-w-[85%] w-full'} bg-raised border border-line rounded-lg overflow-hidden`}>
        {/* The assistant itself, working — the mark is the status. */}
        <div className="px-4 pt-3 pb-2.5 border-b border-line flex items-center">
          <AssistantIdentity
            size={24}
            state="working"
            status="Working"
            trailing={elapsed >= 2000 ? <span className="text-[10.5px] font-mono text-muted-2 tabular-nums">{fmtElapsed(elapsed)}</span> : undefined}
          />
        </div>
        <ol className="px-4 py-3 space-y-2">
          {steps.map((s) => (
            <WorkStep
              key={s.key}
              status={STEP_STATUS[s.state]}
              label={`${s.label}${s.state === 'active' ? '…' : ''}`}
              detail={s.sub ? (
                <div
                  ref={reasoningRef}
                  className="mt-1 max-h-40 overflow-y-auto pr-1 whitespace-pre-wrap break-words border-l-2 border-ocean-soft pl-2.5 not-italic"
                >
                  <LiveThought text={s.sub} className="!text-[11.5px] leading-relaxed" />
                </div>
              ) : undefined}
            />
          ))}
        </ol>

        {/* SQL preview once generated — privileged roles only. The backend
            only emits sql_ready to admin/analyst since 2026-08-27; this is
            the client-side fence on top. */}
        {canSeeSql && sql && (
          <div className="px-4 py-2.5 border-t border-line bg-ink space-y-1">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-white/60">Generated SQL</span>
              {confidence !== null && (
                <span className={`text-[10px] font-mono tracking-[0.06em] uppercase px-1.5 py-0.5 rounded ${confidence >= 0.8 ? 'bg-ok/25 text-ok' : confidence >= 0.7 ? 'bg-warn/25 text-warn' : 'bg-err/25 text-err'}`}>
                  {Math.round(confidence * 100)}% conf
                </span>
              )}
            </div>
            <pre className="text-[10px] text-white/80 font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto max-h-28">
              {formatSql(sql)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Repair panel — "Double-checking", framed as diligence ───────────────────

export function ThinkingPanel({
  repair, onClarify, canSeeSql, bare,
}: {
  repair: RepairState;
  onClarify: (answer: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) => void;
  /** See the SQL VISIBILITY note at the top of this file. */
  canSeeSql: boolean;
  /** Worksheet canvas: full width, no chat alignment wrapper. */
  bare?: boolean;
}) {
  const [clarifyInput, setClarifyInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [repair.events.length]);

  return (
    <div className={bare ? '' : 'flex justify-start'}>
      <div className={bare ? 'w-full' : 'max-w-[85%] w-full'}>
        <div className="bg-raised border border-line rounded-lg overflow-hidden shadow-1 text-[12px]">

          {/* Header — diligence vocabulary, never "investigation failed" drama */}
          <div className="flex items-center px-4 pt-3 pb-2.5 border-b border-line">
            <AssistantIdentity
              size={24}
              state={repair.isActive ? 'checking' : 'done'}
              status={repair.isActive ? 'Double-checking the result' : 'Double-checked'}
            />
          </div>

          {/* Events */}
          <div className="p-4 space-y-3">
            {repair.events.map((ev, i) => {
              if (ev.kind === 'thinking') return (
                <div key={i} className="pl-5 min-w-0">
                  {/* The newest thought is the one being thought right now. */}
                  <LiveThought text={ev.text} live={repair.isActive && i === repair.events.length - 1} />
                  {canSeeSql && ev.detail && (
                    <p className="text-[10.5px] font-mono text-muted mt-0.5 break-words">{ev.detail}</p>
                  )}
                </div>
              );

              if (ev.kind === 'data_query') return (
                <div key={i} className="space-y-1.5">
                  <ul>
                    <WorkStep
                      checking
                      // Running until its result arrives (the next event).
                      status={repair.isActive && i === repair.events.length - 1 ? 'running' : 'done'}
                      label="Checking the data"
                    />
                  </ul>
                  {canSeeSql && ev.sql && (
                    <pre className="ml-6 text-white/80 font-mono text-[10px] bg-ink rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                      {formatSql(ev.sql)}
                    </pre>
                  )}
                </div>
              );

              if (ev.kind === 'query_result') return (
                <div key={i} className="ml-6 space-y-1">
                  <p className="text-muted text-[10px] font-mono tracking-[0.06em] uppercase">
                    → checked {ev.rowCount} row{ev.rowCount !== 1 ? 's' : ''}
                  </p>
                  {/* Raw diagnostic rows are internal reasoning, not the answer —
                      the row count above is the part that makes the wait legible. */}
                  {canSeeSql && ev.rows && ev.rows.length > 0 && (
                    <pre className="text-ink-3 font-mono text-[10px] bg-softer border border-line rounded-md px-3 py-2 overflow-x-auto max-h-28 leading-relaxed">
                      {JSON.stringify(ev.rows.slice(0, 6), null, 2)}
                    </pre>
                  )}
                </div>
              );

              if (ev.kind === 'revised_sql') return (
                <div key={i} className="space-y-1.5">
                  <ul>
                    <WorkStep status="done" label="Correcting the query" />
                  </ul>
                  {canSeeSql && ev.sql && (
                    <pre className="ml-6 text-white/80 font-mono text-[10px] bg-ink rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                      {formatSql(ev.sql)}
                    </pre>
                  )}
                </div>
              );

              if (ev.kind === 'clarification') return (
                <div key={i} className="flex gap-2">
                  <span className="w-3.5 h-3.5 mt-[2px] shrink-0 rounded-full border border-warn text-warn text-[9px] leading-[12px] text-center font-semibold" aria-hidden>?</span>
                  <p className="text-ink-2 leading-relaxed">{ev.question}</p>
                </div>
              );

              return null;
            })}

            {/* Clarification input — answered IN PLACE, never as a fake user
                message in the transcript. */}
            {repair.pendingClarification && repair.pendingHistory && (
              <div className="ml-6 flex gap-2 pt-1">
                <input
                  value={clarifyInput}
                  onChange={(e) => setClarifyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && clarifyInput.trim()) {
                      onClarify(clarifyInput.trim(), repair.pendingHistory!);
                      setClarifyInput('');
                    }
                  }}
                  placeholder="Your answer…"
                  className="flex-1 bg-raised border border-line text-ink rounded-md px-3 py-1.5 text-[12px] placeholder:text-muted-2 outline-none focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)]"
                  autoFocus
                />
                <button
                  onClick={() => {
                    if (!clarifyInput.trim()) return;
                    onClarify(clarifyInput.trim(), repair.pendingHistory!);
                    setClarifyInput('');
                  }}
                  className="px-3 py-1.5 bg-ocean text-white rounded-md text-[12px] font-medium hover:bg-ocean-hover transition-colors"
                >
                  Send
                </button>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
