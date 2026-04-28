'use client';

import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';

/* ── Types ────────────────────────────────────────────────────────────── */
interface Column {
  id: number;
  name: string;
  dataType: string;
  displayName: string;
  description: string | null;
  // source columns
  isDimension?: boolean;
  isMeasure?: boolean;
  // product columns
  role?: string;
  fkTarget?: string | null;
}

interface Table {
  id: number;
  name: string;
  displayName: string;
  description: string | null;
  role?: string; // fact | dimension (product tables only)
  columns: Column[];
}

interface Namespace {
  type: 'source' | 'product';
  name: string;
  id: string;
  description?: string;
  tables: Table[];
}

interface SchemaData {
  connectionName: string;
  namespaces: Namespace[];
}

interface SchemaExplorerProps {
  connectionId: number | null;
  /** Filter: 'sources' shows only source namespaces, 'products' shows only product namespaces */
  scope?: 'sources' | 'products';
  /** Called when user clicks a table or column name — inserts into editor */
  onInsert?: (text: string) => void;
}

/* ── Data type abbreviations ──────────────────────────────────────────── */
function shortType(dt: string): string {
  if (!dt) return '?';
  const t = dt.toLowerCase();
  if (t.includes('int')) return 'int';
  if (t.includes('serial')) return 'serial';
  if (t.includes('float') || t.includes('double') || t.includes('real')) return 'float';
  if (t.includes('decimal') || t.includes('numeric')) return 'dec';
  if (t.includes('bool')) return 'bool';
  if (t.includes('date') && !t.includes('time')) return 'date';
  if (t.includes('timestamp')) return 'ts';
  if (t.includes('time')) return 'time';
  if (t.includes('text') || t.includes('char') || t.includes('string')) return 'str';
  if (t.includes('json')) return 'json';
  if (t.includes('uuid')) return 'uuid';
  if (t.includes('blob') || t.includes('byte')) return 'bin';
  return dt.slice(0, 6);
}

function typeColor(dt: string): string {
  const t = dt.toLowerCase();
  if (t.includes('int') || t.includes('serial') || t.includes('float') || t.includes('double') || t.includes('decimal') || t.includes('numeric') || t.includes('real'))
    return 'text-blue-500';
  if (t.includes('bool')) return 'text-amber-500';
  if (t.includes('date') || t.includes('time')) return 'text-emerald-500';
  if (t.includes('text') || t.includes('char') || t.includes('string') || t.includes('varchar'))
    return 'text-rose-400';
  return 'text-on-surface-variant/50';
}

