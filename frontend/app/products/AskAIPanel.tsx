'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Sparkles, X, ArrowUp, AlertTriangle, Database, Loader2,
  Wrench, Check, Plus, FileText, Target,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import api from '@/lib/api';
import type { Connection, DataProduct } from './types';

interface AskAIPanelProps {
  open: boolean;
  onClose: () => void;
  /** When set, the panel is scoped to this product. */
  product?: DataProduct | null;
  /** All connections — used to resolve a default connection. */
  connections: Connection[];
  /** All products — used for cross-product refine. */
  products: DataProduct[];
  /** Called after a refinement is successfully applied so the parent can refetch. */
  onRefineApplied?: (productId: number) => void;
  /** When true, render inline (no backdrop, fills parent). When false (default), render as slide-over overlay. */
  embedded?: boolean;
  /** When true, hide the close button (useful for embedded mode where there's nothing to close). */
  hideClose?: boolean;
}

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
  target_product_id?: number;
  target_product_name?: string;
  summary: string;
  changes: RefineChange[];
  reasoning: string;
}

interface PanelMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  error?: boolean;
  // refine-mode result
  proposal?: RefineProposal;
  targetProductId?: number;
  targetProductName?: string;
  applied?: { applied: number; skipped: number; notes: string[] };
}

const SUGGESTIONS_PER_PRODUCT = [
  'Make the table descriptions clearer for non-technical users',
  'Add a KPI for gross margin (revenue minus cost)',
  'Rename the customer key column to something friendlier',
];

