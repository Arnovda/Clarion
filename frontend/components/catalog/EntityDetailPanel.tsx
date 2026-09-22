'use client';

/**
 * <EntityDetailPanel> — selection-scope router for the /catalog page.
 *
 * Given a typed selection, dispatches to the right detail surface and fetches
 * the data each surface needs. ONE view per thing (the catalog is the
 * workspace, 2026-09-22 — no cards inset, no preview flavour):
 *
 *   - source-root    → <SourceRootPanel>
 *   - source-table   → <TableDetailPanel>
 *   - product-root   → <ProductFullView>
 *   - product-table  → <ProductTableDetailPanel> — the table's declaration:
 *                      what it holds, where it comes from, the SQL that
 *                      builds it. `tableId` may be a graph id OR a Postgres
 *                      product_tables id; the loader resolves both.
 *
 * The caller stays free of the per-flavour fetch choreography.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Database } from 'lucide-react';
import api from '@/lib/api';
import dynamic from 'next/dynamic';
import TableDetailPanel from '@/components/semantic/TableDetailPanel';
import ProductTableDetailPanel from '@/components/semantic/ProductTableDetailPanel';
import SourceRootPanel from '@/components/catalog/SourceRootPanel';

// Lazy: the full product page pulls in preview tables etc. — only needed
// when a subject is actually opened.
const ProductFullView = dynamic(
  () => import('@/components/catalog/ProductFullView'),
  { ssr: false },
);
import type {
  SourceTable,
  SourceColumn,
  ProductColumn as SemanticProductColumn,
  ProductTreeItem,
} from '@/components/semantic/types';

export type EntitySelection =
  | { scope: 'source-table'; tableId: number; connectionId: number; columnId?: number | null }
  /** `tableId` is a graph id (the tree) OR a Postgres product_tables id (deep links). */
  | { scope: 'product-table'; tableId: number; productId?: number; columnId?: number | null; initialTab?: 'sql' }
  | { scope: 'product-root'; productId: number }
  | { scope: 'source-root'; connectionId: number }
  | { scope: 'empty' };

interface Connection {
  id: number;
  domains?: string[];
}

interface Props {
  selection: EntitySelection;
  /** Fired after a save inside any panel so the parent can refresh tree data. */
  onSaved?: () => void;
  /** Optional: parent-supplied connection list so we don't re-fetch domains. */
  connections?: Connection[];
  /** Close handler — clears the selection. */
  onClose?: () => void;
  /** Landing when nothing is selected; defaults to a quiet hint. */
  empty?: React.ReactNode;
}

export default function EntityDetailPanel({
  selection,
  onSaved,
  connections = [],
  onClose,
  empty,
}: Props) {
  if (selection.scope === 'empty') return <>{empty ?? <EmptyHint />}</>;
  if (selection.scope === 'source-root') {
    return (
      <SourceRootPanel
        key={`sr-${selection.connectionId}`}
        connectionId={selection.connectionId}
      />
    );
  }
  if (selection.scope === 'product-root') {
    return <ProductFullView key={`pf-${selection.productId}`} productId={selection.productId} />;
  }
  if (selection.scope === 'source-table') {
    return (
      <SourceTableLoader
        key={`st-${selection.tableId}`}
        tableId={selection.tableId}
        connectionId={selection.connectionId}
        focusColumnId={selection.columnId ?? null}
        connections={connections}
        onSaved={onSaved}
        onClose={onClose}
      />
    );
  }
  if (selection.scope === 'product-table') {
    return (
      <ProductTableLoader
        key={`pt-${selection.tableId}`}
        tableId={selection.tableId}
        focusColumnId={selection.columnId ?? null}
        initialTab={selection.initialTab}
        onSaved={onSaved}
        onClose={onClose}
      />
    );
  }
  return <EmptyHint />;
}

// ── Loaders ────────────────────────────────────────────────────────────────

function SourceTableLoader({
  tableId, connectionId, focusColumnId, connections, onSaved, onClose,
}: {
  tableId: number;
  connectionId: number;
  focusColumnId: number | null;
  connections: Connection[];
  onSaved?: () => void;
  onClose?: () => void;
}) {
  const [table, setTable] = useState<SourceTable | null>(null);
  const [cols, setCols] = useState<SourceColumn[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, cRes] = await Promise.all([
        api.get(`/semantic/tables?connectionId=${connectionId}`),
        api.get(`/semantic/columns?tableId=${tableId}`),
      ]);
      const tables: SourceTable[] = tRes.data.data ?? [];
      const found = tables.find((t) => t.id === tableId) ?? null;
      setTable(found);
      setCols(cRes.data.data ?? []);
    } catch {
      setTable(null);
      setCols([]);
    } finally {
      setLoading(false);
    }
  }, [tableId, connectionId]);

  useEffect(() => { load(); }, [load]);

  const domains = connections.find((c) => c.id === connectionId)?.domains ?? [];

  if (loading) return <Spinner label="Loading table" />;
  if (!table) return <EmptyHint message="Table not found." />;

  return (
    <TableDetailPanel
      table={table}
      columns={cols}
      focusColumnId={focusColumnId}
      connectionDomains={domains}
      onSaved={() => { load(); onSaved?.(); }}
      onClose={onClose}
    />
  );
}

function ProductTableLoader({
  tableId, focusColumnId, initialTab, onSaved, onClose,
}: {
  /** Graph id (the tree) OR Postgres product_tables id (deep links) —
   *  resolved against the tree below. */
  tableId: number;
  focusColumnId: number | null;
  initialTab?: 'sql';
  onSaved?: () => void;
  onClose?: () => void;
}) {
  const [tree, setTree] = useState<ProductTreeItem[]>([]);
  const [cols, setCols] = useState<SemanticProductColumn[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Sequential on purpose: the columns endpoint matches GRAPH ids only
      // (getProductColumnsByTablePgId), while reference cards hand us the
      // Postgres id. Resolve through the tree (which carries both ids since
      // Release A's pg_table_id) before asking for columns.
      const treeRes = await api.get('/semantic/product-tree');
      const items: ProductTreeItem[] = treeRes.data.data ?? [];
      setTree(items);
      const found = items
        .flatMap((p) => p.starSchemas ?? [])
        .flatMap((s) => s.tables ?? [])
        .find((t) => t.id === tableId
          || (t as { pg_table_id?: number | null }).pg_table_id === tableId);
      const graphId = found?.id ?? tableId;
      const colRes = await api.get(`/semantic/product-columns?tablePgId=${graphId}`);
      setCols(colRes.data.data ?? []);
    } catch {
      setTree([]);
      setCols([]);
    } finally {
      setLoading(false);
    }
  }, [tableId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner label="Loading table" />;

  return (
    <ProductTableDetailPanel
      tableId={tableId}
      productTree={tree}
      columns={cols}
      focusColumnId={focusColumnId}
      initialTab={initialTab}
      onSaved={() => { load(); onSaved?.(); }}
      onClose={onClose}
    />
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted">
      <Loader2 className="w-5 h-5 animate-spin" />
      <p className="text-[12px]">{label}</p>
    </div>
  );
}

function EmptyHint({ message }: { message?: string } = {}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
      <div className="w-12 h-12 rounded-md bg-softer border border-line flex items-center justify-center mb-4 text-muted-2">
        <Database className="w-5 h-5" strokeWidth={1.5} />
      </div>
      <p className="text-[13.5px] text-ink-2">{message ?? 'Pick a subject, a table or a source on the left.'}</p>
    </div>
  );
}

