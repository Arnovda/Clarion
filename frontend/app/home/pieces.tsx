'use client';

/**
 * The three small pieces of Home: the ask box, the watch panel, and the
 * operational line.
 */

import { useState } from 'react';
import { Clock, MessageSquare, Plus, X } from 'lucide-react';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';
import type { PulseTile, QueryStarter } from './types';

// ─── Ask box ────────────────────────────────────────────────────────────────

/**
 * Sits directly under the lead, on every state of the page including the
 * cold start. It is the product's core verb and it is never the only thing
 * on the page — "here's what I noticed, also ask me anything" is the whole
 * design, and an ask box alone would put the burden of curiosity back on
 * the user every morning.
 */
export function AskBox({
  starters, onAsk,
}: {
  starters: QueryStarter[];
  onAsk: (question: string) => void;
}) {
  const [value, setValue] = useState('');
  const submit = () => onAsk(value.trim());

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2.5 h-12 bg-raised border border-line rounded-[10px] pl-3.5 pr-1.5 shadow-2 mb-3 focus-within:border-ocean focus-within:ring-[3px] focus-within:ring-ocean-soft transition-colors">
        <MessageSquare className="w-4 h-4 shrink-0 text-muted-2" strokeWidth={1.7} aria-hidden />
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="Ask anything about your business…"
          aria-label="Ask a question"
          className="flex-1 min-w-0 bg-transparent text-[14px] text-ink placeholder:text-muted-2 focus:outline-none"
        />
        <button
          type="button"
          onClick={submit}
          className="shrink-0 rounded-[6px] bg-ocean px-4 py-2 text-[13px] font-medium text-white hover:bg-ocean-hover transition-colors"
        >
          Ask
        </button>
      </div>

      {starters.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {starters.slice(0, 3).map((s) => (
            <button
              key={s.question}
              type="button"
              onClick={() => onAsk(s.question)}
              className="text-[12.5px] text-ink-2 bg-raised border border-line rounded-full px-3 py-1 hover:border-ocean hover:text-ocean hover:bg-ocean-softer transition-colors"
            >
              {s.question}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Watch panel ────────────────────────────────────────────────────────────

/**
 * "Tell me what to keep an eye on."
 *
 * Deliberately a sentence, not a settings screen: the thing being configured
 * is what the assistant pays attention to, and asking for that in plain
 * English is the same gesture as asking a question. The text goes to
 * `POST /pulse/suggest` as an intent; the proposals come back as chips the
 * user accepts one at a time, so nothing is added on the model's say-so.
 */
export function WatchPanel({
  watching, onWatch, onRemove, busy, suggestions, onAccept, onDismissSuggestion,
}: {
  watching: PulseTile[];
  onWatch: (intent: string) => void;
  onRemove: (id: number) => void;
  busy: boolean;
  suggestions: Array<{ key: string; label: string; rationale: string | null }>;
  onAccept: (key: string) => void;
  onDismissSuggestion: (key: string) => void;
}) {
  const [value, setValue] = useState('');
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onWatch(v);
    setValue('');
  };

  return (
    <section className="mb-8">
      <p className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted mb-3">
        Tell me what to keep an eye on
      </p>

      <div className="bg-raised border border-dashed border-line-strong rounded-[10px] px-4 py-3.5">
        <p className="text-[13px] text-ink-3 mb-2.5">
          Plain English is fine. I&apos;ll work out which numbers that means and check them every morning.
        </p>
        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="e.g. tell me if any customer stops ordering"
            aria-label="Describe what to watch"
            disabled={busy}
            className="flex-1 min-w-0 h-9 bg-surface border border-line rounded-[6px] px-3 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-ocean focus:ring-[3px] focus:ring-ocean-soft disabled:opacity-60"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="shrink-0 px-3.5 py-2 rounded-[6px] bg-ocean-softer border border-ocean-soft text-ocean text-[12px] font-medium hover:bg-ocean-soft disabled:opacity-60 transition-colors"
          >
            {busy ? 'Thinking…' : 'Watch it'}
          </button>
        </div>

        {suggestions.length > 0 && (
          <div className="mt-3 flex flex-col gap-1.5">
            {suggestions.map((s) => (
              <div
                key={s.key}
                className="flex items-start gap-2.5 rounded-[8px] border border-ai-soft bg-ai-soft/40 px-3 py-2"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-[12.5px] text-ink">{s.label}</span>
                  {s.rationale && <span className="block text-[11.5px] text-muted mt-0.5">{s.rationale}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => onAccept(s.key)}
                  className="shrink-0 inline-flex items-center gap-1 rounded-[6px] bg-ai px-2.5 py-1 text-[11.5px] font-medium text-white hover:brightness-95 transition-all"
                >
                  <Plus className="w-3 h-3" strokeWidth={2.4} aria-hidden />
                  Watch
                </button>
                <button
                  type="button"
                  onClick={() => onDismissSuggestion(s.key)}
                  aria-label={`Dismiss ${s.label}`}
                  className="shrink-0 rounded p-1 text-muted-2 hover:text-err hover:bg-err-soft transition-colors"
                >
                  <X className="w-3 h-3" strokeWidth={2.4} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}

        {watching.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {watching.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-softer pl-2.5 pr-1.5 py-0.5 text-[11.5px] text-ink-2"
              >
                {t.label}
                <button
                  type="button"
                  onClick={() => onRemove(t.id)}
                  aria-label={`Stop watching ${t.label}`}
                  className="rounded-full p-0.5 text-muted-2 hover:text-err hover:bg-err-soft transition-colors"
                >
                  <X className="w-2.5 h-2.5" strokeWidth={2.6} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Operational line ───────────────────────────────────────────────────────

/**
 * The ONE operational line, at the bottom.
 *
 * It replaces the health ring, the four sub-score tiles and the attention
 * feed. Two rules it exists to enforce:
 *
 *   1. It says what staleness costs the READER ("the last three days are
 *      missing"), never what it scores US ("Freshness 0/100"). A score that
 *      reads catastrophic during the entirely normal state of a
 *      monthly-close dataset teaches people to ignore every other signal.
 *   2. It sits BELOW the numbers because it qualifies them. It does not
 *      compete with them for the top of the page.
 *
 * Viewers see the sentence without the Refresh action (owner decision,
 * 2026-09-07): the refresh is not theirs to trigger, and a dead button is
 * worse than a plain statement of fact.
 */
export function OpsLine({
  asOf, problem, canRefresh, onRefresh, onDetails,
}: {
  asOf: string | null;
  problem: string | null;
  canRefresh: boolean;
  onRefresh: () => void;
  onDetails: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 flex-wrap rounded-[10px] border border-line bg-surface px-3.5 py-2.5">
      <Clock
        className={cn('w-[15px] h-[15px] shrink-0', problem ? 'text-warn' : 'text-muted-2')}
        strokeWidth={1.9}
        aria-hidden
      />
      <span className="flex-1 min-w-[220px] text-[12.5px] text-ink-3">
        {asOf
          ? <>Everything above includes data through <b className="font-semibold text-ink-2">{formatDate(asOf)}</b>.</>
          : <>No data has arrived yet.</>}
        {problem && <> {problem}</>}
      </span>
      {canRefresh && problem && (
        <button type="button" onClick={onRefresh} className="text-[12.5px] text-ocean hover:underline">
          Refresh now
        </button>
      )}
      <button type="button" onClick={onDetails} className="text-[12.5px] text-muted hover:underline">
        Details
      </button>
    </div>
  );
}
