'use client';

/**
 * <SourceTableRelations> — a SOURCE table's relationships, read on its page.
 *
 * The canvas (/relationships) is where a link is drawn, measured and
 * flagged; this is the reading of what it holds for one table: who laid
 * each line (the source itself, or a person) and whether the check held —
 * the same two facts the canvas colours by, in the same words
 * (components/relationships/provenance, MeasurePanel). Curators only: the
 * graph endpoint is.
 */
import { useEffect, useMemo, useState } from 'react';
import { Flag, Loader2, Share2 } from 'lucide-react';
import api from '@/lib/api';
import type { GraphColumn, GraphRelationship, GraphResponse, GraphTable } from '@/components/relationships/types';
import { LAID_BY, laidBy } from '@/components/relationships/provenance';
import { OUTCOME, outcomeOf } from '@/components/relationships/MeasurePanel';
import type { CatalogNavTarget } from './navigation';

function tableLabel(t: GraphTable | undefined, fallbackId: number): string {
  return t?.displayName || t?.tableName || `Table ${fallbackId}`;
}

function Chip({ label, color, bg, title }: { label: string; color: string; bg: string; title?: string }) {
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium whitespace-nowrap"
      style={{ color, background: bg }}
      title={title}
    >
      {label}
    </span>
  );
}

export default function SourceTableRelations({ tableId, onNavigate }: {
  tableId: number;
  onNavigate?: (target: CatalogNavTarget) => void;
}) {
  const [data, setData] = useState<GraphResponse | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    api.get('/relationships/graph', { params: { anchorTableId: tableId, depth: 1, withColumns: '1' } })
      .then((r) => { if (!cancelled) setData((r.data?.data ?? null) as GraphResponse | null); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [tableId]);

  const tableById = useMemo(() => new Map((data?.tables ?? []).map((t) => [t.id, t])), [data]);
  const colById = useMemo(() => new Map((data?.columns ?? []).map((c) => [c.id, c])), [data]);
  const rels = useMemo(
    () => (data?.relationships ?? []).filter((r) => r.fromTableId === tableId || r.toTableId === tableId),
    [data, tableId],
  );

  if (data === undefined) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2} aria-hidden /> Loading the relationships…
      </div>
    );
  }
  if (data === null) return <p className="text-[13px] text-err">Could not load this table&apos;s relationships.</p>;

  const canvas = `/relationships?table=${tableId}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12.5px] text-muted">
          {rels.length === 0
            ? 'No relationship touches this table yet.'
            : `${rels.length} ${rels.length === 1 ? 'relationship' : 'relationships'} · drawn, checked and flagged on the canvas.`}
        </p>
        <a href={canvas} className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-mono uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover transition-colors">
          <Share2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          Open on the canvas ↗
        </a>
      </div>

      {rels.length > 0 && (
        <ul className="bg-raised border border-line rounded-lg divide-y divide-line">
          {rels.map((r) => (
            <RelationRow key={r.id} rel={r} tableById={tableById} colById={colById} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RelationRow({ rel, tableById, colById, onNavigate }: {
  rel: GraphRelationship;
  tableById: Map<number, GraphTable>;
  colById: Map<number, GraphColumn>;
  onNavigate?: (target: CatalogNavTarget) => void;
}) {
  const from = tableById.get(rel.fromTableId);
  const to = tableById.get(rel.toTableId);
  const fromCol = rel.fromColumnId != null ? colById.get(rel.fromColumnId) : undefined;
  const toCol = rel.toColumnId != null ? colById.get(rel.toColumnId) : undefined;
  const laid = laidBy(rel);
  const outcome = outcomeOf(rel.measured, laid);
  const o = OUTCOME[outcome];

  const endpoint = (t: GraphTable | undefined, id: number, col: GraphColumn | undefined) => (
    <span className="inline-flex items-baseline gap-1 min-w-0">
      {t && onNavigate ? (
        <button
          type="button"
          onClick={() => onNavigate({ kind: 'source-table', tableId: t.id, connectionId: t.connectionId })}
          className="font-medium text-ink hover:text-ocean transition-colors text-left truncate"
        >
          {tableLabel(t, id)}
        </button>
      ) : (
        <span className="font-medium text-ink truncate">{tableLabel(t, id)}</span>
      )}
      {col && <span className="font-mono text-[11px] text-muted-2">.{col.column_name}</span>}
    </span>
  );

  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2.5 text-[13px]">
      {endpoint(from, rel.fromTableId, fromCol)}
      <span className="text-muted-2" aria-hidden>{rel.kind === 'match' ? '≈' : '→'}</span>
      {endpoint(to, rel.toTableId, toCol)}
      {rel.isCrossSource && (
        <span className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-muted-2">across sources</span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {rel.flagged && (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-warn" title={rel.flaggedReason ?? 'Flagged — left out of the AI context'}>
            <Flag className="w-3 h-3" strokeWidth={2} aria-hidden /> flagged
          </span>
        )}
        <Chip label={LAID_BY[laid].label} color="#4a5660" bg="#e3e6ea" title={LAID_BY[laid].hint} />
        <Chip label={o.head} color={o.color} bg={o.bg} />
      </span>
    </li>
  );
}
