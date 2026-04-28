'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Sparkles, X, ArrowUp, AlertTriangle, Layers, Database, Loader2,
  MessageSquare, Wrench, Check, Plus, FileText,
} from 'lucide-react';
import { getToken } from '@/lib/auth';
import { cn } from '@/lib/cn';
import api from '@/lib/api';
import type { Connection, DataProduct } from './types';

interface AskAIPanelProps {
  open: boolean;
  onClose: () => void;
  /** When set, the panel is scoped to this product. */
  product?: DataProduct | null;
  /** All connections — used for the general (cross-product) mode picker. */
  connections: Connection[];
  /** All products — used to label the scope chip and pick a default connection in general mode. */
  products: DataProduct[];
  /** Called after a refinement is successfully applied so the parent can refetch. */
  onRefineApplied?: (productId: number) => void;
  /** When true, render inline (no backdrop, fills parent). When false (default), render as slide-over overlay. */
  embedded?: boolean;
  /** When true, hide the close button (useful for embedded mode where there's nothing to close). */
  hideClose?: boolean;
}

type Mode = 'ask' | 'refine';

// Mirror of backend RefineChange + RefineProposal
type RefineChange =
  | { op: 'update_table_description';   table_id: number;  old_value: string | null; new_value: string }
  | { op: 'update_column_description';  column_id: number; old_value: string | null; new_value: string }
  | { op: 'update_column_display_name'; column_id: number; old_value: string | null; new_value: string }
  | { op: 'update_kpi_description';     kpi_id: number;    old_value: string | null; new_value: string }
  | { op: 'update_kpi_formula';         kpi_id: number;    old_value: string | null; new_value: string }
  | { op: 'update_kpi_plain_text';      kpi_id: number;    old_value: string | null; new_value: string }
  | { op: 'add_kpi'; name: string; description: string; formula_plain_text: string; formula_sql: string }
  | { op: 'note'; message: string };

interface RefineProposal {
  summary: string;
  changes: RefineChange[];
  reasoning: string;
}

interface PanelMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  // ask-mode result
  sql?: string;
  rows?: Record<string, unknown>[];
  tablesUsed?: string[];
  confidence?: number;
  blocked?: boolean;
  error?: boolean;
  // refine-mode result
  proposal?: RefineProposal;
  applied?: { applied: number; skipped: number; notes: string[] };
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';

const SUGGESTIONS_PER_PRODUCT = [
  'Top 5 rows of the largest fact table',
  'Total revenue this year vs last year',
  'Show monthly trend for the main measure',
];

const SUGGESTIONS_GENERAL = [
  'Which product covers customer revenue?',
  'List all measures across products',
  'Compare row counts across all fact tables',
];

const REFINE_SUGGESTIONS = [
  'Make the table descriptions clearer for non-technical users',
  'Add a KPI for gross margin (revenue minus cost)',
  'Rename the customer key column to something friendlier',
];

