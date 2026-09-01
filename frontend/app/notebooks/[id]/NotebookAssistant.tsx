'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, ChevronDown, Copy, CornerDownLeft, Sparkles, Square, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// The notebook assistant.
//
// Same shape as the dashboard's assistant (see
// app/dashboards/components/AssistantPanel.tsx) and for the same reasons: it
// FLOATS in the bottom-right over the cells instead of sitting in their
// layout, so closing it gives the notebook every pixel back, and collapsed it
// is a pill that still reports what is running.
//
// What it does differently is the job: it writes CODE into a specific cell.
// So the thing the dashboard panel calls a "scope" is here a TARGET, and it
// is never implicit — the chip above the composer names the cell that is
// about to be written, because code appearing in a cell you were not looking
// at is the one outcome nobody can undo by eye.
//
// It replaces the per-cell AI prompt bar. Two entry points to the same
// generator, each with its own history, is how the two quietly drift apart;
// a cell's AI button now aims THIS panel at that cell.
// ---------------------------------------------------------------------------

/**
 * The cell the panel is aimed at. There being no target at all is expressed
 * by `target === null`, so both fields are always real once one exists.
 */
export interface AssistantTarget {
  cellId: number;
  /** 1-based position shown to the user. */
  index: number;
  language: 'sql' | 'python';
  /** True when the cell already has code — the model is editing, not writing. */
  hasCode: boolean;
}

export interface NotebookChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** The user's request, or the assistant's one-line account of what it did. */
  text: string;
  /** The code the assistant wrote — the substance of an assistant turn. */
  code?: string;
  language?: 'sql' | 'python';
  /** Which cell it was proposed for, e.g. "Cell 3 · SQL". */
  targetLabel?: string;
  /**
   * What became of the suggestion. The assistant proposes; the cell is where
   * it is accepted or rejected, and this is how that outcome comes back —
   * without it the history reads as though every suggestion was applied.
   */
  decision?: 'pending' | 'accepted' | 'rejected' | 'superseded';
  working?: boolean;
  startedAt?: number;
  errorDetail?: string;
}

/**
 * Ticking elapsed seconds. Read in an effect, never during render:
 * `Date.now()` in a render body tears hydration. Null until the first tick.
 */
