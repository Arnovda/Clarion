'use client';

/**
 * <ReferenceDetailPanel> — detail surface for the right-column reference
 * cards on the new two-column /catalog.
 *
 * Reference data has different framing than analytics products. The user
 * lands here asking "what is this entity, what's in it, who uses it?"
 * — not "what metrics does this drive?". So the tabs are:
 *
 *   Overview   — definition, grain, last refresh, row count, sample row
 *   Columns    — column list with role + description (mostly read-only)
 *   Used in    — analytics products that consume this dim, click-through
 *   Sample     — first 100 rows
 *   Quality    — existing QualityPanel scoped to this single table
 *   History    — refresh-history mini chart (the one shipped 2026-05-08)
 *
 * Lean compared to ProductTableDetailPanel:
 *   - no relationships graph (Used-in covers the actionable subset)
 *   - editing affordances pulled back to the essentials (description, role)
 *   - no save/discard footer choreography — saves go through the existing
 *     PATCH /api/products/columns/:id and refresh on success
 */

import { useEffect, useState } from 'react';
import { Loader2, Tag, ArrowRight, AlertCircle } from 'lucide-react';
import dynamic from 'next/dynamic';
import api from '@/lib/api';
import QualityPanel from '@/components/QualityPanel';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';

const RefreshHistoryChart = dynamic(
  () => import('@/components/products/RefreshHistoryChart'),
  { ssr: false },
);

type Tab = 'overview' | 'columns' | 'used' | 'sample' | 'quality' | 'history';

interface ProductTable {
  id: number;
  table_name: string;
  display_name: string | null;
  description: string | null;
  table_role: string | null;
  row_count: number | null;
  last_run_at: string | null;
  business_grain: string | null;
  star_schema_id: number;
  data_product_id?: number;
}

interface ProductColumn {
  id: number;
  column_name: string;
  display_name: string | null;
  data_type: string | null;
  description: string | null;
  column_role: string | null;
  is_technical?: boolean;
}

interface UsageRow {
  productId: number;
  productName: string;
  kind: string;
  factTable: string;
  joinColumns: Array<{ fact: string; dim: string }>;
}

interface SampleRow {
  [key: string]: unknown;
}

interface DataProduct {
  id: number;
  name: string;
  connection_id: number | null;
}

interface Props {
  tableId: number;
  productId: number;
}

