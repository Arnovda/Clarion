'use client';

/**
 * <CatalogBrowser> — THE tree: the one view of everything on the left of the
 * catalog (revision 2 of the declarative-workspace design, 2026-09-22).
 *
 *   Subjects            products, grouped under the SOURCE they are built
 *     [mark] Exact      from — the source's own mark, not a folder glyph
 *       Finance         subject → tables → columns
 *   Sources             every connection, under its mark; the source tables
 *     [mark] Exact      → columns
 *   Your tables         managed grids, one row each (a door to /grids)
 *
 * No layer chips, no view toggle: both roots are open, and the tree is the
 * whole navigation. Lazy-loads each level via /api/catalog; the parent owns
 * the selection and decides what the right-hand view shows.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ChevronRight, Star, Layers, Table2,
  Table as TableIcon, Loader2,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import api from '@/lib/api';
import ConnectorMarkIcon from '@/components/ConnectorMarkIcon';
import {
  catalogApi,
  type CatalogId,
  type CatalogEntry,
  type SchemaEntry,
  type TableEntry,
  type ColumnEntry,
  type CatalogSearchHit,
} from '@/lib/catalog';
import { useDebounce } from '@/lib/hooks/useDebounce';
import { groupSearchHits, matchRange } from '@/lib/catalogSearchTree';

export interface CatalogSelection {
  catalog: CatalogId;
  schemaSlug: string;
  schemaLabel: string;
  tableId: string;
  tableLabel: string;
  tableName: string | null;
  role?: string | null;
}

export interface CatalogSchemaSelection {
  catalog: CatalogId;
  schemaSlug: string;
  schemaLabel: string;
  schemaMeta?: SchemaEntry['meta'];
}

interface Props {
  selected?: CatalogSelection | null;
  /** Highlight a schema-level selection (e.g. a data product root). */
  selectedSchema?: { catalog: CatalogId; schemaSlug: string } | null;
  onSelectTable?: (sel: CatalogSelection) => void;
  /** Fired when the schema label (not the chevron) is clicked. */
  onSelectSchema?: (sel: CatalogSchemaSelection) => void;
  /** Hide one of the catalogs entirely (e.g. notebooks may want sources only). */
  hide?: CatalogId;
  /** Optional: show row counts in the table list (default true). */
  showRowCounts?: boolean;
  /**
   * When set to a non-empty string the tree is FILTERED in place: the
   * search hits are regrouped into the same root › schema › table shape
   * (lib/catalogSearchTree.ts), matching text is bolded, and up to five
   * matching columns show under each table. Clicking a hit selects the
   * table (and the parent's detail panel handles the column focus).
   */
  searchValue?: string;
}

// ── Visual helpers ──────────────────────────────────────────────────────────

/** The roots in the vocabulary the rest of the app uses. */
const ROOT_LABEL: Record<CatalogId, string> = { products: 'Subjects', sources: 'Sources' };

const Chevron = ({ open }: { open: boolean }) => (
  <ChevronRight
    className={cn(
      'w-3 h-3 text-muted-2 transition-transform shrink-0',
      open && 'rotate-90',
    )}
    strokeWidth={2}
  />
);

const roleClass = (role: string | null | undefined) => {
  switch (role) {
    case 'fact':      return 'bg-ocean-softer text-ocean';
    case 'dimension': return 'bg-ai-soft text-ai';
    case 'bridge':    return 'bg-warn-soft text-warn';
    case 'junk':      return 'bg-softer text-muted';
    case 'source':    return 'bg-softer text-muted';
    default:          return 'bg-softer text-muted';
  }
};

const roleAbbrev = (role: string | null | undefined) => {
  switch (role) {
    case 'fact':      return 'FACT';
    case 'dimension': return 'DIM';
    case 'bridge':    return 'BRG';
    case 'junk':      return 'JNK';
    default:          return null;
  }
};

