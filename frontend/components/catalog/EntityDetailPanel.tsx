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
import { Loader2, Database } from 'lucide-react';
import api from '@/lib/api';
import dynamic from 'next/dynamic';
import TableDetailPanel from '@/components/semantic/TableDetailPanel';
import ProductTableDetailPanel from '@/components/semantic/ProductTableDetailPanel';
import ProductRootPanel from '@/components/products/ProductRootPanel';
import SourceRootPanel from '@/components/catalog/SourceRootPanel';
import ProductPreviewPanel from '@/components/catalog/ProductPreviewPanel';

// Lazy: pulls in recharts via refresh-history chart, not needed on most loads.
const ReferenceDetailPanel = dynamic(
  () => import('@/components/catalog/ReferenceDetailPanel'),
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
  | { scope: 'product-table'; tableId: number; productId?: number; columnId?: number | null }
  /**
   * `reference-table` — same data shape as `product-table`, but routed
   * to ReferenceDetailPanel. Used by the new two-column /catalog when
   * the user clicks a reference (dim) card. Distinct scope so the
   * detail panel can lead with reference-flavoured framing (definition,
   * Used-by, sample) instead of the analytics-flavoured tabs.
   */
  | { scope: 'reference-table'; tableId: number; productId: number }
  | { scope: 'product-root'; productId: number }
  | { scope: 'source-root'; connectionId: number }
  | { scope: 'empty' };

interface Connection {
  id: number;
  domains?: string[];
}

interface ProductHint {
  name: string;
  description: string | null;
  status: string;
  source: {
    id: number | null;
    name: string | null;
    connectorType: string | null;
    multiSource?: boolean;
    sourceDeleted?: boolean;
  };
  last_refreshed_at: string | null;
}

interface Props {
  selection: EntitySelection;
  /** Fired after a save inside any panel so the parent can refresh tree data. */
  onSaved?: () => void;
  /** When the user deletes a product, the parent decides what to do next. */
  onProductDeleted?: () => void;
  /** Optional: parent-supplied connection list so we don't re-fetch domains. */
  connections?: Connection[];
  /**
   * When true, product-root selections render the new clean preview panel
   * (starter questions, key metrics, "see full details"). Defaults to
   * false for backward compat with Structure mode, where the legacy
   * full-tabs panel is the right surface for analysts. The Browse mode
   * on /catalog opts in.
   */
  productPreview?: boolean;
  /** When productPreview is on, an instant header hint avoids the layout
   *  flash while the canonical detail loads. Comes from the card the
   *  user just clicked. */
  productHint?: ProductHint;
  /** Called when the user clicks "Open full view" inside the preview.
   *  The parent expands the slide-over to full-screen for the proper
   *  ProductRootPanel layout (tabs need width). */
  onOpenFullView?: () => void;
  /** Close handler — slides the detail panel away. */
  onClose?: () => void;
}

export default function EntityDetailPanel({
  selection,
  onSaved,
  onProductDeleted,
  connections = [],
  productPreview,
  productHint,
  onOpenFullView,
  onClose,
}: Props) {
  if (selection.scope === 'empty') return <EmptyHint />;
  if (selection.scope === 'source-root') {
    return (
      <SourceRootPanel
        key={`sr-${selection.connectionId}`}
        connectionId={selection.connectionId}
      />
    );
  }
  if (selection.scope === 'product-root') {
    // Browse mode (cards UX) defaults to the clean preview, with a
    // "See full details" button inside that flips to ProductRootPanel
    // for the full tabbed experience. Structure mode keeps the legacy
    // full panel as the default for analyst workflows.
    if (productPreview) {
      return (
        <ProductPreviewPanel
          key={`pp-${selection.productId}`}
          productId={selection.productId}
          hint={productHint}
          onOpenFullView={onOpenFullView}
          onProductDeleted={onProductDeleted}
          onClose={onClose}
        />
      );
    }
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
        onSaved={onSaved}
        onClose={onClose}
      />
    );
  }
  if (selection.scope === 'reference-table') {
    // Lazy import keeps the bundle slim until the user actually opens a
    // reference card — the panel pulls in recharts via the refresh-history
    // chart and isn't needed on the discovery view.
    //
    // productPreview doubles as the "are we in the narrow inset?" hint:
    // when true (cards-mode default), the panel runs in `compact` mode
    // (Overview/Columns/Used-in only, plus an "Open full view" button
    // wired to onOpenFullView). When false (full-screen wrapper) the
    // panel shows all six tabs including Sample/Quality/History.
    return (
      <ReferenceLoader
        key={`rt-${selection.tableId}`}
        tableId={selection.tableId}
        productId={selection.productId}
        compact={productPreview === true}
        onOpenFullView={onOpenFullView}
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
  tableId, focusColumnId, onSaved, onClose,
}: {
  tableId: number;
  focusColumnId: number | null;
  onSaved?: () => void;
  onClose?: () => void;
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
      onClose={onClose}
    />
  );
}

// ── Reference loader ───────────────────────────────────────────────────────

function ReferenceLoader({
  tableId, productId, compact, onOpenFullView, onClose,
}: {
  tableId: number;
  productId: number;
  compact?: boolean;
  onOpenFullView?: () => void;
  onClose?: () => void;
}) {
  return (
    <ReferenceDetailPanel
      key={`rd-${tableId}`}
      tableId={tableId}
      productId={productId}
      compact={compact}
      onOpenFullView={onOpenFullView}
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
      <p className="text-[13.5px] text-ink-2">{message ?? 'Select a table or product on the left.'}</p>
    </div>
  );
}