const SUGGESTIONS_GENERAL = [
  'I want to filter bank transactions by bank account',
  'Add a KPI for total revenue per customer',
  'Make all column descriptions more business-friendly',
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
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [thinkingPhase, setThinkingPhase] = useState('');
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Reset chat history when scope changes
  useEffect(() => {
    setMessages([]);
    setInput('');
    setThinkingPhase('');
  }, [product?.id]);

  // Auto-scroll on new content
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, [messages, thinkingPhase, open]);

  // Focus input on open
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 220);
  }, [open]);

  // Esc to close (overlay mode only)
  useEffect(() => {
    if (!open || embedded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, embedded]);

  const scopeLabel = product
    ? product.name
    : products.length > 0
      ? `${products.length} product${products.length === 1 ? '' : 's'}`
      : 'no products yet';

  const suggestions = product ? SUGGESTIONS_PER_PRODUCT : SUGGESTIONS_GENERAL;

  async function sendRefine(q: string) {
    setThinking(true);
    setThinkingPhase(product ? 'Reading the product…' : 'Analysing all products…');

    try {
      const phaseTimer = setTimeout(
        () => setThinkingPhase(product ? 'Drafting changes…' : 'Identifying the right product…'),
        600,
      );

      let data: { ok: boolean; data: RefineProposal; error?: string };

      if (product) {
        const resp = await api.post<typeof data>(`/api/products/${product.id}/refine`, { instruction: q });
        data = resp.data;
      } else {
        const resp = await api.post<typeof data>('/api/products/refine', { instruction: q });
        data = resp.data;
      }

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
        targetProductId: proposal.target_product_id,
        targetProductName: proposal.target_product_name,
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
    }
  }

  async function applyProposal(messageId: number, proposal: RefineProposal) {
    const targetId = product?.id ?? proposal.target_product_id;
    if (!targetId) return;
    try {
      const { data } = await api.post<{
        ok: boolean;
        data?: { applied: number; skipped: { change: RefineChange; reason: string }[]; notes: string[] };
        error?: string;
      }>(`/api/products/${targetId}/refine/apply`, { changes: proposal.changes });

      if (!data.ok || !data.data) {
        setMessages((prev) => [...prev, {
          id: nextId.current++, role: 'assistant',
          text: data.error || 'Could not apply changes.', error: true,
        }]);
        return;
      }

      const result = data.data;
      setMessages((prev) => prev.map((m) =>
        m.id === messageId
          ? { ...m, applied: { applied: result.applied, skipped: result.skipped.length, notes: result.notes } }
          : m
      ));

      onRefineApplied?.(targetId);
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
    if (products.length === 0) return;

    const userMsg: PanelMessage = { id: nextId.current++, role: 'user', text: q };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');

    await sendRefine(q);

    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (!open) return null;

  const placeholder = product
    ? `What should change in ${product.name}?`
    : 'Describe what you want to improve or change…';
  const disabled = thinking || products.length === 0;

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
        aria-label="Refine products"
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
              <Wrench className={cn('w-3.5 h-3.5', thinking && 'ai-sparkle')} strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted leading-none mb-0.5">
                {product ? 'Refine' : 'Refine across'}
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

        {/* Description strip */}
        <div className="px-5 pt-3 pb-2 border-b border-line shrink-0 bg-raised">
          <p className="text-[11px] text-muted leading-snug">
            {product
              ? 'Tell me what to fix or improve. I’ll propose changes you can review and apply.'
              : 'Describe what you need — I’ll figure out which product to change and propose edits you can review.'}
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
            />
          )}

          {messages.map((m) => (
            <MessageRow
              key={m.id}
              msg={m}
              onApply={(p) => applyProposal(m.id, p)}
              isCrossProduct={!product}
            />
          ))}

          {thinking && (
            <ThinkingRow phase={thinkingPhase} />
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
              disabled={disabled}
              className="flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-muted-2 focus:outline-none resize-none leading-relaxed max-h-32 min-h-[20px]"
            />
            <button
              type="button"
              onClick={() => send()}
              disabled={!input.trim() || disabled}
              aria-label="Send"
              className={cn(
                'w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-all',
                input.trim() && !disabled
                  ? 'bg-ocean text-white hover:bg-ocean-hover'
                  : 'bg-softer text-muted-2'
              )}
            >
              {thinking ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} /> : <ArrowUp className="w-3.5 h-3.5" strokeWidth={2} />}
            </button>
          </div>
          {products.length === 0 && (
            <p className="text-[11px] text-muted mt-1.5 flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" strokeWidth={1.75} />
              Build a data product first to start refining.
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
}: {
  hasProducts: boolean;
  suggestions: string[];
  onPick: (s: string) => void;
  productMode: boolean;
}) {
  if (!hasProducts) {
    return (
      <div className="text-center py-12 px-4">
        <Database className="w-7 h-7 mx-auto text-muted-2 mb-3" strokeWidth={1.5} />
        <p className="text-[13px] text-ink-2">No data products yet.</p>
        <p className="text-[12px] text-muted mt-1 leading-relaxed">
          Build one with &ldquo;Prepare my data&rdquo; to start refining.
        </p>
      </div>
    );
  }
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 mb-3">
        <Wrench className="w-3.5 h-3.5 text-ocean" strokeWidth={1.75} />
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">
          {productMode ? 'Refine this product' : 'Refine your products'}
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

function MessageRow({ msg, onApply, isCrossProduct }: { msg: PanelMessage; onApply: (p: RefineProposal) => void; isCrossProduct: boolean }) {
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
      </div>

      {/* Cross-product target indicator */}
      {isCrossProduct && msg.targetProductName && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-ocean-softer/40 border border-ocean/20">
          <Target className="w-3 h-3 text-ocean" strokeWidth={1.75} />
          <span className="text-[11px] font-medium text-ocean">{msg.targetProductName}</span>
        </div>
      )}

      <div className={cn(
        'rounded-md px-3.5 py-2.5 text-[13.5px] leading-relaxed',
        msg.error
          ? 'bg-err-soft text-err border border-err/30'
          : 'bg-softer text-ink border border-line'
      )}>
        {msg.text}
      </div>
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
            {applied.skipped > 0 && ` · ${applied.skipped} skipped`}
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
          {notes.length > 0 && ` · ${notes.length} manual`}
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

function ThinkingRow({ phase }: { phase: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Sparkles className="w-3 h-3 text-ocean ai-sparkle" strokeWidth={1.75} />
        <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-ocean">AI is drafting changes</span>
        <span className="inline-flex gap-0.5 ml-0.5">
          <span className="w-1 h-1 rounded-full bg-ocean ai-typing-dot" style={{ animationDelay: '0s' }} />
          <span className="w-1 h-1 rounded-full bg-ocean ai-typing-dot" style={{ animationDelay: '0.15s' }} />
          <span className="w-1 h-1 rounded-full bg-ocean ai-typing-dot" style={{ animationDelay: '0.3s' }} />
        </span>
      </div>
      <div className="rounded-md px-3.5 py-2.5 text-[13px] leading-relaxed bg-softer border border-line text-ink-2 ai-sheen">
        {phase && <p className="text-[11px] font-mono text-ocean mb-1">{phase}</p>}
        <p className="text-muted italic">Reviewing your product tables, columns, and KPIs…</p>
      </div>
    </div>
  );
}