const fmtRows = (n: number | null | undefined) => {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

// Stable key that uniquely identifies a product's source bucket. Mirrors
// `productSourceGroupKey` in <SourceBadge> so URL params / persistence are
// shared between surfaces. Null/empty source → 'unassigned'.
function sourceBucketKeyForSchema(s: SchemaEntry): string {
  if (s.catalog !== 'products') return '';
  const m = s.meta;
  if (!m) return 'unassigned';
  if (m.sourceDeleted) return 'deleted';
  if (m.multiSource) return 'multi';
  if (m.sourceConnectionId != null) return `conn:${m.sourceConnectionId}`;
  return 'unassigned';
}

function sourceBucketLabel(key: string, sample: SchemaEntry | undefined): string {
  if (key === 'multi') return 'Multi-source';
  if (key === 'deleted') return 'Source deleted';
  if (key === 'unassigned') return 'Unassigned';
  return sample?.meta?.sourceConnectionName ?? 'Unknown source';
}

// ── Component ───────────────────────────────────────────────────────────────

export default function CatalogBrowser({ selected, selectedSchema, onSelectTable, onSelectSchema, hide, showRowCounts = true, searchValue }: Props) {
  const [catalogs, setCatalogs] = useState<CatalogEntry[]>([]);
  // Both roots open: the tree IS the navigation, there is nothing else to
  // reveal it. Subjects first — that is what most people came for.
  const [openCatalogs, setOpenCatalogs] = useState<Set<CatalogId>>(new Set<CatalogId>(['products', 'sources']));
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(new Set());
  const [openTables, setOpenTables] = useState<Set<string>>(new Set());
  // Source-buckets within the products catalog. We track CLOSED buckets
  // (inverse) so the default "all open" state is just an empty set —
  // matching how users browse: see everything first, collapse to focus.
  const [closedProductBuckets, setClosedProductBuckets] = useState<Set<string>>(new Set());
  const toggleProductBucket = (key: string) => {
    setClosedProductBuckets((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const [schemasByCatalog, setSchemasByCatalog] = useState<Record<string, SchemaEntry[]>>({});
  const [tablesBySchema,   setTablesBySchema]   = useState<Record<string, TableEntry[]>>({});
  const [columnsByTable,   setColumnsByTable]   = useState<Record<string, ColumnEntry[]>>({});

  const [loadingSchemas, setLoadingSchemas] = useState<Set<string>>(new Set());
  const [loadingTables,  setLoadingTables]  = useState<Set<string>>(new Set());
  const [loadingColumns, setLoadingColumns] = useState<Set<string>>(new Set());

  const [error, setError] = useState<string | null>(null);

  // Load catalogs on mount. Subjects before Sources whatever the API's order.
  useEffect(() => {
    let cancelled = false;
    catalogApi.catalogs()
      .then((rows) => {
        if (cancelled) return;
        const rank = (c: CatalogEntry) => (c.id === 'products' ? 0 : 1);
        setCatalogs(rows.filter((c) => c.id !== hide).sort((a, b) => rank(a) - rank(b)));
      })
      .catch((e) => { if (!cancelled) setError(e?.message ?? 'Failed to load catalogs'); });
    return () => { cancelled = true; };
  }, [hide]);

  // Managed grids — "Your tables". Curators only (the endpoint is); a viewer
  // or a tenant without grids simply gets no third root.
  const [grids, setGrids] = useState<Array<{ id: number; name: string; viewName: string; rowCount: number | null }>>([]);
  useEffect(() => {
    let cancelled = false;
    api.get('/grids')
      .then((r) => { if (!cancelled) setGrids((r.data?.data ?? []) as typeof grids); })
      .catch(() => { if (!cancelled) setGrids([]); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSchemas = useCallback(async (catalog: CatalogId) => {
    if (schemasByCatalog[catalog]) return;
    setLoadingSchemas((s) => new Set(s).add(catalog));
    try {
      const rows = await catalogApi.schemas(catalog);
      setSchemasByCatalog((m) => ({ ...m, [catalog]: rows }));
    } catch (e) {
      setError((e as Error)?.message ?? 'Failed to load schemas');
    } finally {
      setLoadingSchemas((s) => { const n = new Set(s); n.delete(catalog); return n; });
    }
  }, [schemasByCatalog]);

  const loadTables = useCallback(async (catalog: CatalogId, schemaSlug: string) => {
    const key = `${catalog}/${schemaSlug}`;
    if (tablesBySchema[key]) return;
    setLoadingTables((s) => new Set(s).add(key));
    try {
      const rows = await catalogApi.tables(catalog, schemaSlug);
      setTablesBySchema((m) => ({ ...m, [key]: rows }));
    } catch (e) {
      setError((e as Error)?.message ?? 'Failed to load tables');
    } finally {
      setLoadingTables((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  }, [tablesBySchema]);

  const loadColumns = useCallback(async (catalog: CatalogId, schemaSlug: string, tableId: string) => {
    const key = `${catalog}/${schemaSlug}/${tableId}`;
    if (columnsByTable[key]) return;
    setLoadingColumns((s) => new Set(s).add(key));
    try {
      const rows = await catalogApi.columns(catalog, schemaSlug, tableId);
      setColumnsByTable((m) => ({ ...m, [key]: rows }));
    } catch (e) {
      setError((e as Error)?.message ?? 'Failed to load columns');
    } finally {
      setLoadingColumns((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  }, [columnsByTable]);

  // Auto-open catalog/schema for current selection so the tree reflects state
  useEffect(() => {
    if (!selected) return;
    setOpenCatalogs((s) => new Set(s).add(selected.catalog));
    setOpenSchemas((s) => new Set(s).add(`${selected.catalog}/${selected.schemaSlug}`));
    void loadSchemas(selected.catalog);
    void loadTables(selected.catalog, selected.schemaSlug);
  }, [selected, loadSchemas, loadTables]);

  // Eagerly load schemas for any open catalog
  useEffect(() => {
    Array.from(openCatalogs).forEach((c) => void loadSchemas(c));
  }, [openCatalogs, loadSchemas]);

  const toggleCatalog = (id: CatalogId) => {
    setOpenCatalogs((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleSchema = (catalog: CatalogId, schemaSlug: string) => {
    const key = `${catalog}/${schemaSlug}`;
    setOpenSchemas((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else { n.add(key); void loadTables(catalog, schemaSlug); }
      return n;
    });
  };

  const toggleTable = (catalog: CatalogId, schemaSlug: string, tableId: string) => {
    const key = `${catalog}/${schemaSlug}/${tableId}`;
    setOpenTables((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else { n.add(key); void loadColumns(catalog, schemaSlug, tableId); }
      return n;
    });
  };

  // ── Search mode ──────────────────────────────────────────────────────────
  // Debounce so we don't hit the API on every keystroke. The empty / sub-2
  // case short-circuits to the normal tree (kept in lockstep with the
  // backend, which also returns []). Race-safe via cancelled token.
  const debouncedSearch = useDebounce((searchValue ?? '').trim(), 250);
  const isSearching = debouncedSearch.length >= 2;
  const [searchHits, setSearchHits] = useState<CatalogSearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSearching) {
      setSearchHits([]);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    setSearchError(null);
    catalogApi.search(debouncedSearch)
      .then((rows) => { if (!cancelled) setSearchHits(rows); })
      .catch((e) => { if (!cancelled) setSearchError(e?.message ?? 'Search failed'); })
      .finally(() => { if (!cancelled) setSearchLoading(false); });
    return () => { cancelled = true; };
  }, [debouncedSearch, isSearching, hide]);

  // Honour the `hide` prop in the result list too.
  const visibleHits = useMemo(
    () => searchHits.filter((h) => h.catalog !== hide),
    [searchHits, hide],
  );
  // The schema rows the tree already holds, keyed the way hits name them —
  // so a source in the results wears the same mark as in the tree.
  const schemaMetaBySlug = useMemo(() => {
    const m = new Map<string, SchemaEntry>();
    for (const [catalog, rows] of Object.entries(schemasByCatalog)) {
      for (const row of rows) m.set(`${catalog}/${row.id}`, row);
    }
    return m;
  }, [schemasByCatalog]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-soft text-ink-2">
      {error && (
        <div className="mx-4 mt-2 px-2.5 py-1.5 text-[11px] text-danger bg-danger-soft border border-danger/20 rounded">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0 py-1 flex flex-col">
        {isSearching && (
          <SearchResults
            query={debouncedSearch}
            hits={visibleHits}
            loading={searchLoading}
            error={searchError}
            selected={selected ?? null}
            onSelectTable={onSelectTable}
            schemaMetaBySlug={schemaMetaBySlug}
          />
        )}
        {!isSearching && grids.length > 0 && (
          <div className="order-last">
            <div className="w-full flex items-center gap-2 px-4 pt-3 pb-1.5">
              <span className="w-3 shrink-0" aria-hidden />
              <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted-2 font-medium truncate flex-1">Your tables</span>
              <span className="text-[10px] font-mono text-muted-2 tabular-nums">{grids.length}</span>
            </div>
            {grids.map((g) => (
              <Link
                key={g.id}
                href={`/grids/${g.id}`}
                className="flex items-center gap-2 pl-7 pr-3 py-1.5 hover:bg-softer transition-colors border-l-2 border-transparent -ml-[2px]"
                title={`In answers as ${g.viewName}`}
              >
                <Table2 className="w-3.5 h-3.5 shrink-0 text-muted-2" strokeWidth={1.5} />
                <span className="text-[13px] text-ink-2 truncate flex-1">{g.name}</span>
                {g.rowCount != null && (
                  <span className="text-[10px] font-mono text-muted-2 tabular-nums">{fmtRows(g.rowCount)}</span>
                )}
              </Link>
            ))}
          </div>
        )}
        {!isSearching && catalogs.map((cat) => {
          const catOpen = openCatalogs.has(cat.id);
          const schemas = schemasByCatalog[cat.id] ?? [];
          const catLoading = loadingSchemas.has(cat.id);

          return (
            <div key={cat.id}>
              {/* ── Catalog row ── */}
              <button
                onClick={() => toggleCatalog(cat.id)}
                className="w-full flex items-center gap-2 px-4 pt-3 pb-1.5 group hover:bg-softer transition-colors"
              >
                <Chevron open={catOpen} />
                <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted-2 font-medium truncate flex-1 text-left">
                  {ROOT_LABEL[cat.id]}
                </span>
                <span className="text-[10px] font-mono text-muted-2 tabular-nums">
                  {cat.schemaCount}
                </span>
              </button>

              {catOpen && (
                <div>
                  {catLoading && schemas.length === 0 && (
                    <div className="pl-9 py-2 flex items-center gap-2 text-[11px] text-muted-2">
                      <Loader2 className="w-3 h-3 animate-spin" /> Loading schemas…
                    </div>
                  )}

                  {schemas.length === 0 && !catLoading && (
                    <div className="pl-9 py-2 text-[11px] text-muted-2">
                      {cat.id === 'products' ? 'No subjects yet — Build makes them from a source.' : 'No sources yet.'}
                    </div>
                  )}

                  {/*
                    For the products catalog we sort schemas by their source
                    bucket (alphabetical, with Multi-source / Source deleted /
                    Unassigned sunk to the end) so consecutive same-bucket
                    schemas group naturally. The render then emits a single
                    bucket header before the first schema of each new bucket.
                    Sources catalog stays flat — synthetic bucket keys are
                    never assigned so no headers render.
                  */}
                  {(cat.id === 'products'
                    ? [...schemas].sort((a, b) => {
                        const ka = sourceBucketKeyForSchema(a);
                        const kb = sourceBucketKeyForSchema(b);
                        const rank = (k: string) =>
                          k === 'multi' ? 1 : k === 'deleted' ? 2 : k === 'unassigned' ? 3 : 0;
                        const ra = rank(ka), rb = rank(kb);
                        if (ra !== rb) return ra - rb;
                        if (ka !== kb) {
                          const la = sourceBucketLabel(ka, a);
                          const lb = sourceBucketLabel(kb, b);
                          return la.localeCompare(lb);
                        }
                        return a.label.localeCompare(b.label);
                      })
                    : schemas
                  ).map((schema, i, arr) => {
                    // ── Bucket header (products only) ──
                    let bucketHeader: React.ReactNode = null;
                    let bucketCollapsed = false;
                    if (cat.id === 'products') {
                      const myBucket = sourceBucketKeyForSchema(schema);
                      const prevBucket = i > 0 ? sourceBucketKeyForSchema(arr[i - 1]) : null;
                      bucketCollapsed = closedProductBuckets.has(myBucket);
                      if (myBucket !== prevBucket) {
                        const inThisBucket = arr.filter((s) => sourceBucketKeyForSchema(s) === myBucket).length;
                        const synthetic = myBucket === 'multi' || myBucket === 'deleted' || myBucket === 'unassigned';
                        bucketHeader = (
                          <button
                            key={`bh:${myBucket}`}
                            onClick={() => toggleProductBucket(myBucket)}
                            className="w-full flex items-center gap-2 pl-7 pr-3 py-1.5 hover:bg-softer transition-colors text-left"
                            title={`${inThisBucket} subject${inThisBucket === 1 ? '' : 's'} built from ${sourceBucketLabel(myBucket, schema)}`}
                          >
                            <Chevron open={!bucketCollapsed} />
                            {/* The source's own mark: recognised before the name is read. */}
                            {!synthetic && (
                              <ConnectorMarkIcon connectorType={schema.meta?.sourceConnectorType} size="xs" />
                            )}
                            <span className={cn(
                              'text-[12px] truncate',
                              synthetic ? 'text-muted-2 font-mono text-[10px] tracking-[0.12em] uppercase' : 'text-ink-2 font-medium',
                            )}>
                              {sourceBucketLabel(myBucket, schema)}
                            </span>
                            <span className="text-[10px] font-mono text-muted-2 tabular-nums ml-auto">
                              {inThisBucket}
                            </span>
                          </button>
                        );
                      }
                    }

                    // Skip the schema row when its bucket is collapsed —
                    // but still render the (one-shot) header above.
                    if (bucketCollapsed) return bucketHeader;

                    const schemaKey = `${cat.id}/${schema.id}`;
                    const schemaOpen = openSchemas.has(schemaKey);
                    const tables = tablesBySchema[schemaKey] ?? [];
                    const tablesLoading = loadingTables.has(schemaKey);

                    const schemaSelected = selectedSchema?.catalog === cat.id
                      && selectedSchema?.schemaSlug === schema.id;

                    return (
                      <div key={schema.id}>
                        {bucketHeader}
                        {/* ── Schema row (split: chevron toggles, label selects) ── */}
                        <div
                          className={cn(
                            'w-full flex items-center gap-2 pr-3 py-1.5 group transition-colors border-l-2 -ml-[2px]',
                            cat.id === 'products' ? 'pl-10' : 'pl-7',
                            schemaSelected
                              ? 'bg-ocean-softer border-ocean'
                              : 'hover:bg-softer border-transparent',
                          )}
                          title={schema.description ?? schema.label}
                        >
                          <button
                            onClick={() => toggleSchema(cat.id, schema.id)}
                            aria-label={schemaOpen ? 'Collapse tables' : 'Expand tables'}
                            className="p-0.5 rounded hover:bg-soft"
                          >
                            <Chevron open={schemaOpen} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (onSelectSchema) {
                                onSelectSchema({
                                  catalog: cat.id,
                                  schemaSlug: schema.id,
                                  schemaLabel: schema.label,
                                  schemaMeta: schema.meta,
                                });
                              } else {
                                toggleSchema(cat.id, schema.id);
                              }
                            }}
                            className="flex-1 flex items-center gap-2 min-w-0 text-left"
                          >
                            {cat.id === 'sources' ? (
                              <ConnectorMarkIcon connectorType={schema.meta?.connectorType ?? schema.meta?.type} size="xs" />
                            ) : (
                              <Layers
                                className={cn('w-3.5 h-3.5 shrink-0', schemaSelected || schemaOpen ? 'text-ocean' : 'text-muted-2')}
                                strokeWidth={1.5}
                              />
                            )}
                            <span className={cn(
                              'text-[13px] truncate flex-1',
                              schemaSelected ? 'text-ocean font-medium' : 'text-ink-2',
                            )}>
                              {schema.label}
                            </span>
                            <span className="text-[10px] font-mono text-muted-2 tabular-nums">
                              {schema.tableCount}
                            </span>
                          </button>
                        </div>

                        {schemaOpen && (
                          <div>
                            {tablesLoading && tables.length === 0 && (
                              <div className="pl-12 py-1.5 flex items-center gap-2 text-[11px] text-muted-2">
                                <Loader2 className="w-3 h-3 animate-spin" /> Loading tables…
                              </div>
                            )}

                            {!tablesLoading && tables.length === 0 && (
                              <div className="pl-12 py-1.5 text-[11px] text-muted-2 italic">empty</div>
                            )}

                            {tables.map((tbl) => {
                              const tableKey = `${cat.id}/${schema.id}/${tbl.id}`;
                              const tableOpen = openTables.has(tableKey);
                              const cols = columnsByTable[tableKey] ?? [];
                              const colsLoading = loadingColumns.has(tableKey);
                              const isSelected = selected?.tableId === tbl.id
                                && selected?.schemaSlug === schema.id
                                && selected?.catalog === cat.id;
                              const abbrev = roleAbbrev(tbl.role);

                              return (
                                <div key={tbl.id}>
                                  <div
                                    className={cn(
                                      'w-full flex items-center gap-1.5 pr-3 py-1 group transition-colors',
                                      cat.id === 'products' ? 'pl-[52px]' : 'pl-10',
                                      isSelected
                                        ? 'bg-ocean-softer border-l-2 border-ocean -ml-[2px]'
                                        : 'hover:bg-softer border-l-2 border-transparent -ml-[2px]',
                                    )}
                                  >
                                    {/* chevron toggles columns */}
                                    <button
                                      onClick={() => toggleTable(cat.id, schema.id, tbl.id)}
                                      aria-label={tableOpen ? 'Collapse columns' : 'Expand columns'}
                                      className="p-0.5 rounded hover:bg-soft"
                                    >
                                      <Chevron open={tableOpen} />
                                    </button>

                                    {/* main table click → select */}
                                    <button
                                      onClick={() => onSelectTable?.({
                                        catalog: cat.id,
                                        schemaSlug: schema.id,
                                        schemaLabel: schema.label,
                                        tableId: tbl.id,
                                        tableLabel: tbl.label,
                                        tableName: tbl.tableName,
                                        role: tbl.role ?? null,
                                      })}
                                      className="flex items-center gap-1.5 flex-1 text-left min-w-0"
                                    >
                                      <TableIcon
                                        className={cn('w-3.5 h-3.5 shrink-0',
                                          isSelected ? 'text-ocean' : 'text-muted-2')}
                                        strokeWidth={1.5}
                                      />
                                      <span className={cn(
                                        'text-[12px] truncate',
                                        isSelected ? 'text-ink font-medium' : 'text-ink-2',
                                      )}>
                                        {tbl.label}
                                      </span>
                                      {abbrev && (
                                        <span className={cn(
                                          'shrink-0 text-[9px] font-mono px-1 py-0.5 rounded tracking-wider',
                                          roleClass(tbl.role),
                                        )}>
                                          {abbrev}
                                        </span>
                                      )}
                                    </button>

                                    {showRowCounts && tbl.rowCount != null && (
                                      <span className="shrink-0 text-[10px] font-mono text-muted-2 tabular-nums">
                                        {fmtRows(tbl.rowCount)}
                                      </span>
                                    )}
                                  </div>

                                  {tableOpen && (
                                    <div>
                                      {colsLoading && cols.length === 0 && (
                                        <div className={cn('py-1 flex items-center gap-2 text-[10px] text-muted-2', cat.id === 'products' ? 'pl-[76px]' : 'pl-16')}>
                                          <Loader2 className="w-3 h-3 animate-spin" /> Loading columns…
                                        </div>
                                      )}
                                      {cols.map((col) => (
                                        <div
                                          key={col.id}
                                          className={cn('flex items-center gap-1.5 pr-3 py-0.5 hover:bg-softer', cat.id === 'products' ? 'pl-[76px]' : 'pl-16')}
                                          title={col.description ?? col.name ?? ''}
                                        >
                                          <Star className="w-2.5 h-2.5 text-muted-2 shrink-0" strokeWidth={1.5} />
                                          <span className="text-[11px] text-ink-2 truncate flex-1">
                                            {col.name}
                                          </span>
                                          {col.type && (
                                            <span className="text-[9px] font-mono text-muted-2 tracking-wider uppercase shrink-0">
                                              {col.type}
                                            </span>
                                          )}
                                        </div>
                                      ))}
                                      {!colsLoading && cols.length === 0 && (
                                        <div className={cn('py-1 text-[10px] text-muted-2 italic', cat.id === 'products' ? 'pl-[76px]' : 'pl-16')}>no columns</div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Search results — the tree, filtered. A query does not replace the tree
// with a flat list; it keeps catalog › schema › table and drops what did
// not match, with the matched text in bold (the Databricks explorer's
// behaviour, asked for 2026-09-23). Sources keep their mark, subjects their
// glyph, so a hit reads the same as the row it would be in the full tree.
// Clicking the table row, or any of its column matches, selects the table.
// ───────────────────────────────────────────────────────────────────────────

function SearchResults({
  query, hits, loading, error, selected, onSelectTable, schemaMetaBySlug,
}: {
  query: string;
  hits: CatalogSearchHit[];
  loading: boolean;
  error: string | null;
  selected: CatalogSelection | null;
  onSelectTable?: (sel: CatalogSelection) => void;
  /** The tree's own schema rows, for the marks — absent until loaded. */
  schemaMetaBySlug: Map<string, SchemaEntry>;
}) {
  const tree = useMemo(() => groupSearchHits(hits), [hits]);
  const total = tree.reduce((n, c) => n + c.schemas.reduce((m, sc) => m + sc.tables.length, 0), 0);

  if (error) {
    return (
      <div className="mx-4 mt-2 px-2.5 py-1.5 text-[11px] text-danger bg-danger-soft border border-danger/20 rounded">
        {error}
      </div>
    );
  }
  if (loading && total === 0) {
    return (
      <div className="px-4 py-3 flex items-center gap-2 text-[11px] text-muted-2">
        <Loader2 className="w-3 h-3 animate-spin" /> Searching…
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="px-4 py-3 text-[12px] text-muted-2 italic">
        No tables or columns match &ldquo;{query}&rdquo;.
      </div>
    );
  }

  return (
    <div>
      {tree.map((cat) => (
        <div key={cat.catalog}>
          <div className="w-full flex items-center gap-2 px-4 pt-3 pb-1.5">
            <Chevron open />
            <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted-2 font-medium truncate flex-1">
              {ROOT_LABEL[cat.catalog]}
            </span>
          </div>
          {cat.schemas.map((schema) => {
            const meta = schemaMetaBySlug.get(`${schema.catalog}/${schema.schemaSlug}`)?.meta;
            return (
              <div key={`${schema.catalog}/${schema.schemaSlug}`}>
                <div className="flex items-center gap-2 pl-7 pr-3 py-1.5">
                  <Chevron open />
                  {cat.catalog === 'sources' ? (
                    <ConnectorMarkIcon connectorType={meta?.connectorType ?? meta?.type} size="xs" />
                  ) : (
                    <Layers className="w-3.5 h-3.5 shrink-0 text-muted-2" strokeWidth={1.5} />
                  )}
                  <span className="text-[13px] text-ink-2 truncate flex-1">
                    <HighlightMatch text={schema.schemaLabel} query={query} />
                  </span>
                  <span className="text-[10px] font-mono text-muted-2 tabular-nums">{schema.tables.length}</span>
                </div>
                {schema.tables.map((g) => {
                  const isSelected = selected?.catalog === schema.catalog
                    && selected?.schemaSlug === schema.schemaSlug
                    && selected?.tableId === g.tableId;
                  const abbrev = roleAbbrev(g.role);
                  const select = () => onSelectTable?.({
                    catalog: schema.catalog,
                    schemaSlug: schema.schemaSlug,
                    schemaLabel: schema.schemaLabel,
                    tableId: g.tableId,
                    tableLabel: g.tableLabel,
                    tableName: g.tableName,
                    role: g.role,
                  });
                  return (
                    <div key={g.tableId}>
                      <button
                        onClick={select}
                        className={cn(
                          'w-full flex items-center gap-1.5 pl-10 pr-3 py-1 text-left transition-colors border-l-2 -ml-[2px]',
                          isSelected ? 'bg-ocean-softer border-ocean' : 'hover:bg-softer border-transparent',
                        )}
                      >
                        <TableIcon className={cn('w-3.5 h-3.5 shrink-0', isSelected ? 'text-ocean' : 'text-muted-2')} strokeWidth={1.5} />
                        <span className={cn('text-[12px] truncate flex-1', isSelected ? 'text-ink font-medium' : 'text-ink-2')}>
                          <HighlightMatch text={g.tableLabel} query={query} />
                        </span>
                        {abbrev && (
                          <span className={cn('text-[9px] font-mono uppercase tracking-[0.06em] px-1 py-0.5 rounded shrink-0', roleClass(g.role))}>
                            {abbrev}
                          </span>
                        )}
                      </button>
                      {g.columns.length > 0 && (
                        <div className="pl-16 pr-3 pb-1">
                          {g.columns.slice(0, 5).map((c) => (
                            <button
                              key={c.name}
                              onClick={select}
                              className="block w-full text-left py-0.5 text-[11px] text-muted-2 hover:text-ocean transition-colors truncate"
                              title={c.name}
                            >
                              <HighlightMatch text={c.label} query={query} />
                            </button>
                          ))}
                          {g.columns.length > 5 && (
                            <span className="block text-[10px] text-muted-2 italic py-0.5">+{g.columns.length - 5} more columns</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The matched text in bold — the explorer's "waterinfo_**meetreeksen**". */
function HighlightMatch({ text, query }: { text: string; query: string }) {
  const range = matchRange(text, query);
  if (!range) return <>{text}</>;
  const [from, to] = range;
  return (
    <>
      {text.slice(0, from)}
      <span className="font-semibold text-ink">{text.slice(from, to)}</span>
      {text.slice(to)}
    </>
  );
}
