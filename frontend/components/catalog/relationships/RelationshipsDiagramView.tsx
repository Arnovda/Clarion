'use client';

/**
 * <RelationshipsDiagramView> — diagram tab for the source root.
 *
 * Layout:
 *   ┌─────────────┬───────────────────────────────────────────┐
 *   │ Tables rail │             RelationshipCanvas            │
 *   │             │                                            │
 *   │ All tables  │   (filtered to focused table + its         │
 *   │ Accounts    │    direct neighbours when focus is set)   │
 *   │ Sales Inv…  │                                            │
 *   │ ...         │                                            │
 *   └─────────────┴───────────────────────────────────────────┘
 *
 * Why filter before passing in: the underlying canvas runs dagre on whatever
 * tables it's given. By passing fewer tables when the user focuses on one,
 * the layout stays tight and readable instead of fitView shrinking the view
 * to fit a 5-table-wide canvas.
 */

import { useEffect, useMemo, useState } from 'react';
import { Database, Eye, Filter, GitBranch, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import RelationshipCanvas from '@/components/semantic/RelationshipCanvas';
import FocusedClusterView from './FocusedClusterView';
import type { SourceTable, SourceColumn } from '@/components/semantic/types';
import type { RelationshipRow } from './useSchema';
import { cn } from '@/lib/cn';

interface Props {
  connectionId:   number;
  tables:         SourceTable[];
  columnsByTable: Record<number, SourceColumn[]>;
  relationships:  RelationshipRow[];
  /** Top-bar search; matching tables are highlighted in the rail. */
  search:         string;
}

export default function RelationshipsDiagramView({
  connectionId, tables, columnsByTable, relationships, search,
}: Props) {
  // null = "all tables" (full schema). A number = focused table id.
  const [focusedId, setFocusedId] = useState<number | null>(null);
  // Rail collapsed (icons-only) vs expanded. Persists per-session.
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return window.localStorage.getItem('catalog:diagram:rail') === 'collapsed'; }
    catch { return false; }
  });
  const toggleRail = () => {
    setRailCollapsed((v) => {
      const next = !v;
      try { window.localStorage.setItem('catalog:diagram:rail', next ? 'collapsed' : 'expanded'); }
      catch { /* ignore */ }
      return next;
    });
  };

  // Per-table relationship counts for the rail labels.
  const relCountsByTable = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of tables) m.set(t.id, 0);
    for (const r of relationships) {
      m.set(r.from_table_id, (m.get(r.from_table_id) ?? 0) + 1);
      m.set(r.to_table_id,   (m.get(r.to_table_id)   ?? 0) + 1);
    }
    return m;
  }, [tables, relationships]);

  // Sorted by relationship count desc, then by display name (most-connected first).
  const sortedTables = useMemo(() => {
    return tables.slice().sort((a, b) => {
      const ra = relCountsByTable.get(a.id) ?? 0;
      const rb = relCountsByTable.get(b.id) ?? 0;
      if (rb !== ra) return rb - ra;
      return a.display_name.localeCompare(b.display_name);
    });
  }, [tables, relCountsByTable]);

  // Search filters which rail rows are visible.
  const railRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedTables;
    return sortedTables.filter(
      (t) =>
        t.display_name.toLowerCase().includes(q) ||
        t.table_name.toLowerCase().includes(q),
    );
  }, [sortedTables, search]);

  // Search-to-zoom: when the search matches exactly one table, jump the
  // canvas to focus on it. When the search is cleared, reset back to the
  // whole schema. We DON'T fight the user's manual focus picks though —
  // only auto-focus / auto-clear in response to search changes.
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setFocusedId((current) => (current === null ? current : null));
      return;
    }
    if (railRows.length === 1) {
      const onlyMatch = railRows[0].id;
      setFocusedId((current) => (current === onlyMatch ? current : onlyMatch));
    }
  }, [search, railRows]);

  // Compute which tables are visible in the canvas based on focus.
  // null = all tables; a focused id = that table + every table directly related to it.
  const visibleTableIds = useMemo<Set<number>>(() => {
    if (focusedId === null) {
      return new Set(tables.map((t) => t.id));
    }
    const ids = new Set<number>([focusedId]);
    for (const r of relationships) {
      if (r.from_table_id === focusedId) ids.add(r.to_table_id);
      if (r.to_table_id   === focusedId) ids.add(r.from_table_id);
    }
    return ids;
  }, [focusedId, tables, relationships]);

  const focusedTable = focusedId != null ? tables.find((t) => t.id === focusedId) : null;

  // Tables for the focused-cluster view: only the neighbours (focused passed
  // separately).
  const neighbourTables = useMemo(() => {
    if (focusedId === null) return [];
    return tables.filter((t) => t.id !== focusedId && visibleTableIds.has(t.id));
  }, [focusedId, tables, visibleTableIds]);

  const neighbourCount = neighbourTables.length;

  // Relationships that touch the focused table (these are the only ones we
  // want to draw in focus mode).
  const focusedRelationships = useMemo(() => {
    if (focusedId === null) return [];
    return relationships.filter(
      (r) => r.from_table_id === focusedId || r.to_table_id === focusedId,
    );
  }, [focusedId, relationships]);

  // Whole-schema view receives every table (focus mode uses a different
  // component entirely).
  const filteredTables = focusedId === null ? tables : [];
  const filteredColumns = columnsByTable;

  return (
    <div className="flex-1 min-h-0 flex">
      {/* ── Left rail: table list (collapsible) ─────────────────────────── */}
      <aside
        className={cn(
          'border-r border-line bg-raised flex flex-col transition-all duration-200',
          railCollapsed ? 'w-[44px]' : 'w-[260px]',
        )}
      >
        {/* Header row: collapse toggle + (when expanded) the "Whole schema" entry */}
        <div className={cn(
          'border-b border-line flex items-center',
          railCollapsed ? 'flex-col p-1.5 gap-1' : 'px-3 py-3 gap-2',
        )}>
          {!railCollapsed && (
            <button
              type="button"
              onClick={() => setFocusedId(null)}
              className={cn(
                'flex-1 text-left px-3 py-2 rounded-md text-[12.5px] flex items-center gap-2 transition',
                focusedId === null
                  ? 'bg-ocean-softer border border-ocean-soft text-ocean'
                  : 'border border-transparent text-ink-2 hover:bg-softer',
              )}
            >
              <GitBranch className="w-3.5 h-3.5 flex-shrink-0" strokeWidth={2} />
              <span className="font-mono uppercase tracking-[0.06em] text-[11px]">
                Whole schema
              </span>
              <span className="ml-auto text-[10px] font-mono text-muted-2">
                {tables.length}
              </span>
            </button>
          )}
          {railCollapsed && (
            <button
              type="button"
              onClick={() => setFocusedId(null)}
              title="Whole schema"
              className={cn(
                'inline-flex items-center justify-center w-8 h-8 rounded-md transition',
                focusedId === null
                  ? 'bg-ocean-softer text-ocean border border-ocean-soft'
                  : 'text-muted-2 hover:text-ink hover:bg-softer',
              )}
            >
              <GitBranch className="w-3.5 h-3.5" strokeWidth={2} />
            </button>
          )}
          <button
            type="button"
            onClick={toggleRail}
            title={railCollapsed ? 'Expand table list' : 'Collapse table list'}
            aria-label={railCollapsed ? 'Expand table list' : 'Collapse table list'}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-2 hover:text-ink hover:bg-softer transition"
          >
            {railCollapsed
              ? <PanelLeftOpen  className="w-3.5 h-3.5" strokeWidth={2} />
              : <PanelLeftClose className="w-3.5 h-3.5" strokeWidth={2} />}
          </button>
        </div>

        {!railCollapsed && (
          <div className="px-3 py-2 text-[10px] font-mono uppercase tracking-[0.12em] text-muted">
            Focus on a table
          </div>
        )}

        <div className={cn('flex-1 overflow-y-auto', railCollapsed ? 'px-1 py-2' : 'px-2 pb-3')}>
          {railRows.length === 0 ? (
            !railCollapsed && (
              <p className="px-3 py-6 text-[11px] text-muted text-center">No tables match.</p>
            )
          ) : (
            <ul className={cn(railCollapsed ? 'space-y-1' : 'space-y-0.5')}>
              {railRows.map((t) => {
                const isFocused = focusedId === t.id;
                const relCount = relCountsByTable.get(t.id) ?? 0;
                if (railCollapsed) {
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => setFocusedId(isFocused ? null : t.id)}
                        title={`${t.display_name}\n${relCount === 0 ? 'no relationships' : `${relCount} relationship${relCount === 1 ? '' : 's'}`}`}
                        className={cn(
                          'relative inline-flex items-center justify-center w-full h-8 rounded-md transition',
                          isFocused
                            ? 'bg-ocean-softer text-ocean border border-ocean-soft'
                            : 'text-muted-2 hover:text-ink hover:bg-softer',
                        )}
                      >
                        <Database className="w-3.5 h-3.5" strokeWidth={1.8} />
                        {relCount > 0 && (
                          <span
                            className={cn(
                              'absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-mono flex items-center justify-center',
                              isFocused ? 'bg-ocean text-white' : 'bg-softer border border-line text-muted',
                            )}
                          >
                            {relCount}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                }
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setFocusedId(isFocused ? null : t.id)}
                      title={t.table_name}
                      className={cn(
                        'w-full text-left px-3 py-1.5 rounded-md text-[12.5px] flex items-center gap-2 group transition',
                        isFocused
                          ? 'bg-ocean-softer border border-ocean-soft text-ocean'
                          : 'border border-transparent text-ink-2 hover:bg-softer',
                      )}
                    >
                      <Database
                        className={cn(
                          'w-3.5 h-3.5 flex-shrink-0',
                          isFocused ? 'text-ocean' : 'text-muted-2',
                        )}
                        strokeWidth={1.8}
                      />
                      <span className="truncate">{t.display_name}</span>
                      <span className={cn(
                        'ml-auto text-[10px] font-mono',
                        relCount === 0 ? 'text-muted-2' : 'text-muted',
                      )}>
                        {relCount === 0 ? '–' : relCount}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* ── Right: canvas with focus banner ──────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col bg-bg">
        {focusedTable && (
          <div className="px-4 py-2 border-b border-line bg-ocean-softer flex items-center gap-3">
            <Filter className="w-3.5 h-3.5 text-ocean flex-shrink-0" strokeWidth={2} />
            <span className="text-[12.5px] text-ink">
              Focused on <span className="font-medium">{focusedTable.display_name}</span>
              {neighbourCount > 0
                ? <> and {neighbourCount} related {neighbourCount === 1 ? 'table' : 'tables'}</>
                : <span className="text-muted"> — no related tables</span>}
            </span>
            <button
              onClick={() => setFocusedId(null)}
              className="ml-auto inline-flex items-center gap-1 text-[11px] font-mono uppercase tracking-[0.06em] text-ocean hover:text-ocean-hover"
            >
              <Eye className="w-3 h-3" strokeWidth={2.5} />
              Show whole schema
            </button>
          </div>
        )}

        {focusedTable ? (
          // Dedicated, simple cluster view: focused at centre, neighbours
          // around it. Bypasses RelationshipCanvas entirely so the focus
          // experience isn't tangled in that 2k-line component's whole-
          // schema state machine.
          <FocusedClusterView
            key={focusedTable.id}
            focused={focusedTable}
            neighbours={neighbourTables}
            relationships={focusedRelationships}
            columnsByTable={filteredColumns}
          />
        ) : filteredTables.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-center px-6 py-16">
            <p className="text-[13px] text-muted">No tables to show.</p>
          </div>
        ) : (
          <RelationshipCanvas
            // Whole-schema mode keeps the existing canvas (search, dagre,
            // draft review, drag-to-add — none of which apply in focus mode).
            key="all"
            connectionId={String(connectionId)}
            tables={filteredTables}
            columnsByTable={filteredColumns}
            hideSidebar
          />
        )}
      </div>
    </div>
  );
}
