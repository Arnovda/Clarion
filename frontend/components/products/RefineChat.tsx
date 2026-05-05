'use client';

/**
 * <RefineChat> — slide-over panel for per-product conversational editing.
 *
 * Phase 2 of the Refine feature. Users type a natural-language ask;
 * the AI returns a structured proposal (add column / modify column /
 * add KPI) that the user reviews and approves with a diff. Approved
 * proposals are applied to product_columns / product_tables /
 * product_kpis. The conversation is team-visible — every team member
 * sees the same log per product.
 *
 * Slides in from the right edge, ~520px wide. Doesn't claim a tab in
 * the existing tab bar; doesn't dim the underlying canvas (the user
 * needs to keep referencing the schema while chatting).
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  X, Send, Loader2, MessageSquarePlus, Sparkles,
  Check, Trash2, AlertCircle, HelpCircle, Ban, ChevronDown, ChevronUp,
} from 'lucide-react';
import { format as sqlFormatter } from 'sql-formatter';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { formatRelativeShort } from '@/lib/dates';

/**
 * Pretty-print SQL with sql-formatter — same library + dialect the SQL
 * tab uses. Falls back to the raw string if the parser chokes (rare;
 * happens on very malformed AI output, in which case raw is more useful
 * than a parser error).
 */
function prettySql(sql: string): string {
  try {
    return sqlFormatter(sql, { language: 'duckdb', tabWidth: 2, keywordCase: 'lower' });
  } catch {
    return sql;
  }
}

interface RefineChatProps {
  productId: number;
  productName: string;
  open: boolean;
  onClose: () => void;
  /** Optional: when opened from a TableDetailPanel context, pin this
   *  table as focus. The AI biases towards it for ambiguous asks. */
  focusedTableId?: number | null;
  focusedTableName?: string | null;
  /** Called after any apply succeeds so the parent can refetch detail / KPIs. */
  onApplied?: () => void;
}

interface Refinement {
  id: number;
  data_product_id: number;
  product_table_id: number | null;
  user_message: string;
  user_id: number | null;
  user_name: string | null;
  intent: string;
  intent_confidence: 'high' | 'medium' | 'low';
  intent_reasoning: string | null;
  proposal: ProposalPayload;
  summary: string | null;
  status: 'pending' | 'approved' | 'applied' | 'rejected' | 'failed';
  decided_at: string | null;
  decided_by_user_id: number | null;
  decided_by_user_name: string | null;
  apply_error: string | null;
  created_at: string;
  updated_at: string;
}

type ProposalPayload =
  | { intent: 'add_column'; product_table_id: number; table_name: string;
      column_name: string; data_type: string; column_role: string | null;
      description: string | null; transformation_expression: string;
      new_transformation_sql: string; }
  | { intent: 'modify_column'; product_table_id: number; product_column_id: number;
      table_name: string; column_name: string; data_type: string | null;
      column_role: string | null; description: string | null;
      transformation_expression: string | null; new_transformation_sql: string; }
  | { intent: 'add_kpi'; name: string; description: string | null;
      formula_plain_text: string; formula_sql: string; }
  | { intent: 'ask_clarification'; question: string; }
  | { intent: 'unsupported'; reason: string; suggested_action: string | null; };

