'use client';

/**
 * <KpiManager> — editable KPI list for a data product.
 *
 * Replaces the read-only KpisSection in ProductRootPanel. Lets users:
 *   • Add a new KPI (name, plain-English description, SQL formula)
 *   • Use AI-assist to draft the SQL formula from a name + description
 *   • Edit / rename / re-draft / delete existing KPIs
 *
 * Persistence is via the existing `/products/:id/kpis` CRUD routes;
 * AI-assist hits `POST /products/:id/kpis/ai-draft` and never persists
 * — the user reviews the draft and clicks Save explicitly.
 *
 * No tabs, no slide-overs — inline editing on the same KPI tab the
 * panel already shows. Keeps the surface uncluttered: one button per
 * KPI to enter edit mode, one button at the top to add a new one.
 */

import { useState, useCallback } from 'react';
import { Sparkles, Gauge, Plus, Pencil, Trash2, Loader2, X, Wand2, AlertCircle } from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import AiPromptDialog from '@/components/semantic/AiPromptDialog';
import type { ProductKpi } from '@/app/products/types';

interface KpiManagerProps {
  productId: number;
  kpis: ProductKpi[];
  /** Called after any mutation so the parent can refresh its list. */
  onChanged: () => void;
}

interface DraftState {
  name: string;
  description: string;
  /** First-person phrasing shown on the topic page's "Try asking" rows. */
  questionText: string;
  formulaPlainText: string;
  formulaSql: string;
  /** AI-assist state for the inline draft. */
  drafting: boolean;
  draftNotes: string | null;
  draftConfidence: 'high' | 'medium' | 'low' | null;
}

const EMPTY_DRAFT: DraftState = {
  name: '',
  description: '',
  questionText: '',
  formulaPlainText: '',
  formulaSql: '',
  drafting: false,
  draftNotes: null,
  draftConfidence: null,
};

