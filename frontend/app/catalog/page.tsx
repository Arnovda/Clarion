'use client';

/**
 * /catalog — unified entry point for browsing data sources and data products.
 *
 * Replaces the old /semantic and /products surfaces. The layout is a fixed
 * left tree (`<CatalogBrowser>`) + a center detail panel (`<EntityDetailPanel>`)
 * that dispatches by selection scope. Authoring affordances (rebuild,
 * delete, etc.) live inside `<ProductRootPanel>` for now — step 3 of the
 * /catalog migration will lift them into a top-bar `<ManageMenu>`.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import RequireRole from '@/components/RequireRole';
import { isAdmin } from '@/lib/auth';
import CatalogBrowser, {
  type CatalogSchemaSelection,
} from '@/components/catalog/CatalogBrowser';
import EntityDetailPanel, {
  type EntitySelection,
} from '@/components/catalog/EntityDetailPanel';
import type { CatalogSelection } from '@/components/catalog/CatalogBrowser';
import type { CatalogId } from '@/lib/catalog';
import { parseIdFromSlug } from '@/lib/catalog';
import { cn } from '@/lib/cn';
import api from '@/lib/api';

type LayerFilter = 'all' | 'sources' | 'products';

interface Connection { id: number; name: string; domains?: string[]; }

const LAYER_KEY = 'catalog:layer';

function CatalogInner() {
  const router = useRouter();
  const params = useSearchParams();

  // ── Layer filter (chip row) ────────────────────────────────────────────────
  const [layer, setLayer] = useState<LayerFilter>('all');
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(LAYER_KEY);
      if (v === 'sources' || v === 'products' || v === 'all') setLayer(v);
    } catch { /* ignore */ }
  }, []);
  const updateLayer = useCallback((next: LayerFilter) => {
    setLayer(next);
    try { window.localStorage.setItem(LAYER_KEY, next); } catch { /* ignore */ }
  }, []);

  // ── Selection state ────────────────────────────────────────────────────────
  const [tableSel, setTableSel] = useState<CatalogSelection | null>(null);
  const [schemaSel, setSchemaSel] = useState<{ catalog: CatalogId; schemaSlug: string } | null>(null);
  const [productRootId, setProductRootId] = useState<number | null>(null);
  const [sourceRootConnId, setSourceRootConnId] = useState<number | null>(null);

  // ── Connection list (used to pass domains into source-table panel) ─────────
  const [connections, setConnections] = useState<Connection[]>([]);
  useEffect(() => {
    api.get('/connections').then((res) => setConnections(res.data.data ?? [])).catch(() => {});
  }, []);

  // ── Restore selection from URL on mount ────────────────────────────────────
  useEffect(() => {
    const productId = params.get('productId');
    if (productId) {
      const id = Number(productId);
      if (Number.isFinite(id)) setProductRootId(id);
    }
    // (Future: support ?catalog=&schema=&table=&column= for shareable deep links.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Selection handlers ─────────────────────────────────────────────────────
  const handleSelectTable = useCallback((sel: CatalogSelection) => {
    setTableSel(sel);
    setSchemaSel({ catalog: sel.catalog, schemaSlug: sel.schemaSlug });
    setProductRootId(null);
    setSourceRootConnId(null);
    // Update URL silently for shareability
    if (sel.catalog === 'products') {
      router.replace(`/catalog?productId=${parseIdFromSlug(sel.schemaSlug) ?? ''}&tableId=${sel.tableId}`);
    } else {
      router.replace('/catalog');
    }
  }, [router]);

  const handleSelectSchema = useCallback((sel: CatalogSchemaSelection) => {
    setTableSel(null);
    setSchemaSel({ catalog: sel.catalog, schemaSlug: sel.schemaSlug });
    if (sel.catalog === 'products') {
      const productId = sel.schemaMeta?.dataProductId ?? parseIdFromSlug(sel.schemaSlug);
      if (productId) {
        setProductRootId(productId);
        setSourceRootConnId(null);
        router.replace(`/catalog?productId=${productId}`);
      }
    } else {
      const connId = sel.schemaMeta?.connectionId ?? parseIdFromSlug(sel.schemaSlug);
      if (connId) {
        setSourceRootConnId(connId);
        setProductRootId(null);
        router.replace('/catalog');
      }
    }
  }, [router]);

  // ── Compute the selection passed to the detail panel ──────────────────────
  const selection = useMemo<EntitySelection>(() => {
    if (productRootId) return { scope: 'product-root', productId: productRootId };
    if (tableSel) {
      const id = Number(tableSel.tableId);
      if (!Number.isFinite(id)) return { scope: 'empty' };
      if (tableSel.catalog === 'sources') {
        const connId = parseIdFromSlug(tableSel.schemaSlug);
        if (!connId) return { scope: 'empty' };
        return { scope: 'source-table', tableId: id, connectionId: connId };
      }
      return { scope: 'product-table', tableId: id };
    }
    if (sourceRootConnId) return { scope: 'source-root', connectionId: sourceRootConnId };
    return { scope: 'empty' };
  }, [productRootId, tableSel, sourceRootConnId]);

  // ── Refresh trigger so child saves can flow to siblings/tree ──────────────
  const [refreshKey, setRefreshKey] = useState(0);
  const handleSaved = useCallback(() => setRefreshKey((k) => k + 1), []);

  const hideCatalog: CatalogId | undefined =
    layer === 'sources' ? 'products' :
    layer === 'products' ? 'sources' :
    undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Top bar */}
      <div className="bg-raised border-b border-line px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-4">
          <div>
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">Catalog</p>
            <h1 className="font-display text-[20px] text-ink leading-tight tracking-[-0.02em]">
              Data sources & products
            </h1>
          </div>
          <LayerChips value={layer} onChange={updateLayer} />
        </div>
        {isAdmin() && (
          <button
            type="button"
            onClick={() => router.push('/products')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
            title="Design a new data product from your sources"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={2} />
            New product
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-shrink-0 border-r border-line" style={{ width: 280 }}>
          <CatalogBrowser
            key={`browser-${refreshKey}`}
            selected={tableSel}
            selectedSchema={schemaSel}
            onSelectTable={handleSelectTable}
            onSelectSchema={handleSelectSchema}
            hide={hideCatalog}
          />
        </div>
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <EntityDetailPanel
            selection={selection}
            connections={connections}
            onSaved={handleSaved}
            onProductDeleted={() => {
              setProductRootId(null);
              setSchemaSel(null);
              setRefreshKey((k) => k + 1);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function LayerChips({ value, onChange }: { value: LayerFilter; onChange: (v: LayerFilter) => void }) {
  const chips: { id: LayerFilter; label: string }[] = [
    { id: 'all',      label: 'All' },
    { id: 'sources',  label: 'Sources' },
    { id: 'products', label: 'Products' },
  ];
  return (
    <div className="inline-flex items-center gap-0.5 bg-softer border border-line rounded-md p-0.5">
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onChange(c.id)}
          className={cn(
            'px-2.5 py-1 text-[12px] font-medium rounded transition-colors',
            value === c.id
              ? 'bg-raised text-ink shadow-sm border border-line'
              : 'text-muted hover:text-ink-2',
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

export default function CatalogPage() {
  return (
    <RequireRole roles={['admin', 'analyst', 'viewer']}>
      <Suspense fallback={
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted" />
        </div>
      }>
        <CatalogInner />
      </Suspense>
    </RequireRole>
  );
}
