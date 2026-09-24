'use client';

/**
 * The catalog assistant — a floating chat aimed at whatever is selected.
 *
 * Same shape as the dashboard and notebook assistants (a bottom-right pill
 * that opens into a panel, only the newest exchange expanded, anything
 * running says how long it has run) and for the same reason: the catalog's
 * job is the tree and the declaration, and a chat welded into that layout
 * would cost the one thing the page is for.
 *
 * Two things it does, and the scope chip says which node they are about:
 *   • ASK — a question about the selected subject or table, answered from
 *     the real catalog (the subject assistant, with a table anchor).
 *   • CHANGE — on a product table, for a curator: describe a change to the
 *     SQL; the proposal appears ON the table as a diff with Keep / Discard.
 *     Nothing is stored until Keep, and Keep is the editor's own Save.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Square } from 'lucide-react';
import { ClarionMark } from '@/components/brand/ClarionMark';
import { MarkdownAnswer } from '@/app/dashboards/components/MarkdownAnswer';

export interface AssistantScope {
  /** What the next message is about. */
  kind: 'subject' | 'table' | 'source' | 'source-table' | 'none';
  label: string;
  /** Postgres product_tables id when a product table is selected. */
  tableId?: number | null;
  productId?: number | null;
  /** True when a curator is on a product table whose SQL can be changed here. */
  canChange: boolean;
}

export interface CatalogChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** What the message was about, e.g. "Finance › Sales lines". */
  scopeLabel?: string;
  mode?: 'ask' | 'change';
  /** For a change: what became of the proposal. */
  decision?: 'pending' | 'kept' | 'discarded' | 'none';
  working?: boolean;
  startedAt?: number;
  errorDetail?: string;
}

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