export default function KpiManager({ productId, kpis, onChanged }: KpiManagerProps) {
  const toast = useToast();
  // null = no editor open; 0 = "new" editor; <n> = editing existing KPI id <n>.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const startNew = useCallback(() => {
    setEditingId(0);
    setDraft(EMPTY_DRAFT);
  }, []);

  const startEdit = useCallback((kpi: ProductKpi) => {
    setEditingId(kpi.id);
    setDraft({
      name:             kpi.name,
      description:      kpi.description ?? '',
      questionText:     kpi.question_text ?? '',
      formulaPlainText: kpi.formula_plain_text ?? '',
      formulaSql:       kpi.formula_sql ?? '',
      drafting:         false,
      draftNotes:       null,
      draftConfidence:  null,
    });
  }, []);

  const cancel = useCallback(() => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  }, []);

  const aiDraft = useCallback(async () => {
    if (!draft.name.trim()) {
      toast.error('Give the KPI a name first');
      return;
    }
    setDraft((d) => ({ ...d, drafting: true, draftNotes: null }));
    try {
      const res = await api.post(`/products/${productId}/kpis/ai-draft`, {
        name: draft.name,
        description: draft.description || undefined,
      });
      const { formulaSql, formulaPlainText, confidence, notes } = res.data.data as {
        formulaSql: string; formulaPlainText: string;
        confidence: 'high' | 'medium' | 'low'; notes: string;
      };
      setDraft((d) => ({
        ...d,
        formulaSql:       formulaSql || d.formulaSql,
        formulaPlainText: formulaPlainText || d.formulaPlainText,
        drafting:         false,
        draftConfidence:  confidence,
        draftNotes:       notes || null,
      }));
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'AI draft failed. Try again or write the SQL by hand.';
      setDraft((d) => ({ ...d, drafting: false, draftNotes: msg, draftConfidence: 'low' }));
      toast.error('Draft failed', { description: msg });
    }
  }, [productId, draft.name, draft.description, toast]);

  const save = useCallback(async () => {
    if (!draft.name.trim()) {
      toast.error('KPI name is required');
      return;
    }
    setSaving(true);
    try {
      if (editingId === 0) {
        await api.post(`/products/${productId}/kpis`, {
          name:             draft.name.trim(),
          description:      draft.description || undefined,
          questionText:     draft.questionText.trim() || undefined,
          formulaPlainText: draft.formulaPlainText || undefined,
          formulaSql:       draft.formulaSql || undefined,
        });
        toast.success('KPI added');
      } else if (editingId != null) {
        await api.put(`/products/kpis/${editingId}`, {
          name:               draft.name.trim(),
          description:        draft.description || null,
          question_text:      draft.questionText.trim() || null,
          formula_plain_text: draft.formulaPlainText || null,
          formula_sql:        draft.formulaSql || null,
          ai_draft:           false,
        });
        toast.success('KPI updated');
      }
      setEditingId(null);
      setDraft(EMPTY_DRAFT);
      onChanged();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Save failed.';
      toast.error('Save failed', { description: msg });
    } finally {
      setSaving(false);
    }
  }, [productId, editingId, draft, onChanged, toast]);

  const remove = useCallback(async (kpi: ProductKpi) => {
    if (!confirm(`Delete the KPI "${kpi.name}"?`)) return;
    try {
      await api.delete(`/products/kpis/${kpi.id}`);
      toast.success('KPI deleted');
      onChanged();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Delete failed.';
      toast.error('Delete failed', { description: msg });
    }
  }, [onChanged, toast]);

  const showEmpty = kpis.length === 0 && editingId !== 0;

  return (
    <div className="max-w-3xl space-y-3">
      {/* Header — always show the Add button. */}
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-muted">
          {kpis.length === 0
            ? 'No KPIs yet.'
            : `${kpis.length} KPI${kpis.length === 1 ? '' : 's'} defined.`}
        </div>
        {editingId !== 0 && (
          <button
            onClick={startNew}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium text-on-ocean bg-ocean rounded-md hover:bg-ocean-dark transition-colors"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={2.25} />
            Add KPI
          </button>
        )}
      </div>

      {/* Empty state hint — replaces the old "Ask the AI on the right" copy
          since users now have a direct manual path. */}
      {showEmpty && (
        <div className="text-center py-12 bg-raised border border-line border-dashed rounded-md">
          <Sparkles className="w-6 h-6 mx-auto text-muted-2 mb-2" strokeWidth={1.5} />
          <p className="text-[13px] text-ink-2">Define your first KPI.</p>
          <p className="text-[12px] text-muted mt-1">
            Type a name and short description; the AI will draft the SQL formula for you to review.
          </p>
        </div>
      )}

      {/* New-KPI inline editor (rendered above the list when active). */}
      {editingId === 0 && (
        <KpiEditor
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={cancel}
          onAiDraft={aiDraft}
          saving={saving}
          mode="new"
        />
      )}

      {/* Existing KPIs — each renders as a card or, if being edited, the
          inline editor in place of the card. */}
      {kpis.map((kpi) => (
        editingId === kpi.id ? (
          <KpiEditor
            key={kpi.id}
            draft={draft}
            setDraft={setDraft}
            onSave={save}
            onCancel={cancel}
            onAiDraft={aiDraft}
            saving={saving}
            mode="edit"
          />
        ) : (
          <KpiCard
            key={kpi.id}
            kpi={kpi}
            onEdit={() => startEdit(kpi)}
            onDelete={() => remove(kpi)}
            disabled={editingId !== null}
          />
        )
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Display card — a single KPI in non-edit state.
// ───────────────────────────────────────────────────────────────────────────

function KpiCard({
  kpi, onEdit, onDelete, disabled,
}: {
  kpi: ProductKpi;
  onEdit: () => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  return (
    <div className="bg-raised border border-line rounded-md p-4 group">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <Gauge className="w-3.5 h-3.5 text-ocean" strokeWidth={1.75} />
            <h3 className="text-[14px] font-medium text-ink">{kpi.name}</h3>
            {kpi.ai_draft && (
              <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2">draft</span>
            )}
          </div>
          {kpi.question_text && (
            <p className="mb-2 text-[12.5px] leading-relaxed text-ink-2">
              <span className="mr-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-2">ASKED AS</span>
              {kpi.question_text}
            </p>
          )}
          {kpi.description && (
            <p className="text-[12.5px] text-ink-2 leading-relaxed mb-2">{kpi.description}</p>
          )}
          {kpi.formula_plain_text && (
            <p className="text-[12px] text-muted leading-relaxed mb-1">
              <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-muted-2 mr-1.5">PLAIN</span>
              {kpi.formula_plain_text}
            </p>
          )}
          {kpi.formula_sql && (
            <pre className="text-[11.5px] font-mono text-ink-2 bg-softer rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap">
              {kpi.formula_sql}
            </pre>
          )}
        </div>

        {/* Action buttons — fade in on hover so the card stays clean. */}
        <div className="flex items-start gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onEdit}
            disabled={disabled}
            title="Edit KPI"
            className="p-1.5 rounded hover:bg-soft text-muted hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
          <button
            onClick={onDelete}
            disabled={disabled}
            title="Delete KPI"
            className="p-1.5 rounded hover:bg-soft text-muted hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Inline editor — used for both Add and Edit. Form state is owned by parent.
// ───────────────────────────────────────────────────────────────────────────

function KpiEditor({
  draft, setDraft, onSave, onCancel, onAiDraft, saving, mode,
}: {
  draft: DraftState;
  setDraft: React.Dispatch<React.SetStateAction<DraftState>>;
  onSave: () => void;
  onCancel: () => void;
  onAiDraft: () => void;
  saving: boolean;
  mode: 'new' | 'edit';
}) {
  const [aiOpen, setAiOpen] = useState(false);
  return (
    <div className="bg-raised border border-ocean/30 rounded-md p-4 space-y-3 ring-1 ring-ocean/10">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-mono uppercase tracking-[0.1em] text-ocean">
          {mode === 'new' ? 'New KPI' : 'Editing'}
        </div>
        <button
          onClick={onCancel}
          disabled={saving}
          className="p-1 rounded hover:bg-soft text-muted disabled:opacity-30"
          title="Cancel"
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
      </div>

      {/* Name */}
      <label className="block">
        <span className="block text-[11px] font-medium text-muted-2 uppercase tracking-wider mb-1">Name</span>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="e.g. Total revenue, Average order value"
          className="w-full px-3 py-2 text-[13px] bg-bg border border-line rounded focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
        />
      </label>

      {/* Description */}
      <div className="block">
        <div className="flex items-center mb-1">
          <span className="block text-[11px] font-medium text-muted-2 uppercase tracking-wider">
            Description <span className="font-normal text-muted normal-case tracking-normal">— what does this measure mean to a business reader?</span>
          </span>
          <button
            type="button"
            onClick={() => setAiOpen(true)}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-ocean hover:text-ocean-hover transition-colors shrink-0"
            title="Ask AI to write or refine this description in plain language"
          >
            <Sparkles className="w-3 h-3" strokeWidth={1.75} />
            Ask AI
          </button>
        </div>
        <input
          type="text"
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          placeholder="e.g. Sum of invoice amounts for paid orders"
          className="w-full px-3 py-2 text-[13px] bg-bg border border-line rounded focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
        />
      </div>

      {/* Question — what the business user sees.
          This is the string the topic page's "Try asking" row shows and the
          "Answers …" sub-line in Manage mode reuses. It is stored on the KPI
          rather than derived, so the phrasing a business user reads is
          something a curator chose, not something a regex produced. */}
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-muted-2">
          Question{' '}
          <span className="font-normal normal-case tracking-normal text-muted">
            — how a business user would ask for this. Shown on the topic page.
          </span>
        </span>
        <input
          type="text"
          value={draft.questionText}
          onChange={(e) => setDraft((d) => ({ ...d, questionText: e.target.value }))}
          placeholder="e.g. Who owes me money right now?"
          className="w-full rounded border border-line bg-bg px-3 py-2 text-[13px] focus:border-ocean focus:outline-none focus:ring-1 focus:ring-ocean/30"
        />
      </label>

      {aiOpen && (
        <AiPromptDialog
          entityType="table"
          entityLabel="KPI"
          entityId={0}
          entityName={draft.name || undefined}
          currentDescription={draft.description}
          endpoint="/semantic/improve-text"
          extraBody={{ entityType: 'KPI', name: draft.name, currentDescription: draft.description }}
          onAccept={(text) => setDraft((d) => ({ ...d, description: text }))}
          onClose={() => setAiOpen(false)}
        />
      )}

      {/* AI-assist row */}
      <div className="flex items-center gap-2">
        <button
          onClick={onAiDraft}
          disabled={draft.drafting || saving || !draft.name.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-ocean border border-ocean/40 rounded hover:bg-ocean/5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {draft.drafting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <Wand2 className="w-3.5 h-3.5" strokeWidth={1.75} />
          )}
          {draft.drafting ? 'Drafting…' : 'AI-draft formula'}
        </button>
        <span className="text-[11.5px] text-muted">
          Uses this product&rsquo;s schema. Review before saving.
        </span>
      </div>

      {/* Draft notes (confidence, hints from the model) */}
      {draft.draftNotes && (
        <div className={`flex items-start gap-2 px-3 py-2 rounded text-[12px] ${
          draft.draftConfidence === 'low'
            ? 'bg-amber-50 text-amber-900 border border-amber-200'
            : 'bg-ocean/5 text-ink-2 border border-ocean/20'
        }`}>
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" strokeWidth={1.75} />
          <div className="min-w-0">
            {draft.draftConfidence && (
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] mr-1.5">
                {draft.draftConfidence} confidence
              </span>
            )}
            <span>{draft.draftNotes}</span>
          </div>
        </div>
      )}

      {/* Plain-English formula */}
      <label className="block">
        <span className="block text-[11px] font-medium text-muted-2 uppercase tracking-wider mb-1">
          Plain-English formula
        </span>
        <input
          type="text"
          value={draft.formulaPlainText}
          onChange={(e) => setDraft((d) => ({ ...d, formulaPlainText: e.target.value }))}
          placeholder="e.g. Sum of invoice_amount on fact_sales_invoices"
          className="w-full px-3 py-2 text-[13px] bg-bg border border-line rounded focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
        />
      </label>

      {/* SQL formula */}
      <label className="block">
        <span className="block text-[11px] font-medium text-muted-2 uppercase tracking-wider mb-1">
          SQL formula
        </span>
        <textarea
          value={draft.formulaSql}
          onChange={(e) => setDraft((d) => ({ ...d, formulaSql: e.target.value }))}
          placeholder="SELECT SUM(invoice_amount) FROM fact_sales_invoices"
          rows={4}
          className="w-full px-3 py-2 text-[12px] font-mono bg-softer border border-line rounded focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 resize-y"
        />
      </label>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-1.5 text-[12.5px] text-muted hover:text-ink disabled:opacity-30"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving || !draft.name.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium text-on-ocean bg-ocean rounded-md hover:bg-ocean-dark disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />}
          Save KPI
        </button>
      </div>
    </div>
  );
}
