'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Sparkles, Square, X } from 'lucide-react';
import { MarkdownAnswer } from './MarkdownAnswer';
import type { ChatMessage, RefineStep } from '../types';

// ---------------------------------------------------------------------------
// The dashboard assistant.
//
// This replaces the chat bar that used to be welded to the bottom of the
// dashboard. That bar cost ~98px of vertical space permanently and up to
// ~306px once it had any history — on the screen whose entire job is to show
// charts, and it could not be put away. So the panel FLOATS: it is positioned
// over the dashboard rather than in its layout, which means closing it gives
// the dashboard every pixel back, and opening it costs the dashboard nothing
// but occlusion of a corner you can move away from with one click.
//
// Two rules keep it from becoming the busy thing it replaced:
//
//   1. Only the newest exchange is expanded. Everything before it collapses to
//      one line you can click open. An edit can produce a summary, a checklist
//      of a dozen steps and a list of notes; three of those stacked is a wall,
//      and the wall is what makes people stop reading the one that matters.
//   2. Anything still running says how long it has been running. "Is it
//      working or is it stuck" is not answerable from a spinner, and it is the
//      only question being asked during the wait.
// ---------------------------------------------------------------------------

/**
 * Ticking elapsed seconds since `since`, or null when nothing is running.
 *
 * The clock is read in an effect, never during render: `Date.now()` in a
 * render body gives the server and the client different HTML and tears the
 * hydration. Null until the first tick, so the first paint has no number to
 * disagree about.
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

function StepIcon({ status }: { status: RefineStep['status'] }) {
  return (
    <span className="mt-[3px] w-3.5 shrink-0 text-center">
      {status === 'done' ? (
        <span className="text-ok">✓</span>
      ) : status === 'failed' ? (
        <span className="text-warn">✗</span>
      ) : status === 'running' ? (
        <span className="inline-block w-2 h-2 rounded-full bg-ocean animate-pulse" />
      ) : (
        <span className="inline-block w-2 h-2 rounded-full border border-line-strong" />
      )}
    </span>
  );
}

function StepRow({ step, depth }: { step: RefineStep; depth: number }) {
  return (
    <li
      className="flex items-start gap-2 text-[12.5px] leading-snug"
      style={depth ? { paddingLeft: depth * 14 } : undefined}
    >
      <StepIcon status={step.status} />
      <span className={`flex-1 min-w-0 ${step.status === 'pending' ? 'text-muted' : 'text-ink-2'}`}>
        {step.label}
        {step.note && step.status !== 'pending' && <span className="text-muted"> — {step.note}</span>}
      </span>
      <Elapsed since={step.startedAt} active={step.status === 'running'} />
    </li>
  );
}

/** Plan checklist, with server-appended steps nested under their parent. */
function StepList({ steps }: { steps: RefineStep[] }) {
  const ordered = useMemo(() => {
    const children = new Map<string, RefineStep[]>();
    for (const s of steps) {
      if (!s.parentId) continue;
      const list = children.get(s.parentId) ?? [];
      list.push(s);
      children.set(s.parentId, list);
    }
    const out: Array<{ step: RefineStep; depth: number }> = [];
    for (const s of steps) {
      if (s.parentId) continue;
      out.push({ step: s, depth: 0 });
      for (const c of children.get(s.id) ?? []) out.push({ step: c, depth: 1 });
    }
    return out;
  }, [steps]);

  return (
    <ul className="space-y-1 mt-2">
      {ordered.map(({ step, depth }) => (
        <StepRow key={step.id} step={step} depth={depth} />
      ))}
    </ul>
  );
}