function CollapsedMessage({ msg, onExpand }: { msg: CatalogChatMessage; onExpand: () => void }) {
  const label = msg.errorDetail
    ? 'Could not do that'
    : msg.decision === 'kept' ? 'Kept — the SQL was saved'
      : msg.decision === 'discarded' ? 'Discarded — your SQL kept'
        : msg.text.split('\n')[0].replace(/\*\*/g, '').slice(0, 64) || 'Answered';
  return (
    <button
      type="button"
      onClick={onExpand}
      className="w-full flex items-center gap-2 text-left px-3 py-1.5 rounded-md border border-line bg-softer hover:bg-soft transition-colors group/collapsed"
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${msg.errorDetail ? 'bg-warn' : msg.decision === 'discarded' ? 'bg-line-strong' : 'bg-ok'}`} />
      <span className="flex-1 min-w-0 truncate text-[12px] text-muted group-hover/collapsed:text-ink-2 transition-colors">{label}</span>
      <ChevronDown className="w-3 h-3 text-muted-2 shrink-0" strokeWidth={2} />
    </button>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: AssistantScope;
  messages: CatalogChatMessage[];
  loading: boolean;
  mode: 'ask' | 'change';
  onModeChange: (mode: 'ask' | 'change') => void;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}

export default function CatalogAssistant({
  open, onOpenChange, scope, messages, loading, mode, onModeChange, input, onInputChange, onSubmit, onStop,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const working = messages.find((m) => m.working);
  const lastAssistantId = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant')?.id, [messages]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, scope.label]);

  // Change only makes sense on a product table a curator may edit.
  const effectiveMode: 'ask' | 'change' = scope.canChange ? mode : 'ask';

  if (!open) {
    return (
      <motion.button
        type="button"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        onClick={() => onOpenChange(true)}
        className="absolute bottom-5 right-5 z-30 flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-full border border-line bg-raised shadow-[0_6px_24px_-8px_rgba(15,32,45,0.30)] hover:border-line-strong transition-colors max-w-[min(420px,calc(100%-2.5rem))]"
        aria-label={working ? 'The assistant is working — open to watch' : 'Open the assistant'}
      >
        <ClarionMark size={16} state={working ? 'working' : 'idle'} className="shrink-0" />
        <span className="text-[13px] text-ink-2 truncate">
          {working ? (working.mode === 'change' ? 'Proposing a change…' : 'Answering…') : scope.kind === 'none' ? 'Ask about your data' : `Ask about ${scope.label}`}
        </span>
        {working && <Elapsed since={working.startedAt} active />}
      </motion.button>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      className="absolute bottom-5 right-5 z-30 w-[min(440px,calc(100%-2.5rem))] max-h-[min(72vh,660px)] flex flex-col rounded-xl border border-line bg-raised shadow-[0_16px_48px_-16px_rgba(15,32,45,0.38)] overflow-hidden"
      role="dialog"
      aria-label="Catalog assistant"
    >
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-line bg-soft shrink-0">
        <ClarionMark size={16} state={working ? 'working' : 'idle'} className="shrink-0" />
        <span className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted-2 flex-1">Assistant</span>
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

      {/* Scope — set by what is selected, never typed. A scope you cannot see
          is a scope you get stuck in, so it always shows. */}
      <div className="px-4 py-2 flex items-center gap-2 border-b border-line bg-ocean-softer shrink-0">
        <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-ocean shrink-0">
          {scope.kind === 'none' ? 'About' : effectiveMode === 'change' ? 'Changing' : 'About'}
        </span>
        <span className="flex-1 min-w-0 truncate text-[12.5px] text-ink-2">
          {scope.kind === 'none' ? 'your data — pick something on the left to aim at it' : scope.label}
        </span>
      </div>

      {messages.length > 0 && (
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
          {messages.map((msg) => {
            if (msg.role === 'user') {
              return (
                <p key={msg.id} className="text-[13.5px] text-right text-ink-2 font-display italic leading-relaxed pl-6">
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
                  onExpand={() => setExpandedIds((prev) => new Set(prev).add(msg.id))}
                />
              );
            }
            return (
              <div
                key={msg.id}
                className={`px-3.5 py-2.5 rounded-lg border text-[13px] ${
                  msg.errorDetail
                    ? 'bg-warn-soft border-warn/40 text-ink-2'
                    : msg.mode === 'change'
                      ? msg.decision === 'kept' ? 'bg-ok-soft border-line text-ink-2' : 'bg-ocean-softer border-line text-ink-2'
                      : 'bg-softer border-line text-ink'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-mono tracking-[0.08em] uppercase ${
                    msg.errorDetail ? 'text-warn' : msg.mode === 'change' ? (msg.decision === 'kept' ? 'text-ok' : 'text-ocean') : 'text-muted-2'
                  }`}>
                    {msg.errorDetail ? 'Error'
                      : msg.mode === 'change'
                        ? msg.working ? 'Proposing a change'
                          : msg.decision === 'kept' ? 'Kept — saved'
                            : msg.decision === 'discarded' ? 'Discarded'
                              : msg.decision === 'pending' ? 'Waiting for you, on the table'
                                : 'No change'
                        : msg.scopeLabel ? msg.scopeLabel : 'Answer'}
                  </span>
                  <span className="flex-1" />
                  <Elapsed since={msg.startedAt} active={!!msg.working} />
                </div>
                {msg.text && <MarkdownAnswer text={msg.text} />}
                {msg.working && (
                  <p className="text-[12px] text-muted italic mt-1.5 flex items-center gap-2">
                    <ClarionMark size={16} state="working" className="shrink-0" />
                    {msg.mode === 'change' ? 'Reading the SQL and the tables it can use…' : 'Reading the catalog…'}
                  </p>
                )}
                {msg.errorDetail && (
                  <p className="mt-1.5 text-[11.5px] font-mono text-ink-2 break-words">{msg.errorDetail}</p>
                )}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}

      <div className="shrink-0 border-t border-line">
        {scope.canChange && (
          <div className="px-4 pt-2.5 pb-1 flex items-center gap-1.5">
            {(['ask', 'change'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onModeChange(m)}
                className={`px-2.5 py-0.5 text-[10px] font-mono tracking-[0.08em] uppercase rounded-full border transition-colors ${
                  effectiveMode === m
                    ? 'bg-ocean-softer border-ocean-soft text-ocean'
                    : 'bg-transparent border-line text-muted hover:text-ink-2 hover:border-line-strong'
                }`}
                aria-pressed={effectiveMode === m}
              >
                {m === 'ask' ? 'Ask' : 'Change the SQL'}
              </button>
            ))}
          </div>
        )}
        <div className={`px-4 pb-3 flex gap-2 ${scope.canChange ? 'pt-1' : 'pt-3'}`}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSubmit();
              if (e.key === 'Escape') {
                if (loading) onStop();
                else onOpenChange(false);
              }
            }}
            placeholder={
              effectiveMode === 'change'
                ? 'e.g. add the customer country, or leave out credit notes…'
                : scope.kind === 'table' || scope.kind === 'source-table'
                  ? 'What does this table hold? What does a column mean?'
                  : scope.kind === 'subject'
                    ? 'What can this subject answer? Is X in it?'
                    : 'Where is X? Which subject covers Y?'
            }
            disabled={loading}
            className="flex-1 min-w-0 px-3 py-2 text-[13px] rounded-md border border-line bg-raised text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 disabled:opacity-50 transition-colors"
          />
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
              {effectiveMode === 'change' ? 'Propose' : 'Ask'}
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
