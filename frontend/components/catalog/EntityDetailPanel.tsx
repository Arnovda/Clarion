'use client';

/**
 * <EntityDetailPanel> — selection-scope router for the unified /catalog page.
 *
 * Given a typed selection, dispatches to the right detail surface and fetches
 * the data each surface needs. The three flavours are:
 *
 *   - source-table   → <TableDetailPanel>  (existing semantic-layer panel)
 *   - product-table  → <ProductTableDetailPanel>  (existing product-layer panel)
 *   - product-root   → <ProductRootPanel>  (full product detail with tabs)
 *
 * The caller stays free of the per-flavour fetch/cache choreography.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Database, FolderOpen } from 'lucide-react';
import api from '@/lib/api';
import TableDetailPanel from '@/components/semantic/TableDetailPanel';
import ProductTableDetailPanel from '@/components/semantic/ProductTableDetailPanel';
import ProductRootPanel from '@/components/products/ProductRootPanel';
import type {
  SourceTable,
  SourceColumn,
  ProductColumn as SemanticProductColumn,
  ProductTreeItem,
} from '@/components/semantic/types';

export type EntitySelection =
  | { scope: 'source-table'; tableId: number; connectionId: number; columnId?: number | null }
  | { scope: 'product-table'; tableId: number; productId?: number; columnId?: number | null }
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
  /** When the user deletes a product, the parent decides what to do next. */
  onProductDeleted?: () => void;
  /** Optional: parent-supplied connection list so we don't re-fetch domains. */
  connections?: Connection[];
}

export default function EntityDetailPanel({
  selection,
  onSaved,
  onProductDeleted,
  connections = [],
}: Props) {
  if (selection.scope === 'empty') return <EmptyHint />;
  if (selection.scope === 'source-root') return <SourceRootHint connectionId={selection.connectionId} />;
  if (selection.scope === 'product-root') {
    return (
      <ProductRootPanel
        key={`pr-${selection.productId}`}
        productId={selection.productId}
        onDeleted={onProductDeleted}
        showBackButton={false}
        embedAskAI={false}
      />
    );
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
      />
    );
  }
  if (selection.scope === 'product-table') {
    return (
      <ProductTableLoader
        key={`pt-${selection.tableId}`}
        tableId={selection.tableId}
        focusColumnId={selection.columnId ?? null}
        onSaved={onSaved}
      />
    );
  }
  return <EmptyHint />;
}

// ── Loaders ────────────────────────────────────────────────────────────────

function SourceTableLoader({
  tableId, connectionId, focusColumnId, connections, onSaved,
}: {
  tableId: number;
  connectionId: number;
  focusColumnId: number | null;
  connections: Connection[];
  onSaved?: () => void;
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
    />
  );
}

function ProductTableLoader({
  tableId, focusColumnId, onSaved,
}: {
  tableId: number;
  focusColumnId: number | null;
  onSaved?: () => void;
}) {
  const [tree, setTree] = useState<ProductTreeItem[]>([]);
  const [cols, setCols] = useState<SemanticProductColumn[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [treeRes, colRes] = await Promise.all([
        api.get('/semantic/product-tree'),
        api.get(`/semantic/product-columns?tablePgId=${tableId}`),
      ]);
      setTree(treeRes.data.data ?? []);
      setCols(colRes.data.data ?? []);
    } catch {
      setTree([]);
      setCols([]);
    } finally {
      setLoading(false);
    }
  }, [tableId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner label="Loading product table" />;

  return (
    <ProductTableDetailPanel
      tableId={tableId}
      productTree={tree}
      columns={cols}
      focusColumnId={focusColumnId}
      onSaved={() => { load(); onSaved?.(); }}
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
      <p className="text-[13.5px] text-ink-2">{message ?? 'Select a table or product on the left.'}</p>
    </div>
  );
}

function SourceRootHint({ connectionId: _ }: { connectionId: number }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
      <div className="w-12 h-12 rounded-md bg-softer border border-line flex items-center justify-center mb-4 text-muted-2">
        <FolderOpen className="w-5 h-5" strokeWidth={1.5} />
      </div>
      <p className="text-[13.5px] text-ink-2">Pick a table from this connection on the left.</p>
      <p className="text-[12px] text-muted mt-1.5 max-w-md">
        Connection-level actions (rename, re-profile, delete) live under the <span className="font-medium">Manage</span> menu in the top bar.
      </p>
    </div>
  );
}