function useElapsed(since: number | undefined, active: boolean): number | null {
  const [secs, setSecs] = useState<number | null>(null);
  useEffect(() => {
    if (!active || !since) { setSecs(null); return; }
    const read = () => setSecs(Math.max(0, Math.round((Date.now() - since) / 1000)));
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, [active, since]);
  return secs;
}

function Elapsed({ since, active }: { since?: number; active: boolean }) {
  const secs = useElapsed(since, active);
  if (secs === null || secs < 2) return null;
  const text = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return <span className="text-[11px] font-mono text-muted-2 tabular-nums shrink-0">{text}</span>;
}

/** One-line stand-in for an older exchange, so history is present but quiet. */
function CollapsedMessage({ msg, onExpand }: { msg: NotebookChatMessage; onExpand: () => void }) {
  const label = msg.errorDetail
    ? 'Could not write that'
    : msg.decision === 'rejected' ? 'Discarded — your code kept'
      : msg.decision === 'accepted' ? `Kept — ${msg.targetLabel ?? 'cell updated'}`
        : msg.text.split('\n')[0].slice(0, 64) || 'Code written';
  return (
    <button
      type="button"
      onClick={onExpand}
      className="w-full flex items-center gap-2 text-left px-3 py-1.5 rounded-md border border-line bg-softer hover:bg-soft transition-colors group/collapsed"
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
        msg.errorDetail ? 'bg-warn' : msg.decision === 'rejected' ? 'bg-line-strong' : 'bg-ok'
      }`} />
      <span className="flex-1 min-w-0 truncate text-[12px] text-muted group-hover/collapsed:text-ink-2 transition-colors">
        {label}
      </span>
      <ChevronDown className="w-3 h-3 text-muted-2 shrink-0" strokeWidth={2} />
    </button>
  );
}

function CodeBlock({
  code, onProposeAgain, canProposeAgain,
}: { code: string; onProposeAgain: () => void; canProposeAgain: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-md border border-line bg-raised overflow-hidden">
      <pre className="px-3 py-2 text-[11.5px] font-mono leading-relaxed text-ink-2 max-h-52 overflow-auto whitespace-pre">
        {code}
      </pre>
      <div className="flex items-center gap-1 px-2 py-1 border-t border-line bg-softer">
        {/* Only once the decision is behind you: while a proposal is pending
            in the cell, "propose again" would mean replacing it with itself. */}
        {canProposeAgain && (
          <button
            type="button"
            onClick={onProposeAgain}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ocean transition-colors"
            title="Suggest this code for the cell again"
          >
            <CornerDownLeft className="w-3 h-3" strokeWidth={2} />
            Suggest again
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(code).then(
              () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
              () => { /* clipboard blocked — the code is on screen either way */ },
            );
          }}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ocean transition-colors"
        >
          {copied ? <Check className="w-3 h-3" strokeWidth={2} /> : <Copy className="w-3 h-3" strokeWidth={2} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

interface NotebookAssistantProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: NotebookChatMessage[];
  loading: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  /** Stop the generation in flight. */
  onStop: () => void;
  /** 'edit' rewrites the target cell; 'new' appends a fresh cell. */
  mode: 'edit' | 'new';
  onModeChange: (mode: 'edit' | 'new') => void;
  /** The language a 'new' cell will be created in. */
  newLanguage: 'sql' | 'python';
  onNewLanguageChange: (lang: 'sql' | 'python') => void;
  /** The cell about to be written. Null when there is no cell to edit. */
  target: AssistantTarget | null;
  /** Aim at the notebook as a whole instead of one cell. */
  onClearTarget: () => void;
  /** Put a past suggestion back in front of the user as a fresh proposal. */
  onProposeAgain: (code: string) => void;
  /** No connection on the notebook — the model has no schema to write against. */
  disabledReason?: string | null;
}

export default function NotebookAssistant({
  open,
  onOpenChange,
  messages,
  loading,
  input,
  onInputChange,
  onSubmit,
  onStop,
  mode,
  onModeChange,
  newLanguage,
  onNewLanguageChange,
  target,
  onClearTarget,
  onProposeAgain,
  disabledReason,
}: NotebookAssistantProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showErrorFor, setShowErrorFor] = useState<Set<string>>(new Set());

  const working = messages.find((m) => m.working);
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, open]);

  // Opening should leave you ready to type — including when a cell's AI
  // button opened it for you, which is the whole point of that gesture.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, target?.cellId]);

  const toggle = (id: string, set: React.Dispatch<React.SetStateAction<Set<string>>>) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const effectiveLanguage = mode === 'new' ? newLanguage : target?.language ?? newLanguage;
  const targetLabel = mode === 'new'
    ? `New ${effectiveLanguage === 'sql' ? 'SQL' : 'Python'} cell at the end`
    : target
      ? `Cell ${target.index} · ${target.language === 'sql' ? 'SQL' : 'Python'}${target.hasCode ? '' : ' (empty)'}`
      : `New ${effectiveLanguage === 'sql' ? 'SQL' : 'Python'} cell`;

  // ── Collapsed: a pill that reports progress without opening ──────────────
  if (!open) {
    return (
      <motion.button
        type="button"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        onClick={() => onOpenChange(true)}
        className="absolute bottom-5 right-5 z-30 flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-full border border-line bg-raised shadow-[0_6px_24px_-8px_rgba(15,32,45,0.30)] hover:border-line-strong transition-colors max-w-[min(420px,calc(100%-2.5rem))]"
        aria-label={working ? 'The assistant is writing code — open to watch' : 'Ask AI to write code'}
      >
        {working ? (
          <span className="w-2 h-2 rounded-full bg-ocean animate-pulse shrink-0" />
        ) : (
          <Sparkles className="w-3.5 h-3.5 text-ocean shrink-0" strokeWidth={2} />
        )}
        <span className="text-[13px] text-ink-2 truncate">
          {working ? 'Writing code…' : 'Ask AI to write code'}
        </span>
        {working && <Elapsed since={working.startedAt} active />}
      </motion.button>
    );
  }

  // ── Open: floating over the cells, never in their layout ─────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.98 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      className="absolute bottom-5 right-5 z-30 w-[min(440px,calc(100%-2.5rem))] max-h-[min(72vh,660px)] flex flex-col rounded-xl border border-line bg-raised shadow-[0_16px_48px_-16px_rgba(15,32,45,0.38)] overflow-hidden"
      role="dialog"
      aria-label="Notebook assistant"
    >
      {/* Header */}
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-line bg-soft shrink-0">
        <Sparkles className="w-3.5 h-3.5 text-ocean shrink-0" strokeWidth={2} />
        <span className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted-2 flex-1">
          Assistant
        </span>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="p-1 rounded text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors"
          aria-label="Close the assistant"
          title="Close"
        >
          <ChevronDown className="w-4 h-4" strokeWidth={2} />
        </button>
      </div>

      {/* Target chip — the cell the next answer will be written into. Above
          the composer because it changes what the message DOES, and code
          appearing in a cell you were not watching is not undoable by eye. */}
      <div className="px-4 py-2 flex items-center gap-2 border-b border-line bg-ocean-softer shrink-0">
        <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-ocean shrink-0">
          Writing
        </span>
        <span className="flex-1 min-w-0 truncate text-[12.5px] text-ink-2">{targetLabel}</span>
        {mode === 'edit' && target && (
          <button
            type="button"
            onClick={onClearTarget}
            className="p-0.5 rounded text-ocean hover:bg-ocean-soft/40 transition-colors shrink-0"
            aria-label="Write into a new cell instead"
            title="Write into a new cell instead"
          >
            <X className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        )}
      </div>

      {/* History */}
      {messages.length > 0 && (
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
          {messages.map((msg) => {
            if (msg.role === 'user') {
              return (
                <p
                  key={msg.id}
                  className="text-[13.5px] text-right text-ink-2 font-display italic leading-relaxed pl-6"
                >
                  {msg.text}
                </p>
              );
            }
            const isLatest = msg.id === lastAssistantId;
            const expanded = isLatest || msg.working || expandedIds.has(msg.id);
            if (!expanded) {
              return (
                <CollapsedMessage
                  key={msg.id}
                  msg={msg}
                  onExpand={() => toggle(msg.id, setExpandedIds)}
                />
              );
            }
            return (
              <div
                key={msg.id}
                className={`px-3.5 py-2.5 rounded-lg border text-[13px] ${
                  msg.errorDetail
                    ? 'bg-warn-soft border-warn/40 text-ink-2'
                    // A decision still waiting is NOT a success — green here
                    // reads as "done" and is the one thing it must not say.
                    : msg.working || msg.decision === 'pending'
                      ? 'bg-ocean-softer border-line text-ink-2'
                      : msg.decision === 'rejected'
                        ? 'bg-softer border-line text-ink-2'
                        : 'bg-ok-soft border-line text-ink-2'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`text-[10px] font-mono tracking-[0.08em] uppercase ${
                      msg.errorDetail ? 'text-warn'
                        : msg.working ? 'text-ocean'
                          : msg.decision === 'rejected' ? 'text-muted'
                            : msg.decision === 'pending' ? 'text-ocean'
                              : 'text-ok'
                    }`}
                  >
                    {msg.errorDetail ? 'Error'
                      : msg.working ? 'Writing code'
                        : msg.decision === 'pending' ? 'Waiting for you'
                          : msg.decision === 'accepted' ? 'Kept'
                            : msg.decision === 'rejected' ? 'Discarded'
                              : msg.decision === 'superseded' ? 'Replaced'
                                : msg.targetLabel ?? 'Code written'}
                  </span>
                  <span className="flex-1" />
                  <Elapsed since={msg.startedAt} active={!!msg.working} />
                </div>

                {msg.text && <p className="leading-relaxed">{msg.text}</p>}

                {msg.working && (
                  <p className="text-[12px] text-muted italic mt-1.5 flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-ocean animate-pulse shrink-0" />
                    Reading your schema and writing the code…
                  </p>
                )}

                {msg.decision === 'pending' && (
                  <p className="text-[12px] text-ocean mt-1.5">
                    Keep or discard it in {msg.targetLabel ?? 'the cell'}.
                  </p>
                )}

                {/* A pending suggestion is being read in the cell, where the
                    diff shows what it replaces; repeating it here in full
                    just moves the eye away from the decision. */}
                {msg.code && msg.decision !== 'pending' && (
                  <CodeBlock
                    code={msg.code}
                    onProposeAgain={() => onProposeAgain(msg.code!)}
                    canProposeAgain={msg.decision === 'rejected' || msg.decision === 'superseded'}
                  />
                )}

                {msg.errorDetail && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => toggle(msg.id, setShowErrorFor)}
                      className="text-[10px] font-mono tracking-[0.06em] uppercase text-warn hover:text-warn/80 underline underline-offset-2 cursor-pointer"
                    >
                      {showErrorFor.has(msg.id) ? 'Hide details' : 'View error'}
                    </button>
                    {showErrorFor.has(msg.id) && (
                      <pre className="mt-2 text-[11px] font-mono text-ink-2 bg-raised border border-line rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">
                        {msg.errorDetail}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}

      {/* Composer */}
      <div className="shrink-0 border-t border-line">
        <div className="px-4 pt-2.5 pb-1 flex items-center gap-1.5 flex-wrap">
          {(['edit', 'new'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              disabled={m === 'edit' && !target}
              className={`px-2.5 py-0.5 text-[10px] font-mono tracking-[0.08em] uppercase rounded-full border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                mode === m
                  ? 'bg-ocean-softer border-ocean-soft text-ocean'
                  : 'bg-transparent border-line text-muted hover:text-ink-2 hover:border-line-strong'
              }`}
              aria-pressed={mode === m}
            >
              {m === 'edit' ? 'This cell' : 'New cell'}
            </button>
          ))}
          {/* A new cell needs a language; an existing one already has one. */}
          {mode === 'new' && (
            <>
              <span className="w-px h-3.5 bg-line mx-0.5" aria-hidden="true" />
              {(['sql', 'python'] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => onNewLanguageChange(lang)}
                  className={`px-2.5 py-0.5 text-[10px] font-mono tracking-[0.08em] uppercase rounded-full border transition-colors ${
                    newLanguage === lang
                      ? 'bg-ocean-softer border-ocean-soft text-ocean'
                      : 'bg-transparent border-line text-muted hover:text-ink-2 hover:border-line-strong'
                  }`}
                  aria-pressed={newLanguage === lang}
                >
                  {lang === 'sql' ? 'SQL' : 'Python'}
                </button>
              ))}
            </>
          )}
        </div>
        {disabledReason && (
          <p className="px-4 pb-1 text-[11.5px] text-warn">{disabledReason}</p>
        )}
        <div className="px-4 pb-3 pt-1 flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); }
              if (e.key === 'Escape') {
                if (loading) onStop();
                else onOpenChange(false);
              }
            }}
            placeholder={
              effectiveLanguage === 'sql'
                ? 'e.g. top 10 customers by revenue this year…'
                : 'e.g. plot the monthly revenue trend…'
            }
            disabled={loading || !!disabledReason}
            className="flex-1 min-w-0 px-3 py-2 text-[13px] rounded-md border border-line bg-raised text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 disabled:opacity-50 transition-colors"
          />
          {/* While something runs, the primary button STOPS it. */}
          {loading ? (
            <button
              type="button"
              onClick={onStop}
              title="Stop (Esc)"
              className="px-4 py-2 text-[13px] font-medium rounded-md border border-line-strong bg-raised text-ink-2 hover:border-warn hover:text-warn transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
            >
              <Square className="w-3 h-3 fill-current" strokeWidth={0} aria-hidden="true" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onSubmit}
              disabled={!input.trim() || !!disabledReason}
              className="px-4 py-2 text-[13px] font-medium text-white rounded-md bg-ocean hover:bg-ocean-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
            >
              Write
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
