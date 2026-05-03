'use client';

/**
 * <CatalogBrowser> — Unity-Catalog-style three-level tree.
 *
 * Catalogs (sources / products) → schemas (connections / data products)
 * → tables → columns. Lazy-loads each level via /api/catalog.
 *
 * Generic on selection: the parent owns `selected` + `onSelect` so the same
 * component drives /semantic, /health, /products and /notebooks. Selection
 * is keyed to the table — the parent decides what to render in the right
 * pane (definition panel, quality panel, etc).
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  ChevronRight, Database, Star, Folder,
  Table as TableIcon, Loader2,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  catalogApi,
  type CatalogId,
  type CatalogEntry,
  type SchemaEntry,
  type TableEntry,
  type ColumnEntry,
} from '@/lib/catalog';

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
}

// ── Visual helpers ──────────────────────────────────────────────────────────

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

export default function CatalogBrowser({ selected, selectedSchema, onSelectTable, onSelectSchema, hide, showRowCounts = true }: Props) {
  const [catalogs, setCatalogs] = useState<CatalogEntry[]>([]);
  const [openCatalogs, setOpenCatalogs] = useState<Set<CatalogId>>(new Set<CatalogId>(['sources']));
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(new Set());
  const [openTables, setOpenTables] = useState<Set<string>>(new Set());
  // Source-buckets within the products catalog. We track CLOSED buckets
  // (inverse) so the default "all open" state is just an empty set —
  // matching how users browse: see everything first, collapse to focus.
  const [closedProductBuckets, setClosedProductBuckets] = useState<Set<string>>(new Set());
  const toggleProductBucket = (key: string) => {
    setClosedProductBuckets((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
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

  // Load catalogs on mount
  useEffect(() => {
    let cancelled = false;
    catalogApi.catalogs()
      .then((rows) => { if (!cancelled) setCatalogs(rows.filter((c) => c.id !== hide)); })
      .catch((e) => { if (!cancelled) setError(e?.message ?? 'Failed to load catalogs'); });
    return () => { cancelled = true; };
  }, [hide]);

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
      n.has(id) ? n.delete(id) : n.add(id);
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

  const totalTables = useMemo(() => {
    return Object.values(tablesBySchema).reduce((sum, arr) => sum + arr.length, 0);
  }, [tablesBySchema]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-soft text-ink-2">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-line shrink-0">
        <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">Catalog</p>
        <p className="text-xs text-muted-2 mt-0.5">
          {catalogs.length} catalogs{totalTables > 0 ? ` · ${totalTables} tables loaded` : ''}
        </p>
      </div>

      {error && (
        <div className="mx-4 mt-2 px-2.5 py-1.5 text-[11px] text-danger bg-danger-soft border border-danger/20 rounded">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0 py-1">
        {catalogs.map((cat) => {
          const catOpen = openCatalogs.has(cat.id);
          const schemas = schemasByCatalog[cat.id] ?? [];
          const catLoading = loadingSchemas.has(cat.id);

          return (
            <div key={cat.id}>
              {/* ── Catalog row ── */}
              <button
                onClick={() => toggleCatalog(cat.id)}
                className="w-full flex items-center gap-2 px-4 py-2 group hover:bg-softer transition-colors"
              >
                <Chevron open={catOpen} />
                <Database
                  className={cn('w-4 h-4 shrink-0', catOpen ? 'text-ocean' : 'text-muted')}
                  strokeWidth={1.5}
                />
                <span className="text-sm font-medium text-ink truncate flex-1 text-left">
                  {cat.label}
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
                    <div className="pl-9 py-2 text-[11px] text-muted-2">No schemas yet</div>
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
                        bucketHeader = (
                          <button
                            key={`bh:${myBucket}`}
                            onClick={() => toggleProductBucket(myBucket)}
                            className="w-full flex items-center gap-2 pl-7 pr-3 py-1.5 hover:bg-softer transition-colors text-left"
                            title={`${inThisBucket} product${inThisBucket === 1 ? '' : 's'}`}
                          >
                            <Chevron open={!bucketCollapsed} />
                            <span className={cn(
                              'text-[10px] font-mono tracking-[0.12em] uppercase shrink-0',
                              myBucket === 'multi' || myBucket === 'deleted' || myBucket === 'unassigned'
                                ? 'text-muted-2'
                                : 'text-ocean',
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
                            'w-full flex items-center gap-2 pl-7 pr-3 py-1.5 group transition-colors border-l-2 -ml-[2px]',
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
                            <Folder
                              className={cn('w-3.5 h-3.5 shrink-0', schemaOpen ? 'text-ocean' : 'text-muted-2')}
                              strokeWidth={1.5}
                            />
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
                                      'w-full flex items-center gap-1.5 pl-10 pr-3 py-1 group transition-colors',
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
                                        <div className="pl-16 py-1 flex items-center gap-2 text-[10px] text-muted-2">
                                          <Loader2 className="w-3 h-3 animate-spin" /> Loading columns…
                                        </div>
                                      )}
                                      {cols.map((col) => (
                                        <div
                                          key={col.id}
                                          className="flex items-center gap-1.5 pl-16 pr-3 py-0.5 hover:bg-softer"
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
                                        <div className="pl-16 py-1 text-[10px] text-muted-2 italic">no columns</div>
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