export default function ReferenceDetailPanel({ tableId, productId }: Props) {
  const [table, setTable] = useState<ProductTable | null>(null);
  const [columns, setColumns] = useState<ProductColumn[]>([]);
  const [product, setProduct] = useState<DataProduct | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');

  // Load the table + columns from the wrapping data_product feed. We use
  // /api/products/:id since it returns the full tables+columns tree, then
  // pluck the row matching tableId. Cheaper than adding a per-table
  // endpoint, and stays consistent with how ProductRootPanel loads.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get(`/products/${productId}`)
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data;
        if (!data) return;
        setProduct({ id: data.id, name: data.name, connection_id: data.connection_id ?? null });
        const allTables: ProductTable[] = (data.star_schemas ?? []).flatMap(
          (s: { tables?: ProductTable[] }) => s.tables ?? [],
        );
        const t = allTables.find((x) => x.id === tableId) ?? null;
        setTable(t);
        // Columns hang off the table object in this response shape.
        const tWithCols = (data.star_schemas ?? []).flatMap(
          (s: { tables?: Array<{ id: number; columns?: ProductColumn[] }> }) => s.tables ?? [],
        ).find((x: { id: number }) => x.id === tableId) as { columns?: ProductColumn[] } | undefined;
        setColumns(tWithCols?.columns ?? []);
      })
      .catch(() => {
        setTable(null);
        setColumns([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [tableId, productId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }
  if (!table) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-[13px]">
        Reference entity not found.
      </div>
    );
  }

  const displayName = table.display_name ?? table.table_name;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-canvas">
      {/* Header */}
      <div className="px-6 py-4 border-b border-line bg-raised flex-shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <Tag className="w-4 h-4 text-muted-2" strokeWidth={2} />
          <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">
            Reference data
          </span>
          {product && (
            <>
              <span className="text-muted-2/50">·</span>
              <span className="text-[11px] text-muted-2">{product.name}</span>
            </>
          )}
        </div>
        <h1 className="font-display text-[22px] tracking-[-0.01em] text-ink leading-tight">
          {displayName}
        </h1>
        {table.description && (
          <p className="text-[13px] text-ink-2 mt-1.5 leading-relaxed line-clamp-2">
            {table.description}
          </p>
        )}
        <div className="flex items-center gap-3 text-[11px] font-mono text-muted-2 tabular-nums mt-3">
          {table.row_count != null && (
            <span>{table.row_count.toLocaleString('en-GB')} rows</span>
          )}
          <span>{columns.length} columns</span>
          {table.last_run_at && (
            <span className="ml-auto">Last refreshed {formatRelative(table.last_run_at)}</span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="px-6 border-b border-line bg-raised flex-shrink-0 flex gap-0.5">
        <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabBtn>
        <TabBtn active={tab === 'columns'} onClick={() => setTab('columns')}>
          Columns <span className="ml-1 text-muted-2">({columns.length})</span>
        </TabBtn>
        <TabBtn active={tab === 'used'} onClick={() => setTab('used')}>Used in</TabBtn>
        <TabBtn active={tab === 'sample'} onClick={() => setTab('sample')}>Sample</TabBtn>
        <TabBtn active={tab === 'quality'} onClick={() => setTab('quality')}>Quality</TabBtn>
        <TabBtn active={tab === 'history'} onClick={() => setTab('history')}>History</TabBtn>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'overview'  && <OverviewTab table={table} columns={columns} />}
        {tab === 'columns'   && <ColumnsTab columns={columns} />}
        {tab === 'used'      && <UsedInTab tableId={tableId} />}
        {tab === 'sample'    && <SampleTab tableId={tableId} productId={productId} />}
        {tab === 'quality'   && product?.connection_id && (
          <div className="p-4">
            <QualityPanel
              connId={product.connection_id}
              tableName={table.table_name}
              productTableId={tableId}
            />
          </div>
        )}
        {tab === 'history'   && (
          <div className="p-6">
            <RefreshHistoryChart productTableId={tableId} variant="full" limit={30} />
          </div>
        )}
      </div>
    </div>
  );
}

function TabBtn({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-2.5 text-[12.5px] font-medium tracking-tight transition-colors border-b-2',
        active
          ? 'text-ocean border-ocean'
          : 'text-muted hover:text-ink border-transparent',
      )}
    >
      {children}
    </button>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────

function OverviewTab({ table, columns }: { table: ProductTable; columns: ProductColumn[] }) {
  const keyCols = columns.filter((c) => c.column_role === 'natural_key' || c.column_role === 'surrogate_key');
  const attributes = columns.filter((c) => c.column_role === 'attribute');

  return (
    <div className="p-6 space-y-5">
      <DefinitionCard title="What is this?"
        body={table.description ?? 'No description yet — the curator hasn’t written one for this entity.'} />

      {table.business_grain && (
        <DefinitionCard title="Grain" body={table.business_grain} />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard label="Identifier columns" value={keyCols.length}
          detail={keyCols.map((c) => c.column_name).join(', ') || '—'} />
        <StatCard label="Descriptive attributes" value={attributes.length}
          detail={attributes.length === 0 ? '—' : `${attributes.length} fields you can slice analytics by`} />
      </div>
    </div>
  );
}

function DefinitionCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-line rounded-md bg-raised">
      <div className="px-4 py-2 border-b border-line bg-softer/40">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">{title}</p>
      </div>
      <p className="px-4 py-3 text-[13.5px] text-ink-2 leading-relaxed">{body}</p>
    </div>
  );
}

function StatCard({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="border border-line rounded-md bg-raised px-4 py-3">
      <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-1">{label}</p>
      <p className="font-display text-[24px] tabular-nums text-ink leading-none">{value}</p>
      <p className="text-[12px] text-muted-2 mt-2 truncate">{detail}</p>
    </div>
  );
}

// ── Columns ───────────────────────────────────────────────────────────────

function ColumnsTab({ columns }: { columns: ProductColumn[] }) {
  if (columns.length === 0) {
    return (
      <div className="p-6">
        <p className="text-[12.5px] text-muted italic">No columns yet.</p>
      </div>
    );
  }
  return (
    <div className="p-6">
      <div className="border border-line rounded-md overflow-hidden bg-raised divide-y divide-line">
        {columns.map((c) => (
          <div key={c.id} className="px-3 py-2 flex items-center gap-2 text-[12.5px]">
            <span className={cn(
              'inline-block px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wide',
              c.column_role === 'surrogate_key' || c.column_role === 'natural_key'
                ? 'bg-warn-soft text-warn'
                : c.column_role === 'foreign_key'
                  ? 'bg-ocean-softer text-ocean'
                  : 'bg-softer text-muted',
            )}>
              {c.column_role ?? '—'}
            </span>
            <span className="font-mono text-ink min-w-[180px]">{c.column_name}</span>
            <span className="text-muted-2 min-w-[80px]">{c.data_type ?? ''}</span>
            {c.description && (
              <span className="text-muted ml-auto truncate max-w-[50%]" title={c.description}>
                {c.description}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Used in ───────────────────────────────────────────────────────────────

function UsedInTab({ tableId }: { tableId: number }) {
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    api.get(`/products/tables/${tableId}/used-by`)
      .then((r) => { if (!cancelled) setRows((r.data?.data ?? []) as UsageRow[]); })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.error ?? e?.message ?? 'Failed to load');
      });
    return () => { cancelled = true; };
  }, [tableId]);

  if (error) {
    return <div className="p-6 text-[12px] text-err italic">Couldn&rsquo;t load: {error}</div>;
  }
  if (rows === null) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted text-[12px]">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-6">
        <div className="border border-warn/30 bg-warn-soft/30 rounded-md px-4 py-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-warn shrink-0 mt-0.5" strokeWidth={2} />
          <div>
            <p className="text-[13px] text-ink">Not currently used by any analytics product.</p>
            <p className="text-[12px] text-muted-2 mt-1">
              Either no fact joins to this entity yet, or its primary key isn&rsquo;t
              referenced anywhere. Worth investigating before relying on it.
            </p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="p-6 space-y-2">
      <p className="text-[11px] text-muted-2 mb-3">
        {rows.length} {rows.length === 1 ? 'fact' : 'facts'} reference this entity.
      </p>
      {rows.map((r) => (
        <a
          key={`${r.productId}-${r.factTable}`}
          href={`/catalog?productId=${r.productId}`}
          className="block border border-line rounded-md bg-raised px-4 py-3 hover:border-ocean/40 transition-colors group"
        >
          <div className="flex items-center gap-2">
            <span className="font-display text-[15px] text-ink group-hover:text-ocean">
              {r.productName}
            </span>
            <ArrowRight className="w-3 h-3 text-muted-2 group-hover:text-ocean" strokeWidth={2} />
            <span className="font-mono text-[12px] text-muted-2">{r.factTable}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {r.joinColumns.map((j, i) => (
              <span
                key={i}
                className="text-[10.5px] font-mono px-1.5 py-0.5 bg-softer text-muted-2 rounded"
              >
                {r.factTable}.{j.fact} = {j.dim}
              </span>
            ))}
          </div>
        </a>
      ))}
    </div>
  );
}

// ── Sample ────────────────────────────────────────────────────────────────

function SampleTab({ tableId, productId }: { tableId: number; productId: number }) {
  const [rows, setRows] = useState<SampleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    // The semantic product-preview endpoint accepts a table id and runs
    // SELECT * LIMIT 100 against the materialised Delta. Reuses existing
    // auth + tenant context.
    api.post('/semantic/product-preview', { product_table_id: tableId })
      .then((r) => {
        if (cancelled) return;
        setRows((r.data?.rows ?? r.data?.data?.rows ?? []) as SampleRow[]);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.response?.data?.error ?? e?.message ?? 'Failed to load');
      });
    return () => { cancelled = true; };
  }, [tableId, productId]);

  if (error) return <div className="p-6 text-[12px] text-err italic">Couldn&rsquo;t load sample: {error}</div>;
  if (rows === null) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted text-[12px]">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading sample…
      </div>
    );
  }
  if (rows.length === 0) return <div className="p-6 text-[12px] text-muted italic">No rows.</div>;
  const cols = Object.keys(rows[0] ?? {});
  return (
    <div className="p-6">
      <div className="overflow-x-auto border border-line rounded-md bg-raised">
        <table className="w-full text-[12px]">
          <thead className="bg-softer/60 border-b border-line">
            <tr>
              {cols.map((c) => (
                <th key={c} className="px-3 py-2 text-left font-mono text-muted-2 tracking-tight">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((row, i) => (
              <tr key={i} className="border-t border-line/50">
                {cols.map((c) => (
                  <td key={c} className="px-3 py-1.5 font-mono tabular-nums text-ink-2 truncate max-w-[200px]">
                    {row[c] == null ? <span className="text-muted-2 italic">null</span> : String(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10.5px] font-mono text-muted-2 mt-2">{rows.length} {rows.length === 1 ? 'row' : 'rows'}</p>
    </div>
  );
}
