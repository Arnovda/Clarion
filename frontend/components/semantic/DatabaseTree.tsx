'use client';

import { useMemo, useState } from 'react';
import { SourceTable, SourceColumn, ProductTable, ProductColumn, ProductTreeItem } from './types';

interface Connection {
  id: number;
  name: string;
}

interface Props {
  connections: Connection[];
  tablesByConnection: Record<number, SourceTable[]>;
  columnsByTable: Record<number, SourceColumn[]>;
  expandedConnectionIds: Set<number>;
  loadingConnectionIds: Set<number>;
  activeConnectionId: number | null;
  selectedTableId: number | null;
  selectedColumnId: number | null;
  onToggleConnection: (id: number) => void;
  onSelectTable: (connectionId: number, tableId: number) => void;
  onSelectColumn: (tableId: number, columnId: number) => void;
  productTree?: ProductTreeItem[];
  productColumnsByTable?: Record<number, ProductColumn[]>;
  selectedProductTableId?: number | null;
  selectedProductColumnId?: number | null;
  onSelectProductTable?: (productId: number, tableId: number) => void;
  onSelectProductColumn?: (tableId: number, columnId: number) => void;
  loadingProductIds?: Set<number>;
}

// ── Icons (Observatory: ocean when active, muted when idle) ─────────────────

