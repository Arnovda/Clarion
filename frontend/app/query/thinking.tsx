'use client';

/**
 * Two components for visualising what Claude is doing while a query runs.
 *
 * - `ThinkingBubble`: live phase + word-by-word reasoning during a fresh query.
 * - `ThinkingPanel`:  events from the repair loop (diagnostic SQL, revised SQL,
 *                     clarifying questions) and the clarification input.
 *
 * Both consume ephemeral state that is never persisted to the conversation.
 */

import { useState, useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { formatSql } from './utils';
import type { RepairState } from './types';

// ─── Live thinking bubble ────────────────────────────────────────────────────

export function ThinkingBubble({
  phase, liveText, sql, confidence,
}: {
  phase:      string;
  liveText:   string;
  sql:        string | null;
  confidence: number | null;
}) {
  // Word-by-word display of live reasoning — ~220 ms/word (readable pace)
  const [displayed, setDisplayed] = useState('');
  const fullRef = useRef('');
  const posRef  = useRef(0);

  useEffect(() => { fullRef.current = liveText; }, [liveText]);

  useEffect(() => {
    if (liveText === '') { setDisplayed(''); posRef.current = 0; }
  }, [liveText]);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const full = fullRef.current;
      let pos = posRef.current;
      if (pos >= full.length) { setTimeout(tick, 40); return; }
      while (pos < full.length && (full[pos] === ' ' || full[pos] === '\n')) pos++;
      while (pos < full.length && full[pos] !== ' '  && full[pos] !== '\n') pos++;
      if (pos < full.length && full[pos] === ' ') pos++;
      posRef.current = pos;
      setDisplayed(full.slice(0, pos));
      setTimeout(tick, 220);
    };
    const t = setTimeout(tick, 100);
    return () => { alive = false; clearTimeout(t); };
  }, []);

  const isExecuting = phase === 'Running your query…' || phase === 'Formatting answer…';

  return (
    <div className="flex justify-start gap-2">
      {/* Pulsing brain while thinking */}
      <div className="flex-shrink-0 w-7 h-7 mt-1 rounded-full bg-ai-soft border border-line flex items-center justify-center animate-pulse">
        <span className="text-sm">🧠</span>
      </div>

      <div className="max-w-[85%] w-full bg-raised border border-line rounded-lg overflow-hidden">
        {/* Phase header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line bg-softer">
          {isExecuting ? (
            <Loader2 className="w-3.5 h-3.5 text-ok animate-spin flex-shrink-0" strokeWidth={2} />
          ) : (
            <span className="flex gap-0.5 flex-shrink-0">
              {[0,1,2].map((i) => (
                <span key={i} className="w-1.5 h-1.5 bg-ocean rounded-full animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </span>
          )}
          <span className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted">{phase || 'Loading…'}</span>
        </div>

        {/* Word-by-word reasoning — plain grey text, no scroll, grows naturally */}
        {displayed && (
          <div className="px-4 pt-3 pb-2">
            <p className="text-[12px] text-ink-3 leading-relaxed whitespace-pre-wrap">
              {displayed}
              <span className="inline-block w-[2px] h-[11px] bg-muted ml-[1px] align-middle animate-pulse" />
            </p>
          </div>
        )}

        {/* SQL preview once generated */}
        {sql && (
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

// ─── Repair-loop thinking panel — Observatory-styled ─────────────────────────

export function ThinkingPanel({
  repair, onClarify,
}: {
  repair: RepairState;
  onClarify: (answer: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) => void;
}) {
  const [clarifyInput, setClarifyInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [repair.events.length]);

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] w-full">
        <div className="bg-raised border border-line rounded-lg overflow-hidden shadow-1 text-[12px]">

          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line bg-softer">
            {repair.isActive ? (
              <span className="flex gap-0.5">
                {[0,1,2].map((i) => (
                  <span key={i} className="w-1.5 h-1.5 bg-ocean rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </span>
            ) : (
              <span className="text-ok">✓</span>
            )}
            <span className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted">
              {repair.isActive ? 'Investigating…' : 'Investigation complete'}
            </span>
          </div>

          {/* Events */}
          <div className="p-4 space-y-3">
            {repair.events.map((ev, i) => {
              if (ev.kind === 'thinking') return (
                <div key={i} className="flex gap-2.5">
                  <span className="text-muted-2 flex-shrink-0 mt-0.5">💭</span>
                  <p className="text-ink-3 leading-relaxed">{ev.text}</p>
                </div>
              );

              if (ev.kind === 'data_query') return (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-ocean flex-shrink-0">🔍</span>
                    <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-ocean">Running diagnostic</span>
                  </div>
                  <pre className="ml-6 text-white/80 font-mono text-[10px] bg-ink rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                    {formatSql(ev.sql)}
                  </pre>
                </div>
              );

              if (ev.kind === 'query_result') return (
                <div key={i} className="ml-6 space-y-1">
                  <p className="text-muted text-[10px] font-mono tracking-[0.06em] uppercase">
                    → {ev.rowCount} row{ev.rowCount !== 1 ? 's' : ''} returned
                  </p>
                  {ev.rows.length > 0 && (
                    <pre className="text-ink-3 font-mono text-[10px] bg-softer border border-line rounded-md px-3 py-2 overflow-x-auto max-h-28 leading-relaxed">
                      {JSON.stringify(ev.rows.slice(0, 6), null, 2)}
                    </pre>
                  )}
                </div>
              );

              if (ev.kind === 'revised_sql') return (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-warn flex-shrink-0">✏️</span>
                    <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-warn">Revised query</span>
                  </div>
                  <pre className="ml-6 text-white/80 font-mono text-[10px] bg-ink rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                    {formatSql(ev.sql)}
                  </pre>
                </div>
              );

              if (ev.kind === 'clarification') return (
                <div key={i} className="flex gap-2.5">
                  <span className="text-warn flex-shrink-0 mt-0.5">❓</span>
                  <p className="text-ink-2 leading-relaxed">{ev.question}</p>
                </div>
              );

              return null;
            })}

            {/* Clarification input */}
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
