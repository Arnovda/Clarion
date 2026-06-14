'use client';

/**
 * <AiPromptDialog> — "Ask AI to change this description".
 *
 * The business-owner's plain-language way to tune meaning: they say what they
 * want, AI proposes a revised description, they Accept (which fills the field —
 * the parent still saves via the normal flow) or Discard. No SQL, no forms.
 *
 * Calls POST /semantic/{tables|columns}/:id/improve-description, which only
 * returns a proposal; nothing is persisted until the parent saves.
 */

import { useState } from 'react';
import { X, Sparkles, Loader2, Check } from 'lucide-react';
import api from '@/lib/api';

interface Props {
  entityType: 'table' | 'column';
  entityId: number;
  entityName?: string;
  currentDescription: string;
  /**
   * Override the POST endpoint. Defaults to the source-layer route
   * (/semantic/{tables|columns}/:id/improve-description); product-layer
   * callers pass /semantic/product-{tables|columns}/:id/improve-description,
   * and id-less callers (e.g. KPI drafts) pass /semantic/improve-text.
   */
  endpoint?: string;
  /** Extra fields merged into the POST body (for the id-less improve-text route). */
  extraBody?: Record<string, unknown>;
  /** Override the word shown in the dialog title (e.g. "KPI"). */
  entityLabel?: string;
  onAccept: (proposal: string) => void;
  onClose: () => void;
}

const SUGGESTIONS = [
  'Make it clearer and more concise',
  'Explain the business purpose',
  'Use simpler, non-technical language',
];

export default function AiPromptDialog({
  entityType, entityId, entityName, currentDescription, endpoint, extraBody, entityLabel, onAccept, onClose,
}: Props) {
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function ask(text?: string) {
    const instr = (text ?? instruction).trim();
    if (!instr || loading) return;
    if (text) setInstruction(text);
    setLoading(true);
    setError('');
    setProposal(null);
    try {
      const url = endpoint ?? (entityType === 'table'
        ? `/semantic/tables/${entityId}/improve-description`
        : `/semantic/columns/${entityId}/improve-description`);
      const res = await api.post(url, { instruction: instr, ...(extraBody ?? {}) });
      setProposal(String(res.data?.data?.ai_proposal ?? ''));
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg bg-raised rounded-lg border border-line shadow-3 overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-line">
          <Sparkles className="w-4 h-4 text-ocean" strokeWidth={1.75} />
          <h3 className="font-display text-[16px] text-ink tracking-[-0.01em] flex-1">
            Ask AI to change this {entityLabel ?? entityType}{entityName ? ` — ${entityName}` : ''}
          </h3>
          <button onClick={onClose} className="text-muted hover:text-ink transition-colors" aria-label="Close">
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Current */}
          <div>
            <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1">Current</p>
            <div className="bg-softer border border-line rounded px-3 py-2 text-[12.5px] text-ink-3 leading-relaxed max-h-24 overflow-y-auto">
              {currentDescription || <span className="text-muted-2 italic">No description yet</span>}
            </div>
          </div>

          {/* Instruction */}
          <div>
            <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">What should change?</p>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ask(); }}
              rows={2}
              autoFocus
              placeholder="Describe it in plain language…"
              className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 resize-none placeholder:text-muted-2"
            />
            <div className="flex flex-wrap gap-1.5 mt-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  disabled={loading}
                  className="text-[11px] px-2 py-1 rounded-full border border-line text-muted hover:text-ink hover:border-ocean/50 transition-colors disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Proposal */}
          {proposal !== null && (
            <div>
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-ocean mb-1">AI suggestion</p>
              <div className="bg-ocean-softer border border-ocean/30 rounded px-3 py-2 text-[12.5px] text-ink-2 leading-relaxed">
                {proposal || <span className="text-muted-2 italic">(empty)</span>}
              </div>
            </div>
          )}

          {error && <p className="text-[12px] text-err">{error}</p>}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-line flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[12.5px] font-medium text-muted hover:text-ink rounded-md hover:bg-soft transition-colors"
          >
            Cancel
          </button>
          {proposal === null ? (
            <button
              onClick={() => ask()}
              disabled={loading || !instruction.trim()}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[12.5px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} /> : <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />}
              {loading ? 'Thinking…' : 'Suggest'}
            </button>
          ) : (
            <>
              <button
                onClick={() => ask()}
                disabled={loading}
                className="px-3 py-1.5 text-[12.5px] font-medium text-ocean hover:bg-ocean-softer rounded-md transition-colors disabled:opacity-50"
              >
                Try again
              </button>
              <button
                onClick={() => { onAccept(proposal); onClose(); }}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[12.5px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
              >
                <Check className="w-3.5 h-3.5" strokeWidth={2} />
                Use this
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