export default function AskAIPanel({
  open,
  onClose,
  product,
  connections,
  products,
  onRefineApplied,
  embedded = false,
  hideClose = false,
}: AskAIPanelProps) {
  const [mode, setMode] = useState<Mode>('ask');
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [thinkingPhase, setThinkingPhase] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Reset chat history when scope changes
  useEffect(() => {
    setMessages([]);
    setInput('');
    setThinkingPhase('');
    setThinkingText('');
    if (!product) setMode('ask'); // refine requires a product scope
  }, [product?.id]);

  // Auto-scroll on new content
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, [messages, thinkingText, thinkingPhase, open]);

  // Focus input on open / mode switch
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 220);
  }, [open, mode]);

  // Esc to close (overlay mode only — no need to escape an embedded panel)
  useEffect(() => {
    if (!open || embedded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, embedded]);

  const resolvedConnectionId = (() => {
    if (product) return product.connection_id;
    const connWithProducts = connections.find((c) => products.some((p) => p.connection_id === c.id));
    return connWithProducts?.id ?? connections[0]?.id;
  })();

  const scopeLabel = product
    ? product.name
    : products.length > 0
      ? `${products.length} product${products.length === 1 ? '' : 's'}`
      : 'no products yet';

  const suggestions = mode === 'refine'
    ? REFINE_SUGGESTIONS
    : product ? SUGGESTIONS_PER_PRODUCT : SUGGESTIONS_GENERAL;

  async function sendAsk(q: string) {
    setThinking(true);
    setThinkingPhase('Thinking…');
    setThinkingText('');

    try {
      const token = getToken();
      const response = await fetch(`${BACKEND_URL}/api/query/think`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          connectionId: resolvedConnectionId,
          question:     q,
          dataLayer:    'product' as const,
          ...(product?.id ? { productId: product.id } : {}),
        }),
      });

      if (!response.ok || !response.body) {
        const friendly = response.status === 401
          ? 'Your session expired. Please sign in again.'
          : response.status >= 500
            ? 'The server hit an error. Please try again.'
            : `Could not run your question (HTTP ${response.status}).`;
        setMessages((prev) => [...prev, { id: nextId.current++, role: 'assistant', text: friendly, error: true }]);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = done ? '' : (lines.pop() ?? '');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { continue; }

          const type = event.type as string;
          if (type === 'phase') {
            setThinkingPhase(event.text as string);
          } else if (type === 'thinking') {
            setThinkingText((prev) => prev + (event.text as string));
          } else if (type === 'done') {
            const d = event.data as {
              answer: string; confidence: number; blocked?: boolean; sql?: string;
              tablesUsed?: string[]; rows?: Record<string, unknown>[];
            };
            setMessages((prev) => [...prev, {
              id: nextId.current++,
              role: 'assistant',
              text: d.answer,
              sql: d.sql,
              tablesUsed: d.tablesUsed,
              rows: d.rows,
              confidence: d.confidence,
              blocked: d.blocked,
            }]);
          } else if (type === 'error') {
            setMessages((prev) => [...prev, {
              id: nextId.current++, role: 'assistant',
              text: (event.message as string) || 'Something went wrong.',
              error: true,
            }]);
          }
        }
        if (done) break;
      }
    } catch {
      setMessages((prev) => [...prev, {
        id: nextId.current++, role: 'assistant',
        text: 'Something went wrong. Please try again.', error: true,
      }]);
    } finally {
      setThinking(false);
      setThinkingPhase('');
      setThinkingText('');
    }
  }

  async function sendRefine(q: string) {
    if (!product) return;
    setThinking(true);
    setThinkingPhase('Reading the product…');
    setThinkingText('');

    try {
      // gentle phase hints while the request is in flight
      const phaseTimer = setTimeout(() => setThinkingPhase('Drafting changes…'), 600);

      const { data } = await api.post<{ ok: boolean; data: RefineProposal; error?: string }>(
        `/api/products/${product.id}/refine`,
        { instruction: q },
      );

      clearTimeout(phaseTimer);

      if (!data.ok || !data.data) {
        setMessages((prev) => [...prev, {
          id: nextId.current++, role: 'assistant',
          text: data.error || 'Could not draft changes.', error: true,
        }]);
        return;
      }

      const proposal = data.data;
      const summary = proposal.summary?.trim() || (proposal.changes.length === 0
        ? 'No metadata changes proposed.'
        : `Proposing ${proposal.changes.length} change${proposal.changes.length === 1 ? '' : 's'}.`);

      setMessages((prev) => [...prev, {
        id: nextId.current++,
        role: 'assistant',
        text: summary,
        proposal,
      }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong.';
      setMessages((prev) => [...prev, {
        id: nextId.current++, role: 'assistant',
        text: msg, error: true,
      }]);
    } finally {
      setThinking(false);
      setThinkingPhase('');
      setThinkingText('');
    }
  }

  async function applyProposal(messageId: number, proposal: RefineProposal) {
    if (!product) return;
    // optimistic — mark message as applying
    try {
      const { data } = await api.post<{
        ok: boolean;
        data?: { applied: number; skipped: { change: RefineChange; reason: string }[]; notes: string[] };
        error?: string;
      }>(`/api/products/${product.id}/refine/apply`, { changes: proposal.changes });

      if (!data.ok || !data.data) {
        setMessages((prev) => [...prev, {
          id: nextId.current++, role: 'assistant',
          text: data.error || 'Could not apply changes.', error: true,
        }]);
        return;
      }

      const result = data.data;
      // Mark the message as applied
      setMessages((prev) => prev.map((m) =>
        m.id === messageId
          ? { ...m, applied: { applied: result.applied, skipped: result.skipped.length, notes: result.notes } }
          : m
      ));

      onRefineApplied?.(product.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong.';
      setMessages((prev) => [...prev, {
        id: nextId.current++, role: 'assistant',
        text: msg, error: true,
      }]);
    }
  }

  async function send(rawQuestion?: string) {
    const q = (rawQuestion ?? input).trim();
    if (!q || thinking) return;
    if (!resolvedConnectionId) return;
    if (mode === 'refine' && !product) return;

    const userMsg: PanelMessage = { id: nextId.current++, role: 'user', text: q };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');

    if (mode === 'refine') await sendRefine(q);
    else await sendAsk(q);

    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (!open) return null;

  const refineDisabled = !product;
  const placeholder = mode === 'refine'
    ? `What should change in ${product?.name ?? 'this product'}?`
    : product ? `Ask about ${product.name}…` : 'Ask across all products…';

  return (
    <>
      {!embedded && (
        <div
          className="fixed inset-0 bg-ink/20 backdrop-blur-[1px] z-40 animate-fadeIn"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        role={embedded ? undefined : 'dialog'}
        aria-label="Ask AI"
        className={cn(
          'flex flex-col bg-raised',
          embedded
            ? 'h-full w-full border-l border-line'
            : 'fixed top-0 right-0 bottom-0 w-full sm:w-[480px] border-l border-line z-50 shadow-3 ai-panel-enter',
        )}
      >
        {/* Header */}
        <header className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={cn(
              'w-7 h-7 rounded-md flex items-center justify-center shrink-0',
              'bg-ocean-softer text-ocean',
              thinking && 'ai-halo'
            )}>
              <Sparkles className={cn('w-3.5 h-3.5', thinking && 'ai-sparkle')} strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted leading-none mb-0.5">
                {product ? 'AI for' : 'AI across'}
              </p>
              <h2
                className="font-display text-[15px] text-ink leading-tight tracking-[-0.01em] truncate"
                title={scopeLabel}
              >
                {scopeLabel}
              </h2>
            </div>
          </div>
          {!hideClose && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-7 h-7 flex items-center justify-center text-muted hover:text-ink rounded-sm hover:bg-softer transition-colors"
            >
              <X className="w-4 h-4" strokeWidth={1.75} />
            </button>
          )}
        </header>

        {/* Mode toggle */}
        <div className="px-5 pt-3 pb-2 border-b border-line shrink-0 bg-raised">
          <div className="inline-flex bg-softer rounded-md p-0.5 text-[12px]">
            <button
              type="button"
              onClick={() => { setMode('ask'); setMessages([]); }}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-sm font-medium transition-colors',
                mode === 'ask' ? 'bg-raised text-ink shadow-1' : 'text-muted hover:text-ink-2'
              )}
            >
              <MessageSquare className="w-3 h-3" strokeWidth={1.75} />
              Ask
            </button>
            <button
              type="button"
              disabled={refineDisabled}
              onClick={() => { if (!refineDisabled) { setMode('refine'); setMessages([]); } }}
              title={refineDisabled ? 'Open a product to refine it' : undefined}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-sm font-medium transition-colors',
                refineDisabled
                  ? 'text-muted-2 cursor-not-allowed'
                  : mode === 'refine' ? 'bg-raised text-ink shadow-1' : 'text-muted hover:text-ink-2'
              )}
            >
              <Wrench className="w-3 h-3" strokeWidth={1.75} />
              Refine
            </button>
          </div>
          <p className="text-[11px] text-muted mt-1.5 leading-snug">
            {mode === 'refine'
              ? 'Tell me what to fix or improve. I\u2019ll propose safe metadata edits you can review and apply.'
              : product
                ? 'Ask any question about this product\u2019s data.'
                : 'Ask across every product. I\u2019ll pick the right one.'}
          </p>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {messages.length === 0 && !thinking && (
            <EmptyState
              hasProducts={products.length > 0}
              suggestions={suggestions}
              onPick={(s) => send(s)}
              productMode={!!product}
              mode={mode}
            />
          )}

          {messages.map((m) => (
            <MessageRow
              key={m.id}
              msg={m}
              onApply={(p) => applyProposal(m.id, p)}
            />
          ))}

          {thinking && (
            <ThinkingRow phase={thinkingPhase} text={thinkingText} mode={mode} />
          )}
        </div>

        {/* Input */}
        <footer className="shrink-0 border-t border-line px-4 py-3 bg-raised">
          <div className={cn(
            'flex items-end gap-2 rounded-md border bg-surface px-3 py-2 transition-colors',
            thinking ? 'border-ocean ai-halo' : 'border-line focus-within:border-ocean focus-within:shadow-[0_0_0_3px_var(--ocean-soft)]'
          )}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={placeholder}
              disabled={thinking || !resolvedConnectionId || (mode === 'refine' && !product)}
              className="flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-muted-2 focus:outline-none resize-none leading-relaxed max-h-32 min-h-[20px]"
            />
            <button
              type="button"
              onClick={() => send()}
              disabled={!input.trim() || thinking || !resolvedConnectionId || (mode === 'refine' && !product)}
              aria-label="Send"
              className={cn(
                'w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-all',
                input.trim() && !thinking && resolvedConnectionId && !(mode === 'refine' && !product)
                  ? 'bg-ocean text-white hover:bg-ocean-hover'
                  : 'bg-softer text-muted-2'
              )}
            >
              {thinking ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} /> : <ArrowUp className="w-3.5 h-3.5" strokeWidth={2} />}
            </button>
          </div>
          {!resolvedConnectionId && (
            <p className="text-[11px] text-muted mt-1.5 flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" strokeWidth={1.75} />
              Connect a source first to ask questions.
            </p>
          )}
        </footer>
      </aside>
    </>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function EmptyState({
  hasProducts,
  suggestions,
  onPick,
  productMode,
  mode,
}: {
  hasProducts: boolean;
  suggestions: string[];
  onPick: (s: string) => void;
  productMode: boolean;
  mode: Mode;
}) {
  if (!hasProducts) {
    return (
      <div className="text-center py-12 px-4">
        <Database className="w-7 h-7 mx-auto text-muted-2 mb-3" strokeWidth={1.5} />
        <p className="text-[13px] text-ink-2">No data products yet.</p>
        <p className="text-[12px] text-muted mt-1 leading-relaxed">
          Build one with &ldquo;Prepare my data&rdquo; to ask AI about it here.
        </p>
      </div>
    );
  }
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 mb-3">
        {mode === 'refine'
          ? <Wrench className="w-3.5 h-3.5 text-ocean" strokeWidth={1.75} />
          : <Layers className="w-3.5 h-3.5 text-ocean" strokeWidth={1.75} />
        }
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">
          {mode === 'refine'
            ? 'Refining this product'
            : productMode ? 'Scoped to this product' : 'Across all products'}
        </p>
      </div>
      <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted-2 mb-2">Try</p>
      <div className="flex flex-col gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="text-left px-3 py-2 rounded-md border border-line hover:border-ocean hover:bg-ocean-softer/40 text-[13px] text-ink-2 hover:text-ocean transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageRow({ msg, onApply }: { msg: PanelMessage; onApply: (p: RefineProposal) => void }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] bg-ocean text-white rounded-2xl rounded-br-sm px-3.5 py-2 text-[13.5px] leading-relaxed">
          {msg.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Sparkles className="w-3 h-3 text-ocean" strokeWidth={1.75} />
        <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">AI</span>
        {typeof msg.confidence === 'number' && !msg.blocked && !msg.error && !msg.proposal && (
          <span className="text-[10px] font-mono text-muted-2 tabular-nums ml-1">
            {Math.round(msg.confidence * 100)}% confidence
          </span>
        )}
      </div>
      <div className={cn(
        'rounded-md px-3.5 py-2.5 text-[13.5px] leading-relaxed',
        msg.error
          ? 'bg-err-soft text-err border border-err/30'
          : msg.blocked
            ? 'bg-warn-soft text-ink border border-warn/30'
            : 'bg-softer text-ink border border-line'
      )}>
        {msg.text}
      </div>
      {msg.rows && msg.rows.length > 0 && <PreviewRows rows={msg.rows} />}
      {msg.proposal && (
        <ProposalCard
          proposal={msg.proposal}
          applied={msg.applied}
          onApply={() => onApply(msg.proposal!)}
        />
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  applied,
  onApply,
}: {
  proposal: RefineProposal;
  applied?: { applied: number; skipped: number; notes: string[] };
  onApply: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const editable = proposal.changes.filter((c) => c.op !== 'note');
  const notes = proposal.changes.filter((c): c is Extract<RefineChange, { op: 'note' }> => c.op === 'note');

  if (proposal.changes.length === 0) {
    return (
      <div className="rounded-md border border-line bg-surface px-3.5 py-2.5">
        {proposal.reasoning && (
          <p className="text-[12px] text-muted leading-relaxed">{proposal.reasoning}</p>
        )}
      </div>
    );
  }

  if (applied) {
    return (
      <div className="rounded-md border border-ok/30 bg-ok-soft/60 px-3.5 py-2.5">
        <div className="flex items-center gap-2 mb-1.5">
          <Check className="w-3.5 h-3.5 text-ok" strokeWidth={2} />
          <p className="text-[12px] font-medium text-ok">
            Applied {applied.applied} change{applied.applied === 1 ? '' : 's'}
            {applied.skipped > 0 && ` \u00b7 ${applied.skipped} skipped`}
          </p>
        </div>
        {applied.notes.length > 0 && (
          <ul className="text-[11.5px] text-ink-2 list-disc pl-4 space-y-0.5">
            {applied.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-line bg-surface overflow-hidden">
      <div className="px-3.5 py-2 bg-softer border-b border-line flex items-center gap-2">
        <Wrench className="w-3 h-3 text-ocean" strokeWidth={1.75} />
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Proposed changes</p>
        <span className="text-[10px] font-mono text-muted-2 ml-auto tabular-nums">
          {editable.length} edit{editable.length === 1 ? '' : 's'}
          {notes.length > 0 && ` \u00b7 ${notes.length} manual`}
        </span>
      </div>
      <div className="divide-y divide-line">
        {proposal.changes.map((c, i) => <ChangeRow key={i} change={c} />)}
      </div>
      {proposal.reasoning && (
        <div className="px-3.5 py-2 border-t border-line bg-softer/50">
          <p className="text-[11.5px] text-muted leading-relaxed italic">{proposal.reasoning}</p>
        </div>
      )}
      <div className="px-3.5 py-2.5 border-t border-line flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={async () => { setBusy(true); try { onApply(); } finally { setBusy(false); } }}
          disabled={busy || editable.length === 0}
          className={cn(
            'inline-flex items-center gap-1.5 text-[12px] font-medium rounded-md px-3 py-1.5 transition-colors',
            editable.length === 0
              ? 'bg-softer text-muted-2 cursor-not-allowed'
              : 'bg-ocean text-white hover:bg-ocean-hover'
          )}
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" strokeWidth={2} />}
          Apply {editable.length > 0 ? `${editable.length} change${editable.length === 1 ? '' : 's'}` : ''}
        </button>
      </div>
    </div>
  );
}

function ChangeRow({ change }: { change: RefineChange }) {
  switch (change.op) {
    case 'update_table_description':
      return <DiffRow label="Table description" oldVal={change.old_value} newVal={change.new_value} />;
    case 'update_column_description':
      return <DiffRow label="Column description" oldVal={change.old_value} newVal={change.new_value} />;
    case 'update_column_display_name':
      return <DiffRow label="Column display name" oldVal={change.old_value} newVal={change.new_value} />;
    case 'update_kpi_description':
      return <DiffRow label="KPI description" oldVal={change.old_value} newVal={change.new_value} />;
    case 'update_kpi_formula':
      return <DiffRow label="KPI formula (SQL)" oldVal={change.old_value} newVal={change.new_value} mono />;
    case 'update_kpi_plain_text':
      return <DiffRow label="KPI plain text" oldVal={change.old_value} newVal={change.new_value} />;
    case 'add_kpi':
      return (
        <div className="px-3.5 py-2">
          <div className="flex items-center gap-1.5 mb-1">
            <Plus className="w-3 h-3 text-ok" strokeWidth={2} />
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-ok">New KPI</p>
            <p className="text-[12px] text-ink font-medium ml-1">{change.name}</p>
          </div>
          {change.description && (
            <p className="text-[12px] text-ink-2 leading-relaxed mb-1">{change.description}</p>
          )}
          {change.formula_plain_text && (
            <p className="text-[11.5px] text-muted leading-relaxed mb-0.5">
              <span className="font-mono text-[10px] text-muted-2 mr-1">PLAIN</span>
              {change.formula_plain_text}
            </p>
          )}
          {change.formula_sql && (
            <p className="text-[11.5px] font-mono text-ink-2 leading-relaxed bg-softer rounded px-1.5 py-0.5 inline-block mt-1">
              {change.formula_sql}
            </p>
          )}
        </div>
      );
    case 'note':
      return (
        <div className="px-3.5 py-2 bg-warn-soft/50">
          <div className="flex items-start gap-1.5">
            <FileText className="w-3 h-3 text-warn mt-0.5 shrink-0" strokeWidth={1.75} />
            <div>
              <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-warn mb-0.5">Manual step</p>
              <p className="text-[12px] text-ink-2 leading-relaxed">{change.message}</p>
            </div>
          </div>
        </div>
      );
  }
}

function DiffRow({
  label,
  oldVal,
  newVal,
  mono,
}: {
  label: string;
  oldVal: string | null;
  newVal: string;
  mono?: boolean;
}) {
  const valClass = cn('text-[12px] leading-relaxed', mono && 'font-mono text-[11.5px]');
  return (
    <div className="px-3.5 py-2">
      <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-1">{label}</p>
      {oldVal && (
        <p className={cn(valClass, 'text-err line-through opacity-70 mb-0.5')}>{oldVal}</p>
      )}
      <p className={cn(valClass, 'text-ok')}>{newVal}</p>
    </div>
  );
}

function PreviewRows({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Object.keys(rows[0] ?? {});
  if (cols.length === 0) return null;
  const shown = rows.slice(0, 6);
  return (
    <div className="border border-line rounded-md overflow-hidden text-[11.5px]">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-softer">
            <tr>
              {cols.map((c) => (
                <th key={c} className="text-left px-2.5 py-1.5 font-mono text-muted text-[10px] tracking-[0.06em] uppercase font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="border-t border-line">
                {cols.map((c) => (
                  <td key={c} className="px-2.5 py-1.5 text-ink-2 tabular-nums">
                    {fmt(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && (
        <div className="px-2.5 py-1 bg-softer text-[10px] font-mono text-muted text-center">
          {rows.length - shown.length} more row{rows.length - shown.length === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '\u2014';
  if (typeof v === 'number') return v.toLocaleString('en-GB');
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function ThinkingRow({ phase, text, mode }: { phase: string; text: string; mode: Mode }) {
  const label = mode === 'refine' ? 'AI is drafting changes' : 'AI is thinking';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Sparkles className="w-3 h-3 text-ocean ai-sparkle" strokeWidth={1.75} />
        <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-ocean">{label}</span>
        <span className="inline-flex gap-0.5 ml-0.5">
          <span className="w-1 h-1 rounded-full bg-ocean ai-typing-dot" style={{ animationDelay: '0s' }} />
          <span className="w-1 h-1 rounded-full bg-ocean ai-typing-dot" style={{ animationDelay: '0.15s' }} />
          <span className="w-1 h-1 rounded-full bg-ocean ai-typing-dot" style={{ animationDelay: '0.3s' }} />
        </span>
      </div>
      <div className="rounded-md px-3.5 py-2.5 text-[13px] leading-relaxed bg-softer border border-line text-ink-2 ai-sheen">
        {phase && <p className="text-[11px] font-mono text-ocean mb-1">{phase}</p>}
        {text
          ? <p className="whitespace-pre-wrap">{text}</p>
          : <p className="text-muted italic">
              {mode === 'refine' ? 'Reviewing your product\u2019s tables, columns, and KPIs\u2026' : 'Loading context and reasoning\u2026'}
            </p>
        }
      </div>
    </div>
  );
}