/* ── Component ────────────────────────────────────────────────────────── */
export default function SchemaExplorer({ connectionId, scope, onInsert }: SchemaExplorerProps) {
  const [schema, setSchema] = useState<SchemaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedNs, setExpandedNs] = useState<Set<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/notebooks/schema/${connectionId}`);
      if (res.data.ok) {
        setSchema(res.data.data);
        // Auto-expand all namespaces
        const nsIds = new Set(res.data.data.namespaces.map((ns: Namespace) => ns.id));
        setExpandedNs(nsIds);
      }
    } catch {
      setError('Failed to load schema');
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { load(); }, [load]);

  const toggleNs = (id: string) => {
    setExpandedNs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleTable = (key: string) => {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const handleInsert = (text: string) => {
    onInsert?.(text);
  };

  // Filter by search
  const filterNs = (ns: Namespace): Namespace | null => {
    if (!search.trim()) return ns;
    const q = search.toLowerCase();
    const filteredTables = ns.tables
      .map((t) => {
        const tableMatch = t.name.toLowerCase().includes(q) || t.displayName.toLowerCase().includes(q);
        const filteredCols = t.columns.filter(
          (c) => c.name.toLowerCase().includes(q) || c.displayName.toLowerCase().includes(q)
        );
        if (tableMatch) return t; // show all columns if table matches
        if (filteredCols.length > 0) return { ...t, columns: filteredCols };
        return null;
      })
      .filter(Boolean) as Table[];

    if (filteredTables.length === 0 && !ns.name.toLowerCase().includes(q)) return null;
    return { ...ns, tables: filteredTables };
  };

  if (!connectionId) {
    return (
      <div className="p-4 text-center">
        <p className="text-label-sm text-on-surface-variant/50">Select a connection to browse schema</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center">
        <p className="text-label-sm text-error">{error}</p>
        <button onClick={load} className="text-label-sm text-primary mt-2 hover:underline">Retry</button>
      </div>
    );
  }

  if (!schema) return null;

  const scopedNamespaces = scope
    ? schema.namespaces.filter((ns) => scope === 'sources' ? ns.type === 'source' : ns.type === 'product')
    : schema.namespaces;
  const filteredNamespaces = scopedNamespaces.map(filterNs).filter(Boolean) as Namespace[];

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Search */}
      <div className="px-3 py-2 border-b border-outline-variant/10">
        <div className="relative">
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-on-surface-variant/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tables, columns..."
            className="w-full pl-7 pr-2 py-1.5 text-[12px] bg-surface-container-low text-on-surface rounded-lg border-none outline-none placeholder:text-on-surface-variant/40"
          />
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {filteredNamespaces.length === 0 && (
          <p className="text-[11px] text-on-surface-variant/50 text-center py-4">No matches</p>
        )}

        {filteredNamespaces.map((ns) => (
          <div key={ns.id}>
            {/* Namespace header */}
            <button
              onClick={() => toggleNs(ns.id)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-surface-container-low/50 transition-colors group"
            >
              <svg
                className={`w-3 h-3 text-on-surface-variant/50 transition-transform flex-shrink-0 ${expandedNs.has(ns.id) ? 'rotate-90' : ''}`}
                viewBox="0 0 24 24" fill="currentColor"
              >
                <path d="M8 5l8 7-8 7V5z" />
              </svg>
              {ns.type === 'source' ? (
                <svg className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              )}
              <span className="text-[12px] font-semibold text-on-surface truncate">{ns.name}</span>
              <span className="text-[10px] text-on-surface-variant/40 ml-auto flex-shrink-0">{ns.tables.length}</span>
            </button>

            {/* Tables */}
            {expandedNs.has(ns.id) && (
              <div className="ml-2">
                {ns.tables.map((table) => {
                  const tableKey = `${ns.id}:${table.id}`;
                  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
                  const qualifiedName = `${q(ns.name)}.${q(table.name)}`;
                  const isExpanded = expandedTables.has(tableKey);

                  return (
                    <div key={tableKey}>
                      {/* Table row */}
                      <div className="flex items-center group">
                        <button
                          onClick={() => toggleTable(tableKey)}
                          className="flex-1 flex items-center gap-1.5 pl-4 pr-2 py-[3px] text-left hover:bg-surface-container-low/50 transition-colors min-w-0"
                        >
                          <svg
                            className={`w-2.5 h-2.5 text-on-surface-variant/40 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                            viewBox="0 0 24 24" fill="currentColor"
                          >
                            <path d="M8 5l8 7-8 7V5z" />
                          </svg>
                          {table.role === 'fact' ? (
                            <span className="w-2 h-2 rounded-sm bg-orange-400 flex-shrink-0" title="Transaction table" />
                          ) : table.role === 'dimension' ? (
                            <span className="w-2 h-2 rounded-full bg-violet-400 flex-shrink-0" title="Reference table" />
                          ) : (
                            <span className="w-2 h-2 rounded-sm bg-slate-300 flex-shrink-0" />
                          )}
                          <span className="text-[11px] text-on-surface truncate font-mono">{table.name}</span>
                          <span className="text-[9px] text-on-surface-variant/30 ml-auto flex-shrink-0">{table.columns.length}</span>
                        </button>
                        {/* Insert button */}
                        <button
                          onClick={() => handleInsert(qualifiedName)}
                          className="opacity-0 group-hover:opacity-100 p-0.5 mr-1 rounded hover:bg-primary/10 text-primary transition-all flex-shrink-0"
                          title={`Insert ${table.name}`}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                        </button>
                      </div>

                      {/* Columns */}
                      {isExpanded && (
                        <div className="ml-6">
                          {table.columns.map((col) => (
                            <div
                              key={col.id}
                              className="flex items-center gap-1.5 pl-4 pr-2 py-[2px] group/col hover:bg-surface-container-low/30 transition-colors cursor-pointer"
                              onClick={() => handleInsert(`"${col.name.replace(/"/g, '""')}"`)}
                              title={col.description || `${col.displayName} (${col.dataType})`}
                            >
                              {/* Column role indicator */}
                              {col.isDimension || col.role === 'business_key' || col.role === 'foreign_key' ? (
                                <svg className="w-2.5 h-2.5 text-violet-400 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                                </svg>
                              ) : col.isMeasure || col.role === 'measure' ? (
                                <svg className="w-2.5 h-2.5 text-emerald-400 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                                  <rect x="4" y="14" width="4" height="6" rx="0.5" /><rect x="10" y="8" width="4" height="12" rx="0.5" /><rect x="16" y="4" width="4" height="16" rx="0.5" />
                                </svg>
                              ) : col.fkTarget ? (
                                <svg className="w-2.5 h-2.5 text-blue-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                </svg>
                              ) : (
                                <span className="w-2.5 h-2.5 flex-shrink-0" />
                              )}
                              <span className="text-[11px] text-on-surface/80 font-mono truncate">{col.name}</span>
                              <span className={`text-[9px] font-mono ml-auto flex-shrink-0 ${typeColor(col.dataType)}`}>
                                {shortType(col.dataType)}
                              </span>
                              {/* Insert indicator on hover */}
                              <svg className="w-2.5 h-2.5 text-primary opacity-0 group-hover/col:opacity-60 flex-shrink-0 transition-opacity" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                <path d="M12 5v14M5 12h14" />
                              </svg>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="px-3 py-2 border-t border-outline-variant/10 flex flex-wrap gap-x-3 gap-y-1">
        <span className="flex items-center gap-1 text-[9px] text-on-surface-variant/50">
          <span className="w-2 h-2 rounded-sm bg-orange-400" /> fact
        </span>
        <span className="flex items-center gap-1 text-[9px] text-on-surface-variant/50">
          <span className="w-2 h-2 rounded-full bg-violet-400" /> dim
        </span>
        <span className="flex items-center gap-1 text-[9px] text-on-surface-variant/50">
          <svg className="w-2.5 h-2.5 text-violet-400" viewBox="0 0 24 24" fill="currentColor"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg> key
        </span>
        <span className="flex items-center gap-1 text-[9px] text-on-surface-variant/50">
          <svg className="w-2.5 h-2.5 text-emerald-400" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="14" width="4" height="6" rx="0.5" /><rect x="10" y="8" width="4" height="12" rx="0.5" /><rect x="16" y="4" width="4" height="16" rx="0.5" /></svg> measure
        </span>
      </div>
    </div>
  );
}
