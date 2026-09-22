'use client';

/**
 * <LineageSummary> — the easy lineage: which tables feed this one, or which
 * it feeds, as two or three readable lines. The full column-level graph
 * (<LineageGraph>) stays one click away on the Lineage tab; this is the
 * answer most people came for, on the Overview, without opening anything.
 *
 * Same read model as the graph (GET /api/lineage/table), so the two can
 * never disagree. Analyst+ only — the endpoint is.
 */
import { useEffect, useState } from 'react';
import { ArrowRight, GitBranch } from 'lucide-react';
import api from '@/lib/api';

interface Response {
  anchor: { layer: 'source' | 'product' };
  sources: Array<{ tableId: number | null; tableName: string; displayName: string | null; columns: unknown[] }>;
  products: Array<{ productId: number; productName: string; productTableId: number; tableName: string; displayName: string | null; columns: unknown[] }>;
  edges: unknown[];
}

export default function LineageSummary({
  layer, tableId, onOpenLineage,
}: {
  layer: 'source' | 'product';
  tableId: number;
  onOpenLineage?: () => void;
}) {
  const [data, setData] = useState<Response | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    api.get(`/lineage/table?layer=${layer}&tableId=${tableId}`)
      .then((r) => { if (!cancelled) setData((r.data?.data as Response) ?? null); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [layer, tableId]);

  if (data === undefined) return null;

  // On the product layer the anchor is itself one of the `products`; what
  // feeds it is `sources`. On the source layer, what it feeds is `products`.
  const feeds = layer === 'product'
    ? data?.sources.map((s) => ({ key: `s:${s.tableName}`, label: s.displayName || s.tableName, sub: null as string | null, n: s.columns.length })) ?? []
    : data?.products.map((p) => ({ key: `p:${p.productTableId}`, label: p.displayName || p.tableName, sub: p.productName, n: p.columns.length })) ?? [];

  const heading = layer === 'product' ? 'Where it comes from' : 'What it feeds';

  return (
    <section className="bg-raised border border-line rounded-lg p-5">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">{heading}</p>
        {onOpenLineage && feeds.length > 0 && (
          <button
            type="button"
            onClick={onOpenLineage}
            className="inline-flex items-center gap-1 text-[11px] text-ocean hover:text-ocean-hover transition-colors"
          >
            <GitBranch className="w-3 h-3" strokeWidth={2} aria-hidden />
            See every column
          </button>
        )}
      </div>
      {feeds.length === 0 ? (
        <p className="text-[12.5px] text-muted">
          {layer === 'product'
            ? 'No lineage recorded for this table yet — it is written when the table is built.'
            : 'Nothing built from this table yet.'}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {feeds.map((f) => (
            <li key={f.key} className="flex items-baseline gap-2 text-[13px] text-ink-2">
              <ArrowRight className="w-3 h-3 shrink-0 self-center text-muted-2" strokeWidth={2} aria-hidden />
              <span className="font-medium text-ink truncate">{f.label}</span>
              {f.sub && <span className="text-muted truncate">in {f.sub}</span>}
              <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-2 tabular-nums">
                {f.n} {f.n === 1 ? 'column' : 'columns'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
