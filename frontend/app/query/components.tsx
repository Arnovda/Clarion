'use client';

/**
 * Pure leaf components extracted from page.tsx.
 * No hooks, no state — they take props and render markup.
 *
 * Keeping these in a sibling file (rather than a deeper `components/` folder)
 * to minimise churn on page.tsx import paths.
 */

import { Fragment } from 'react';

// ─── DataSource type (shared with SourceSelector) ───────────────────────────

export interface DataSource {
  type: 'connection' | 'view';
  id: number;
  label: string;
}

// ─── SourceSelector ─────────────────────────────────────────────────────────

interface SourceSelectorProps {
  sources: DataSource[];
  selectedId: string; // "c:1" or "v:2"
  onChange: (id: string) => void;
}

export function SourceSelector({ sources, selectedId, onChange }: SourceSelectorProps) {
  return (
    <select
      value={selectedId}
      onChange={(e) => onChange(e.target.value)}
      className="text-[12px] bg-raised border border-line rounded-md px-2.5 py-1.5 text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 max-w-[200px]"
    >
      {sources.filter((s) => s.type === 'connection').length > 0 && (
        <optgroup label="Single source">
          {sources.filter((s) => s.type === 'connection').map((s) => (
            <option key={`c:${s.id}`} value={`c:${s.id}`}>{s.label}</option>
          ))}
        </optgroup>
      )}
      {sources.filter((s) => s.type === 'view').length > 0 && (
        <optgroup label="Integration views">
          {sources.filter((s) => s.type === 'view').map((s) => (
            <option key={`v:${s.id}`} value={`v:${s.id}`}>🔗 {s.label}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

// ─── BoldText — inline **bold** renderer ─────────────────────────────────────

export function BoldText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**')
          ? <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>
          : <Fragment key={i}>{p}</Fragment>,
      )}
    </>
  );
}

// ─── RichText — markdown-lite for answer prose ──────────────────────────────
//
// The answer formatter writes 1–3 sentences but legitimately uses line
// breaks and "- " lists for enumerations. BoldText alone flattened those
// into one run-on paragraph. Deliberately NOT a markdown library: bold,
// line breaks and dash lists are the whole vocabulary the prompt allows.

export function RichText({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: Array<{ kind: 'p' | 'li'; text: string }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[-•]\s+/.test(trimmed)) blocks.push({ kind: 'li', text: trimmed.replace(/^[-•]\s+/, '') });
    else blocks.push({ kind: 'p', text: trimmed });
  }
  if (blocks.length <= 1) return <BoldText text={blocks[0]?.text ?? text} />;
  return (
    <span className="block space-y-1.5">
      {blocks.map((b, i) =>
        b.kind === 'li' ? (
          <span key={i} className="flex gap-2">
            <span className="text-muted-2 flex-shrink-0">–</span>
            <span><BoldText text={b.text} /></span>
          </span>
        ) : (
          <span key={i} className="block"><BoldText text={b.text} /></span>
        ),
      )}
    </span>
  );
}

// ─── ConfidenceBadge ─────────────────────────────────────────────────────────

export function ConfidenceBadge({ value }: { value: number }) {
  const pct   = Math.round(value * 100);
  const color = value >= 0.85 ? 'text-ok   bg-ok-soft   border-line'
              : value >= 0.70 ? 'text-warn bg-warn-soft border-line'
              :                 'text-err  bg-err-soft  border-line';
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-mono tracking-[0.06em] uppercase px-1.5 py-0.5 rounded border ${color}`}>
      <span className="opacity-60">confidence</span> {pct}%
    </span>
  );
}

// ─── QueryLayerBadge ────────────────────────────────────────────────────────

export function QueryLayerBadge({ layer }: { layer: 'product' | 'source' }) {
  const isProduct = layer === 'product';
  const color = isProduct
    ? 'text-ai    bg-ai-soft border-line'
    : 'text-muted bg-softer  border-line';
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-mono tracking-[0.06em] uppercase px-1.5 py-0.5 rounded border ${color}`}>
      {isProduct ? '⭐ Data Model' : '📦 Source'}
    </span>
  );
}