const DbIcon = ({ active }: { active?: boolean }) => (
  <svg className={`w-4 h-4 flex-shrink-0 transition-colors ${active ? 'text-ocean' : 'text-muted'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <ellipse cx="12" cy="6" rx="8" ry="3" strokeWidth={1.5} />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6v6c0 1.657 3.582 3 8 3s8-1.343 8-3V6" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 12v6c0 1.657 3.582 3 8 3s8-1.343 8-3v-6" />
  </svg>
);

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg className={`w-3 h-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
  </svg>
);

const TableIcon = ({ active }: { active: boolean }) => (
  <svg className={`w-3.5 h-3.5 flex-shrink-0 transition-colors ${active ? 'text-ocean' : 'text-muted-2'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
      d="M3 10h18M3 14h18M10 4v16M3 4h18a1 1 0 011 1v14a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1z" />
  </svg>
);

// ── Health ring (circular progress indicator) ───────────────────────────────

function HealthRing({ percent, size = 16 }: { percent: number; size?: number }) {
  const r = (size - 4) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (percent / 100) * circumference;
  const color = percent >= 80 ? '#3f7a5c' : percent >= 50 ? '#a06a1c' : '#a43a3a';

  return (
    <svg className="health-ring flex-shrink-0" width={size} height={size}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(13,28,47,0.08)" />
      <circle cx={size / 2} cy={size / 2} r={r} stroke={color}
        strokeDasharray={circumference} strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
    </svg>
  );
}

// ── Role color (Observatory tokens) ─────────────────────────────────────────

const roleColor = (role: string | null): string => {
  switch (role) {
    case 'fact':       return 'bg-ocean-softer text-ocean';
    case 'dimension':  return 'bg-ai-soft text-ai';
    case 'bridge':     return 'bg-warn-soft text-warn';
    case 'junk':       return 'bg-softer text-muted';
    default:           return 'bg-softer text-muted';
  }
};

// ── Shared dimension type ───────────────────────────────────────────────────

interface SharedDim {
  tableName: string;
  bestTable: ProductTable;
  bestProductId: number;
  usedByProducts: string[];
}

// ── Component ───────────────────────────────────────────────────────────────

export default function DatabaseTree({
  connections, tablesByConnection, columnsByTable,
  expandedConnectionIds, loadingConnectionIds,
  activeConnectionId,
  selectedTableId, selectedColumnId,
  onToggleConnection, onSelectTable, onSelectColumn,
  productTree = [],
  productColumnsByTable = {},
  selectedProductTableId,
  selectedProductColumnId,
  onSelectProductTable,
  onSelectProductColumn,
  loadingProductIds,
}: Props) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  function toggleSection(id: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // ── Deduplicate dimensions & collect fact tables ──────────────────────────
  const { sharedDimensions, factsByProduct } = useMemo(() => {
    const dimByName = new Map<string, { best: ProductTable; bestProductId: number; bestColCount: number; products: Set<string> }>();
    const facts: { product: ProductTreeItem; table: ProductTable }[] = [];

    for (const product of productTree) {
      for (const schema of product.starSchemas) {
        for (const table of schema.tables) {
          if (table.table_role === 'dimension' || table.table_role === 'bridge' || table.table_role === 'junk') {
            const name = table.table_name;
            const existing = dimByName.get(name);
            const colCount = table.column_count ?? 0;
            if (!existing) {
              dimByName.set(name, { best: table, bestProductId: product.productId, bestColCount: colCount, products: new Set([product.productName]) });
            } else {
              existing.products.add(product.productName);
              if (colCount > existing.bestColCount) {
                existing.best = table;
                existing.bestProductId = product.productId;
                existing.bestColCount = colCount;
              }
            }
          } else {
            facts.push({ product, table });
          }
        }
      }
    }

    const dims: SharedDim[] = [...dimByName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tableName, { best, bestProductId, products }]) => ({
        tableName,
        bestTable: best,
        bestProductId,
        usedByProducts: [...products].sort(),
      }));

    const fMap = new Map<number, { product: ProductTreeItem; tables: ProductTable[] }>();
    for (const f of facts) {
      const existing = fMap.get(f.product.productId);
      if (existing) { existing.tables.push(f.table); }
      else { fMap.set(f.product.productId, { product: f.product, tables: [f.table] }); }
    }

    return { sharedDimensions: dims, factsByProduct: [...fMap.values()] };
  }, [productTree]);

  const hasProducts = sharedDimensions.length > 0 || factsByProduct.length > 0;

  // ── Compute health per connection ─────────────────────────────────────────
  function connectionHealth(connId: number): number {
    const tables = tablesByConnection[connId] ?? [];
    if (tables.length === 0) return 0;
    const confirmed = tables.filter((t) => !t.ai_draft).length;
    return Math.round((confirmed / tables.length) * 100);
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-soft text-ink-2">
      <div className="flex-1 overflow-y-auto py-1 min-h-0">

        {/* ── Data Sources ── */}
        <div className="px-4 pt-4 pb-2 flex-shrink-0">
          <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">
            Data sources
          </p>
        </div>

        {connections.map((conn) => {
          const isConnExpanded = expandedConnectionIds.has(conn.id);
          const isLoading      = loadingConnectionIds.has(conn.id);
          const tables         = tablesByConnection[conn.id] ?? [];
          const health         = connectionHealth(conn.id);

          return (
            <div key={conn.id}>
              <button
                onClick={() => onToggleConnection(conn.id)}
                className={`w-full flex items-center gap-2.5 px-4 py-2 transition-colors group select-none border-l-2 ${
                  activeConnectionId === conn.id
                    ? 'bg-ocean-softer border-ocean'
                    : 'border-transparent hover:bg-softer'
                }`}
              >
                <ChevronIcon expanded={isConnExpanded} />
                <DbIcon active={activeConnectionId === conn.id} />
                <span className={`text-[13px] truncate flex-1 text-left ${
                  activeConnectionId === conn.id ? 'text-ink font-medium' : 'text-ink-2'
                }`}>
                  {conn.name}
                </span>
                {isLoading ? (
                  <div className="w-3 h-3 border border-ocean border-t-transparent rounded-full animate-spin flex-shrink-0" />
                ) : tables.length > 0 ? (
                  <HealthRing percent={health} />
                ) : null}
              </button>

              {isConnExpanded && !isLoading && (
                <div className="ml-5 border-l border-line">
                  {tables.length === 0 ? (
                    <p className="pl-4 py-3 text-[11px] font-mono tracking-[0.06em] uppercase text-muted-2 italic">
                      No tables found
                    </p>
                  ) : (
                    tables.map((table) => {
                      const isSelected = selectedTableId === table.id && !selectedProductTableId;
                      return (
                        <div
                          key={table.id}
                          className={`flex items-center gap-2 pl-4 pr-3 py-[7px] cursor-pointer group select-none transition-colors ${
                            isSelected
                              ? 'bg-ocean-softer'
                              : 'hover:bg-softer'
                          }`}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'copyMove';
                            e.dataTransfer.setData('application/x-table-id', String(table.id));
                            e.dataTransfer.setData('application/x-conn-id',   String(conn.id));
                            e.dataTransfer.setData('text/plain', String(table.id));
                          }}
                          onClick={() => onSelectTable(conn.id, table.id)}
                        >
                          <TableIcon active={isSelected} />
                          <span className={`text-[13px] truncate flex-1 ${
                            isSelected ? 'text-ocean font-medium' : 'text-ink-3 group-hover:text-ink-2'
                          }`}>
                            {table.display_name || table.table_name}
                          </span>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {table.ai_draft && (
                              <span className="orb-draft" title="AI Suggested" />
                            )}
                            {!table.is_active && (
                              <span className="text-[9px] px-1.5 py-0.5 bg-softer text-muted-2 border border-line rounded font-mono tracking-[0.06em] uppercase">off</span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* ── Data Products ── */}
        {hasProducts && (
          <>
            <div className="px-4 pt-5 pb-2 flex-shrink-0">
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">
                Organized data
              </p>
            </div>

            {/* ── Shared Dimensions ── */}
            {sharedDimensions.length > 0 && (
              <>
                <div className="px-4 pt-1 pb-2 flex-shrink-0">
                  <button
                    onClick={() => toggleSection('dims')}
                    className="flex items-center gap-2 w-full text-left group"
                  >
                    <ChevronIcon expanded={expandedSections.has('dims')} />
                    <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-ai">
                      Reference tables
                    </p>
                    <span className="text-[10px] font-mono text-muted-2 ml-auto tabular-nums">{sharedDimensions.length}</span>
                  </button>
                </div>

                {expandedSections.has('dims') && (
                  <div className="ml-5 border-l border-line">
                    {sharedDimensions.map((dim) => {
                      const isSelected = selectedProductTableId === dim.bestTable.id;
                      return (
                        <div
                          key={dim.tableName}
                          className={`flex items-center gap-2 pl-4 pr-3 py-[7px] cursor-pointer group select-none transition-colors ${
                            isSelected
                              ? 'bg-ai-soft'
                              : 'hover:bg-softer'
                          }`}
                          onClick={() => onSelectProductTable?.(dim.bestProductId, dim.bestTable.id)}
                        >
                          <TableIcon active={isSelected} />
                          <span className={`text-[13px] truncate flex-1 ${
                            isSelected ? 'text-ai font-medium' : 'text-ink-3 group-hover:text-ink-2'
                          }`}>
                            {dim.bestTable.display_name || dim.tableName}
                          </span>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {dim.usedByProducts.length > 1 && (
                              <span className="text-[9px] px-1.5 py-0.5 bg-ocean-softer text-ocean border border-line rounded font-mono tabular-nums" title={`Used in: ${dim.usedByProducts.join(', ')}`}>
                                {dim.usedByProducts.length}x
                              </span>
                            )}
                            {dim.bestTable.ai_draft && (
                              <span className="orb-draft" title="AI Suggested" />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* ── Fact Tables (grouped by product) ── */}
            {factsByProduct.length > 0 && (
              <>
                <div className="px-4 pt-4 pb-2 flex-shrink-0">
                  <button
                    onClick={() => toggleSection('facts')}
                    className="flex items-center gap-2 w-full text-left group"
                  >
                    <ChevronIcon expanded={expandedSections.has('facts')} />
                    <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-ocean">
                      Transaction tables
                    </p>
                    <span className="text-[10px] font-mono text-muted-2 ml-auto tabular-nums">
                      {factsByProduct.reduce((n, g) => n + g.tables.length, 0)}
                    </span>
                  </button>
                </div>

                {expandedSections.has('facts') && (
                  <div className="ml-5 border-l border-line">
                    {factsByProduct.map((group) => (
                      <div key={group.product.productId}>
                        <div className="pl-4 pr-3 pt-3 pb-1">
                          <span className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted-2">
                            {group.product.productName}
                          </span>
                        </div>
                        {group.tables.map((table) => {
                          const isSelected = selectedProductTableId === table.id;
                          return (
                            <div
                              key={table.id}
                              className={`flex items-center gap-2 pl-4 pr-3 py-[7px] cursor-pointer group select-none transition-colors ${
                                isSelected
                                  ? 'bg-ocean-softer'
                                  : 'hover:bg-softer'
                              }`}
                              onClick={() => onSelectProductTable?.(group.product.productId, table.id)}
                            >
                              <TableIcon active={isSelected} />
                              <span className={`text-[13px] truncate flex-1 ${
                                isSelected ? 'text-ocean font-medium' : 'text-ink-3 group-hover:text-ink-2'
                              }`}>
                                {table.display_name || table.table_name}
                              </span>
                              {table.ai_draft && (
                                <span className="orb-draft" title="AI Suggested" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