export default function RefineChat({
  productId,
  productName,
  open,
  onClose,
  focusedTableId,
  focusedTableName,
  onApplied,
}: RefineChatProps) {
  const toast = useToast();
  const [items, setItems] = useState<Refinement[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/products/${productId}/refinements`);
      setItems(res.data.data ?? []);
    } catch { /* network blip — retry on next focus / send */ }
    finally { setLoading(false); }
  }, [productId]);

  // Initial load + poll while open. Polling is the simplest way to get
  // team-visible updates without SSE infrastructure for the MVP.
  useEffect(() => {
    if (!open) return;
    load();
    const id = window.setInterval(load, 8_000);
    return () => window.clearInterval(id);
  }, [open, load]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [items.length]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await api.post(`/products/${productId}/refinements`, {
        message: text,
        focusedTableId: focusedTableId ?? null,
      });
      setDraft('');
      await load();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Failed to send';
      toast.error('Send failed', { description: msg });
    } finally {
      setSending(false);
    }
  }, [draft, sending, productId, focusedTableId, load, toast]);

  const approve = useCallback(async (refinementId: number) => {
    try {
      await api.post(`/products/refinements/${refinementId}/approve`);
      toast.success('Change applied');
      await load();
      onApplied?.();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Apply failed';
      toast.error('Could not apply', { description: msg });
      await load();
    }
  }, [load, onApplied, toast]);

  const reject = useCallback(async (refinementId: number) => {
    try {
      await api.post(`/products/refinements/${refinementId}/reject`);
      await load();
    } catch {
      toast.error('Could not discard');
    }
  }, [load, toast]);

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-[520px] bg-bg border-l border-line shadow-2xl flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-5 py-3.5 border-b border-line bg-raised">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-ocean" strokeWidth={1.75} />
              <h2 className="font-display text-[16px] font-medium text-ink truncate">Refine — {productName}</h2>
            </div>
            <p className="text-[11.5px] text-muted mt-0.5">
              {items.length === 0
                ? 'Ask in plain English. The AI proposes; you approve.'
                : `${items.filter((i) => i.status === 'applied').length} applied · ${items.filter((i) => i.status === 'pending').length} pending`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-soft text-muted hover:text-ink"
            title="Close"
          >
            <X className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Focus chip — visible only when scoped to a table */}
        {focusedTableId && focusedTableName && (
          <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 text-[11px] bg-ocean/10 text-ocean rounded">
            <span className="font-mono uppercase tracking-[0.1em] text-[10px]">Focus</span>
            <span>{focusedTableName}</span>
          </div>
        )}
      </div>

      {/* Message list */}
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {loading && items.length === 0 ? (
          <div className="text-center py-12">
            <Loader2 className="w-5 h-5 mx-auto text-muted-2 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          items.map((r) => (
            <RefinementBubble
              key={r.id}
              item={r}
              onApprove={() => approve(r.id)}
              onReject={() => reject(r.id)}
            />
          ))
        )}
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 border-t border-line bg-raised px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder='e.g. "Add a margin_pct column to fact_sales as (price - cost) / price"'
            rows={2}
            disabled={sending}
            className="flex-1 px-3 py-2 text-[13px] bg-bg border border-line rounded resize-y focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={!draft.trim() || sending}
            className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 bg-ocean text-on-ocean rounded-md hover:bg-ocean-dark disabled:opacity-30 disabled:cursor-not-allowed"
            title="Send (⌘⏎)"
          >
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" strokeWidth={1.75} />}
          </button>
        </div>
        <p className="text-[10.5px] text-muted-2 mt-1.5 px-1">
          ⌘⏎ to send · Approve / Discard each proposal · changes apply on next refresh
        </p>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Empty state
// ───────────────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="text-center py-10">
      <MessageSquarePlus className="w-8 h-8 mx-auto text-muted-2/60 mb-3" strokeWidth={1.5} />
      <p className="text-[13px] text-ink-2 font-medium mb-1">Refine this product</p>
      <p className="text-[12px] text-muted leading-relaxed max-w-[320px] mx-auto">
        Ask in plain English. The AI proposes a change; you review and approve before anything is applied.
      </p>
      <div className="mt-5 space-y-1.5 text-left max-w-[360px] mx-auto">
        <Example>&ldquo;Add a margin_pct column to fact_sales as (price - cost) / price&rdquo;</Example>
        <Example>&ldquo;Define a KPI: gross margin = sum(price - cost)&rdquo;</Example>
        <Example>&ldquo;Change customer_segment to lowercase&rdquo;</Example>
      </div>
    </div>
  );
}

function Example({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[12px] text-muted-2 italic px-3 py-1.5 bg-softer rounded">
      {children}
    </p>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Single message bubble — user message + AI proposal + approve/reject
// ───────────────────────────────────────────────────────────────────────────

function RefinementBubble({
  item, onApprove, onReject,
}: {
  item: Refinement;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [showDetails, setShowDetails] = useState(item.status === 'pending');
  const proposal = item.proposal;

  const author = item.user_name ?? 'Someone';
  const when = formatRelativeShort(new Date(item.created_at));

  return (
    <div className="space-y-2">
      {/* User message */}
      <div className="flex items-start gap-2">
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-ocean/10 flex items-center justify-center text-[10.5px] font-medium text-ocean">
          {author.slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="text-[12px] font-medium text-ink">{author}</span>
            <span className="text-[10.5px] text-muted-2">{when}</span>
          </div>
          <div className="text-[13px] text-ink-2 leading-relaxed bg-softer rounded-md px-3 py-2">
            {item.user_message}
          </div>
        </div>
      </div>

      {/* AI response */}
      <div className="flex items-start gap-2">
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-ink/5 flex items-center justify-center">
          <Sparkles className="w-3.5 h-3.5 text-ink-2" strokeWidth={1.75} />
        </div>
        <div className="flex-1 min-w-0">
          <ProposalCard
            item={item}
            proposal={proposal}
            showDetails={showDetails}
            onToggleDetails={() => setShowDetails((v) => !v)}
            onApprove={onApprove}
            onReject={onReject}
          />
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Proposal card — renders the right diff for the intent
// ───────────────────────────────────────────────────────────────────────────

function ProposalCard({
  item, proposal, showDetails, onToggleDetails, onApprove, onReject,
}: {
  item: Refinement;
  proposal: ProposalPayload;
  showDetails: boolean;
  onToggleDetails: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  // Non-applyable intents render compact, no buttons.
  if (proposal.intent === 'ask_clarification') {
    return (
      <div className="border border-amber-200 bg-amber-50 rounded-md px-3 py-2.5">
        <div className="flex items-start gap-2 text-[13px] text-amber-900">
          <HelpCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" strokeWidth={1.75} />
          <span>{proposal.question}</span>
        </div>
      </div>
    );
  }

  if (proposal.intent === 'unsupported') {
    return (
      <div className="border border-line bg-softer rounded-md px-3 py-2.5">
        <div className="flex items-start gap-2 text-[12.5px] text-ink-2">
          <Ban className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-muted" strokeWidth={1.75} />
          <div>
            <div>{proposal.reason}</div>
            {proposal.suggested_action && (
              <div className="text-[12px] text-muted mt-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] mr-1">Try</span>
                {proposal.suggested_action}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Applyable intents — full card with diff + actions.
  const statusLabel = STATUS_LABELS[item.status] ?? item.status;
  const statusColor = STATUS_COLORS[item.status] ?? 'text-muted';
  const isPending = item.status === 'pending';

  return (
    <div className="border border-line rounded-md overflow-hidden">
      {/* Summary */}
      <div className="px-3 py-2.5 border-b border-line bg-raised">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[12.5px] text-ink font-medium leading-snug">
              {item.summary || `${proposal.intent.replace('_', ' ')}`}
            </div>
            <div className="flex items-center gap-2 mt-1 text-[10.5px]">
              <span className={`font-mono uppercase tracking-[0.1em] ${statusColor}`}>{statusLabel}</span>
              {item.intent_confidence === 'low' && (
                <span className="font-mono uppercase tracking-[0.1em] text-amber-600">low confidence</span>
              )}
              {item.decided_by_user_name && (
                <span className="text-muted-2">· by {item.decided_by_user_name}</span>
              )}
            </div>
          </div>
          <button
            onClick={onToggleDetails}
            className="flex-shrink-0 p-1 rounded hover:bg-soft text-muted"
            title={showDetails ? 'Hide details' : 'Show details'}
          >
            {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
        {item.intent_reasoning && showDetails && (
          <div className="mt-1.5 text-[11.5px] text-muted italic">{item.intent_reasoning}</div>
        )}
      </div>

      {/* Diff body */}
      {showDetails && (
        <div className="px-3 py-2.5 bg-bg space-y-2">
          {proposal.intent === 'add_column' && <AddColumnDiff p={proposal} />}
          {proposal.intent === 'modify_column' && <ModifyColumnDiff p={proposal} />}
          {proposal.intent === 'add_kpi' && <AddKpiDiff p={proposal} />}
        </div>
      )}

      {/* Apply error */}
      {item.status === 'failed' && item.apply_error && (
        <div className="px-3 py-2 border-t border-red-200 bg-red-50 text-[11.5px] text-red-900">
          <div className="flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{item.apply_error}</span>
          </div>
        </div>
      )}

      {/* Actions */}
      {isPending && (
        <div className="px-3 py-2 border-t border-line bg-raised flex items-center justify-end gap-2">
          <button
            onClick={onReject}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[12px] text-muted hover:text-ink"
          >
            <Trash2 className="w-3 h-3" strokeWidth={1.75} />
            Discard
          </button>
          <button
            onClick={onApprove}
            className="inline-flex items-center gap-1 px-3 py-1 text-[12px] font-medium bg-ocean text-on-ocean rounded hover:bg-ocean-dark"
          >
            <Check className="w-3 h-3" strokeWidth={2.25} />
            Approve
          </button>
        </div>
      )}
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'awaiting your approval',
  applied: 'applied',
  rejected: 'discarded',
  failed: 'failed',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'text-ocean',
  applied: 'text-emerald-600',
  rejected: 'text-muted',
  failed: 'text-red-600',
};

// ───────────────────────────────────────────────────────────────────────────
// Per-intent diff renderers
// ───────────────────────────────────────────────────────────────────────────

function AddColumnDiff({ p }: { p: Extract<ProposalPayload, { intent: 'add_column' }> }) {
  return (
    <>
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-emerald-600">+ column</span>
        <span className="font-medium text-ink">{p.table_name}.{p.column_name}</span>
        <span className="text-muted-2 font-mono text-[11px]">{p.data_type}</span>
        {p.column_role && <span className="text-muted-2 text-[10.5px]">[{p.column_role}]</span>}
      </div>
      {p.description && <p className="text-[11.5px] text-muted leading-relaxed">{p.description}</p>}
      <div>
        <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2 mb-1">Expression</div>
        <pre className="text-[11px] font-mono text-ink-2 bg-softer rounded px-2 py-1.5 overflow-x-auto leading-[1.5]">
          {prettySql(p.transformation_expression)}
        </pre>
      </div>
      <SqlBlock label="New transformation_sql" sql={p.new_transformation_sql} />
    </>
  );
}

function ModifyColumnDiff({ p }: { p: Extract<ProposalPayload, { intent: 'modify_column' }> }) {
  return (
    <>
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-amber-600">~ column</span>
        <span className="font-medium text-ink">{p.table_name}.{p.column_name}</span>
      </div>
      <div className="text-[11.5px] space-y-0.5 text-ink-2">
        {p.data_type && <div><span className="text-muted-2 font-mono text-[10px] mr-1.5">type →</span>{p.data_type}</div>}
        {p.column_role && <div><span className="text-muted-2 font-mono text-[10px] mr-1.5">role →</span>{p.column_role}</div>}
        {p.description && <div><span className="text-muted-2 font-mono text-[10px] mr-1.5">desc →</span>{p.description}</div>}
        {p.transformation_expression && (
          <div>
            <div className="text-muted-2 font-mono text-[10px] mb-0.5">expression →</div>
            <pre className="text-[11px] font-mono text-ink-2 bg-softer rounded px-2 py-1.5 overflow-x-auto leading-[1.5]">
              {prettySql(p.transformation_expression)}
            </pre>
          </div>
        )}
      </div>
      <SqlBlock label="New transformation_sql" sql={p.new_transformation_sql} />
    </>
  );
}

function AddKpiDiff({ p }: { p: Extract<ProposalPayload, { intent: 'add_kpi' }> }) {
  return (
    <>
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-emerald-600">+ KPI</span>
        <span className="font-medium text-ink">{p.name}</span>
      </div>
      {p.description && <p className="text-[11.5px] text-muted leading-relaxed">{p.description}</p>}
      <p className="text-[11.5px] text-ink-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-2 mr-1.5">PLAIN</span>
        {p.formula_plain_text}
      </p>
      <SqlBlock label="Formula SQL" sql={p.formula_sql} />
    </>
  );
}

function SqlBlock({ label, sql }: { label: string; sql: string }) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2 mb-1">{label}</div>
      <pre className="text-[11px] font-mono text-ink-2 bg-softer rounded px-2 py-1.5 overflow-x-auto max-h-72 overflow-y-auto leading-[1.5]">
        {prettySql(sql)}
      </pre>
    </div>
  );
}
