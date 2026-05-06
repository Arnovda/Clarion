'use client';

/**
 * /catalog — discovery surface for data products.
 *
 * Two view modes:
 *   - "cards"      (default) — polished card grid of data products. The
 *                  consumer surface; what every role lands on.
 *   - "structure"  (admin + analyst) — the legacy tree + detail view. All
 *                  technical browsing capabilities (sources, schema diagrams,
 *                  AI drafts, the source-vs-product layer chips) stay here
 *                  intact. Toggle in the top-right.
 *
 * View mode is persisted to localStorage so analysts who prefer the tree
 * keep it across sessions; viewers stay on cards.
 *
 * When a card is clicked the existing detail panel opens in an inset to
 * the right (or full-bleed on narrow screens). The detail panel still
 * routes through `<EntityDetailPanel>` so all the existing tabs, edit
 * affordances, and role-gating logic apply unchanged.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Plus, LayoutGrid, Network, Search, X } from 'lucide-react';
import RequireRole from '@/components/RequireRole';
import { isAdmin, getTokenPayload } from '@/lib/auth';
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
import ProductCardGrid, { type ProductCardData } from '@/components/catalog/ProductCardGrid';
import GlossaryMatchCards, { type GlossaryEntry } from '@/components/catalog/GlossaryMatchCards';

type ViewMode = 'cards' | 'structure';
type LayerFilter = 'all' | 'sources' | 'products';

interface Connection { id: number; name: string; domains?: string[]; }

const VIEW_MODE_KEY = 'catalog:viewMode';
const LAYER_KEY     = 'catalog:layer';

function CatalogInner() {
  const router = useRouter();
  const params = useSearchParams();

  // ── Role + view mode ─────────────────────────────────────────────────────
  // Viewers are locked to cards (no toggle visible). Admins/analysts default
  // to cards too — the consumer surface should be everyone's first impression
  // — but they can flip to "structure" for technical browsing.
  const [role, setRole] = useState<'admin' | 'analyst' | 'viewer'>('viewer');
  useEffect(() => {
    const r = getTokenPayload()?.role;
    if (r === 'admin' || r === 'analyst' || r === 'viewer') setRole(r);
  }, []);
  const canSeeStructure = role === 'admin' || role === 'analyst';

  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  useEffect(() => {
    if (!canSeeStructure) return;  // viewers locked to cards
    try {
      const v = window.localStorage.getItem(VIEW_MODE_KEY);
      if (v === 'cards' || v === 'structure') setViewMode(v);
    } catch { /* ignore */ }
  }, [canSeeStructure]);
  const updateViewMode = useCallback((next: ViewMode) => {
    setViewMode(next);
    try { window.localStorage.setItem(VIEW_MODE_KEY, next); } catch { /* ignore */ }
  }, []);

  // ── Search (cards mode) ────────────────────────────────────────────────────
  const [search, setSearch] = useState('');

  // ── Layer filter (structure mode) ──────────────────────────────────────────
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

  // ── Selection state (shared between cards + structure modes) ──────────────
  const [tableSel, setTableSel]               = useState<CatalogSelection | null>(null);
  const [schemaSel, setSchemaSel]             = useState<{ catalog: CatalogId; schemaSlug: string } | null>(null);
  const [productRootId, setProductRootId]     = useState<number | null>(null);
  const [sourceRootConnId, setSourceRootConnId] = useState<number | null>(null);

  // Cards-mode "Open full view" — when true, the slide-over expands to
  // take the full screen width so ProductRootPanel renders with enough
  // room for its 6 tabs. The cards grid hides while this is on. Resets
  // whenever the user closes the panel or selects a different product.
  const [productFullView, setProductFullView] = useState(false);
  useEffect(() => { setProductFullView(false); }, [productRootId]);

  // ── Connection list (used to pass domains into source-table panel) ─────────
  const [connections, setConnections] = useState<Connection[]>([]);
  useEffect(() => {
    api.get('/connections').then((res) => setConnections(res.data.data ?? [])).catch(() => {});
  }, []);

  // ── Product list for cards ────────────────────────────────────────────────
  const [products, setProducts] = useState<ProductCardData[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const loadProducts = useCallback(async () => {
    setProductsLoading(true);
    try {
      const res = await api.get('/products');
      setProducts((res.data.data ?? []) as ProductCardData[]);
    } catch {
      setProducts([]);
    } finally {
      setProductsLoading(false);
    }
  }, []);
  useEffect(() => { loadProducts(); }, [loadProducts]);

  // ── Glossary entries (for search-prioritised matches) ─────────────────────
  // Loaded once and filtered client-side. The Atlan / Hex pattern: when
  // the user types "revenue", we want to show the canonical glossary term
  // BEFORE any matching products or tables. That helps the user learn
  // what the org means by a word, then pick the right product.
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.get('/semantic/glossary')
      .then((r) => {
        if (cancelled) return;
        const rows = (r.data?.data ?? []) as Array<Record<string, unknown>>;
        setGlossary(rows.map((row) => ({
          id:       Number(row.id),
          term:     String(row.term ?? ''),
          meaning:  String(row.meaning ?? ''),
          examples: typeof row.examples === 'string' ? row.examples : null,
          tags:     Array.isArray(row.tags) ? (row.tags as string[]) : null,
        })));
      })
      .catch(() => { if (!cancelled) setGlossary([]); });
    return () => { cancelled = true; };
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

  const handleSelectProductCard = useCallback((productId: number) => {
    setProductRootId(productId);
    setSourceRootConnId(null);
    setTableSel(null);
    setSchemaSel(null);
    router.replace(`/catalog?productId=${productId}`);
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
  const handleSaved = useCallback(() => {
    setRefreshKey((k) => k + 1);
    loadProducts();   // refresh the card data too
  }, [loadProducts]);

  const hideCatalog: CatalogId | undefined =
    layer === 'sources' ? 'products' :
    layer === 'products' ? 'sources' :
    undefined;

  // ── Render ────────────────────────────────────────────────────────────────
  // Detail panel is "open" when there's a real selection, regardless of view
  // mode. In cards mode the detail slides over the right half of the screen;
  // in structure mode the layout is the legacy tree + center detail.
  const detailOpen = selection.scope !== 'empty';

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Top bar */}
      <div className="bg-raised border-b border-line px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <div className="min-w-0">
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">Catalog</p>
            <h1 className="font-display text-[20px] text-ink leading-tight tracking-[-0.02em] truncate">
              {viewMode === 'cards' ? 'Data products' : 'Data sources & products'}
            </h1>
          </div>
          {viewMode === 'structure' && <LayerChips value={layer} onChange={updateLayer} />}
        </div>
        <div className="flex items-center gap-2">
          {canSeeStructure && (
            <ViewModeToggle value={viewMode} onChange={updateViewMode} />
          )}
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
      </div>

      {/* Body */}
      {viewMode === 'cards' ? (
        <CardsBody
          products={products}
          loading={productsLoading}
          search={search}
          onSearchChange={setSearch}
          selectedId={productRootId}
          onSelectProduct={handleSelectProductCard}
          detailOpen={detailOpen}
          onClearSelection={() => {
            setProductRootId(null);
            setTableSel(null);
            setSchemaSel(null);
            setSourceRootConnId(null);
            router.replace('/catalog');
          }}
          selection={selection}
          connections={connections}
          onSaved={handleSaved}
          onProductDeleted={() => {
            setProductRootId(null);
            setSchemaSel(null);
            setRefreshKey((k) => k + 1);
            loadProducts();
          }}
          isAdmin={isAdmin()}
          showCuratorSignals={canSeeStructure}
          onCreate={() => router.push('/products')}
          glossary={glossary}
          fullView={productFullView}
          onRequestFullView={() => setProductFullView(true)}
          onExitFullView={() => setProductFullView(false)}
          productHint={(() => {
            if (!productRootId) return undefined;
            const p = products.find((x) => x.id === productRootId);
            if (!p) return undefined;
            return {
              name: p.name,
              description: p.description,
              status: p.status,
              source: p.source,
              last_refreshed_at: p.last_refreshed_at,
            };
          })()}
        />
      ) : (
        <StructureBody
          refreshKey={refreshKey}
          tableSel={tableSel}
          schemaSel={schemaSel}
          onSelectTable={handleSelectTable}
          onSelectSchema={handleSelectSchema}
          hideCatalog={hideCatalog}
          selection={selection}
          connections={connections}
          onSaved={handleSaved}
          onProductDeleted={() => {
            setProductRootId(null);
            setSchemaSel(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Cards body — search bar + grid + slide-over detail
// ───────────────────────────────────────────────────────────────────────────

function CardsBody(props: {
  products: ProductCardData[];
  loading: boolean;
  search: string;
  onSearchChange: (s: string) => void;
  selectedId: number | null;
  onSelectProduct: (id: number) => void;
  detailOpen: boolean;
  onClearSelection: () => void;
  selection: EntitySelection;
  connections: { id: number; name: string; domains?: string[] }[];
  onSaved: () => void;
  onProductDeleted: () => void;
  isAdmin: boolean;
  showCuratorSignals: boolean;
  onCreate: () => void;
  /** Glossary entries — surfaced as the top section when the user is
   *  searching, so canonical business definitions appear before the
   *  matching products. */
  glossary: GlossaryEntry[];
  /** When true, the slide-over expands to take the full screen for
   *  the ProductRootPanel layout. Cards grid hides. Triggered by the
   *  "Open full view" button inside ProductPreviewPanel. */
  fullView: boolean;
  onRequestFullView: () => void;
  onExitFullView: () => void;
  /** Card data for the currently-selected product — used to seed the
   *  preview header so it renders instantly while the detail loads. */
  productHint: {
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
  } | undefined;
}) {
  // Full-view mode: hide the cards grid + render the detail panel
  // edge-to-edge with the legacy ProductRootPanel (full-width tabs).
  // Top bar adds a "Back to catalog" button so users can return to
  // the grid without using the IconRail.
  if (props.fullView && props.detailOpen) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="bg-softer border-b border-line px-6 py-2.5 flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={props.onExitFullView}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium text-muted hover:text-ink rounded hover:bg-soft transition-colors"
            title="Back to catalog"
          >
            <X className="w-3.5 h-3.5 rotate-45" strokeWidth={2} />
            Back to catalog
          </button>
          <span className="text-[10.5px] font-mono text-muted-2 tracking-[0.12em] uppercase ml-auto">
            Full view
          </span>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <EntityDetailPanel
            selection={props.selection}
            connections={props.connections}
            onSaved={props.onSaved}
            onProductDeleted={props.onProductDeleted}
            productPreview={false}    /* Render the legacy full-tabs panel */
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* Cards column — always visible. Detail panel uses a fixed width
          on lg+ so the cards column always gets at least the rest of the
          screen. No more max-w cap on cards (was needed when the detail
          had flex-1 and could stretch to half the screen). */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6 transition-all">
        <div className="max-w-5xl mx-auto">
          {/* Search bar */}
          <div className="mb-6">
            <SearchInput value={props.search} onChange={props.onSearchChange} />
          </div>

          {/* Glossary terms surface ABOVE the product grid when the user
              is searching. Canonical business definitions before products
              — Atlan / Hex / Lightdash pattern. Hidden when search empty. */}
          <GlossaryMatchCards entries={props.glossary} search={props.search} />

          <ProductCardGrid
            products={props.products}
            search={props.search}
            selectedId={props.selectedId}
            onSelect={props.onSelectProduct}
            onCreate={props.onCreate}
            isAdmin={props.isAdmin}
            loading={props.loading}
            showCuratorSignals={props.showCuratorSignals}
          />
        </div>
      </div>

      {/* Detail panel — slides in from the right when something is selected.
          Uses EntityDetailPanel in PREVIEW mode, which renders a clean
          summary (starter questions, key metrics, "Open full view" button)
          for product-root selections. The "Open full view" button signals
          the parent (this component) to render the full-width view above
          instead of cramming the legacy ProductRootPanel into 480px. */}
      {props.detailOpen && (
        <div className="hidden lg:flex w-[480px] flex-shrink-0 min-h-0 flex-col border-l border-line bg-canvas overflow-hidden relative">
          <EntityDetailPanel
            selection={props.selection}
            connections={props.connections}
            onSaved={props.onSaved}
            onProductDeleted={props.onProductDeleted}
            productPreview={true}
            productHint={props.productHint}
            onOpenFullView={props.onRequestFullView}
            onClose={props.onClearSelection}
          />
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Structure body — legacy tree + detail (admin/analyst only)
// ───────────────────────────────────────────────────────────────────────────

function StructureBody(props: {
  refreshKey: number;
  tableSel: CatalogSelection | null;
  schemaSel: { catalog: CatalogId; schemaSlug: string } | null;
  onSelectTable: (sel: CatalogSelection) => void;
  onSelectSchema: (sel: CatalogSchemaSelection) => void;
  hideCatalog: CatalogId | undefined;
  selection: EntitySelection;
  connections: { id: number; name: string; domains?: string[] }[];
  onSaved: () => void;
  onProductDeleted: () => void;
}) {
  return (
    <div className="flex flex-1 min-h-0">
      <div className="flex-shrink-0 border-r border-line" style={{ width: 280 }}>
        <CatalogBrowser
          key={`browser-${props.refreshKey}`}
          selected={props.tableSel}
          selectedSchema={props.schemaSel}
          onSelectTable={props.onSelectTable}
          onSelectSchema={props.onSelectSchema}
          hide={props.hideCatalog}
        />
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <EntityDetailPanel
          selection={props.selection}
          connections={props.connections}
          onSaved={props.onSaved}
          onProductDeleted={props.onProductDeleted}
        />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Atoms
// ───────────────────────────────────────────────────────────────────────────

function ViewModeToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 bg-softer border border-line rounded-md p-0.5">
      <button
        type="button"
        onClick={() => onChange('cards')}
        className={cn(
          'inline-flex items-center gap-1 px-2 py-1 text-[11.5px] font-medium rounded transition-colors',
          value === 'cards'
            ? 'bg-raised text-ink shadow-sm border border-line'
            : 'text-muted hover:text-ink-2',
        )}
        title="Card grid (browse data products)"
      >
        <LayoutGrid className="w-3 h-3" strokeWidth={2} />
        Browse
      </button>
      <button
        type="button"
        onClick={() => onChange('structure')}
        className={cn(
          'inline-flex items-center gap-1 px-2 py-1 text-[11.5px] font-medium rounded transition-colors',
          value === 'structure'
            ? 'bg-raised text-ink shadow-sm border border-line'
            : 'text-muted hover:text-ink-2',
        )}
        title="Structure view (sources, tables, schema diagram)"
      >
        <Network className="w-3 h-3" strokeWidth={2} />
        Structure
      </button>
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

function SearchInput({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <div className="relative max-w-xl">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-2" strokeWidth={1.75} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search data products by name or description…"
        className="w-full pl-9 pr-9 py-2.5 text-[13.5px] bg-raised border border-line rounded-md focus:outline-none focus:border-ocean focus:ring-2 focus:ring-ocean/20 transition-colors"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-soft text-muted hover:text-ink"
          title="Clear"
        >
          <X className="w-3.5 h-3.5" strokeWidth={2} />
        </button>
      )}
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