/** One-line stand-in for an older exchange, so history is present but quiet. */
function CollapsedMessage({ msg, onExpand }: { msg: ChatMessage; onExpand: () => void }) {
  const failed = msg.steps?.filter((s) => s.status === 'failed').length ?? 0;
  const label = msg.errorDetail
    ? 'Could not do that'
    : msg.text.split('\n')[0].replace(/\*\*/g, '').slice(0, 64) || 'Dashboard updated';
  return (
    <button
      type="button"
      onClick={onExpand}
      className="w-full flex items-center gap-2 text-left px-3 py-1.5 rounded-md border border-line bg-softer hover:bg-soft transition-colors group/collapsed"
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${msg.errorDetail || failed ? 'bg-warn' : 'bg-ok'}`} />
      <span className="flex-1 min-w-0 truncate text-[12px] text-muted group-hover/collapsed:text-ink-2 transition-colors">
        {label}
      </span>
      <ChevronDown className="w-3 h-3 text-muted-2 shrink-0" strokeWidth={2} />
    </button>
  );
}

interface AssistantPanelProps {
  messages: ChatMessage[];
  loading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'refine' | 'query';
  onModeChange: (mode: 'refine' | 'query') => void;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  /** Stop the run in flight. Leaves the dashboard untouched — a refine only
   *  lands when its `done` event arrives with a complete spec. */
  onStop: () => void;
  /** The single card the next message will be aimed at, if any. */
  scope: { id: string; title: string } | null;
  onClearScope: () => void;
}

export default function AssistantPanel({
  messages,
  loading,
  open,
  onOpenChange,
  mode,
  onModeChange,
  input,
  onInputChange,
  onSubmit,
  onStop,
  scope,
  onClearScope,
}: AssistantPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showErrorFor, setShowErrorFor] = useState<Set<string>>(new Set());

  const working = messages.find((m) => m.working);
  const lastAssistantId = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'assistant')?.id,
    [messages],
  );

  // Follow the tail while something is streaming into it.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, open]);

  // Opening the panel should leave you ready to type — including when a card
  // action opened it for you, which is the whole point of that gesture.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, scope?.id]);

  const toggle = (id: string, set: React.Dispatch<React.SetStateAction<Set<string>>>) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── Collapsed: a pill that reports progress without opening ──────────────
  if (!open) {
    return (
      <motion.button
        type="button"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        onClick={() => onOpenChange(true)}
        className="absolute bottom-5 right-5 z-30 flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-full border border-line bg-raised shadow-[0_6px_24px_-8px_rgba(15,32,45,0.30)] hover:border-line-strong transition-colors max-w-[min(420px,calc(100%-2.5rem))]"
        aria-label={working ? 'Assistant is working — open to watch' : 'Open the dashboard assistant'}
      >
        {working ? (
          <span className="w-2 h-2 rounded-full bg-ocean animate-pulse shrink-0" />
        ) : (
          <Sparkles className="w-3.5 h-3.5 text-ocean shrink-0" strokeWidth={2} />
        )}
        <span className="text-[13px] text-ink-2 truncate">
          {working ? working.phase || 'Working…' : 'Ask or change this dashboard'}
        </span>
        {working && <Elapsed since={working.startedAt} active />}
      </motion.button>
    );
  }

  // ── Open: floating over the dashboard, never in its layout ───────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.98 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      className="absolute bottom-5 right-5 z-30 w-[min(440px,calc(100%-2.5rem))] max-h-[min(72vh,660px)] flex flex-col rounded-xl border border-line bg-raised shadow-[0_16px_48px_-16px_rgba(15,32,45,0.38)] overflow-hidden"
      role="dialog"
      aria-label="Dashboard assistant"
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

      {/* Scope chip — which card the next message is aimed at. Sits above the
          input because it changes what the message MEANS, and a scope you
          cannot see is a scope you get stuck in. */}
      {scope && (
        <div className="px-4 py-2 flex items-center gap-2 border-b border-line bg-ocean-softer shrink-0">
          <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-ocean shrink-0">
            Changing
          </span>
          <span className="flex-1 min-w-0 truncate text-[12.5px] text-ink-2">{scope.title}</span>
          <button
            type="button"
            onClick={onClearScope}
            className="p-0.5 rounded text-ocean hover:bg-ocean-soft/40 transition-colors shrink-0"
            aria-label="Change the whole dashboard instead"
            title="Change the whole dashboard instead"
          >
            <X className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>
      )}

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
                    : msg.type === 'refine'
                      ? msg.working
                        ? 'bg-ocean-softer border-line text-ink-2'
                        : 'bg-ok-soft border-line text-ink-2'
                      : 'bg-softer border-line text-ink'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  {msg.errorDetail ? (
                    <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-warn">
                      Error
                    </span>
                  ) : msg.type === 'refine' ? (
                    <span
                      className={`text-[10px] font-mono tracking-[0.08em] uppercase ${msg.working ? 'text-ocean' : 'text-ok'}`}
                    >
                      {/* Kept short deliberately: a card title in an
                          uppercase mono kicker wraps to three shouting lines.
                          The card is named in the message text below. */}
                      {msg.working
                        ? msg.scopeTitle ? 'Changing one card' : 'Updating the dashboard'
                        : msg.scopeTitle ? 'Card updated' : 'Dashboard updated'}
                    </span>
                  ) : null}
                  <span className="flex-1" />
                  <Elapsed since={msg.startedAt} active={!!msg.working} />
                </div>

                {msg.text && <MarkdownAnswer text={msg.text} />}
                {msg.steps && msg.steps.length > 0 && <StepList steps={msg.steps} />}

                {msg.working && msg.phase && (
                  <p className="text-[12px] text-muted italic mt-1.5 flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-ocean animate-pulse shrink-0" />
                    {msg.phase}
                  </p>
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
          {loading && !working && (
            <div className="flex justify-start">
              <div className="bg-softer border border-line rounded-lg px-4 py-3 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-ocean rounded-full animate-bounce" style={{ animationDelay: '0s' }} />
                <span className="w-1.5 h-1.5 bg-ocean rounded-full animate-bounce" style={{ animationDelay: '0.15s' }} />
                <span className="w-1.5 h-1.5 bg-ocean rounded-full animate-bounce" style={{ animationDelay: '0.3s' }} />
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      {/* Composer */}
      <div className="shrink-0 border-t border-line">
        {/* Mode toggle. Suppressed while scoped: "ask a question" about one
            card is a different feature, and offering it here would make the
            scope chip mean two things. */}
        {!scope && (
          <div className="px-4 pt-2.5 pb-1 flex items-center gap-1.5">
            {(['refine', 'query'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onModeChange(m)}
                className={`px-2.5 py-0.5 text-[10px] font-mono tracking-[0.08em] uppercase rounded-full border transition-colors ${
                  mode === m
                    ? 'bg-ocean-softer border-ocean-soft text-ocean'
                    : 'bg-transparent border-line text-muted hover:text-ink-2 hover:border-line-strong'
                }`}
                aria-pressed={mode === m}
              >
                {m === 'refine' ? 'Edit dashboard' : 'Ask AI'}
              </button>
            ))}
          </div>
        )}
        <div className={`px-4 pb-3 flex gap-2 ${scope ? 'pt-3' : 'pt-1'}`}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSubmit();
              if (e.key === 'Escape') {
                if (loading) onStop();
                else if (scope) onClearScope();
                else onOpenChange(false);
              }
            }}
            placeholder={
              scope
                ? 'e.g. sort descending, or show margin % instead…'
                : mode === 'refine'
                  ? 'Say how to improve this dashboard…'
                  : 'Ask a question about the data…'
            }
            disabled={loading}
            className="flex-1 min-w-0 px-3 py-2 text-[13px] rounded-md border border-line bg-raised text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 disabled:opacity-50 transition-colors"
          />
          {/* While something runs, the primary button STOPS it. A three-dot
              button that does nothing is the worst thing to put in front of
              someone who has decided they asked for the wrong thing. */}
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
              disabled={!input.trim()}
              className="px-4 py-2 text-[13px] font-medium text-white rounded-md bg-ocean hover:bg-ocean-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
