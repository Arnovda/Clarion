'use client';

import { useState } from 'react';
import { SourceTable, SourceColumn } from './types';

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
}

const DbIcon = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <ellipse cx="12" cy="6" rx="8" ry="3" strokeWidth={2} />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6v6c0 1.657 3.582 3 8 3s8-1.343 8-3V6" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 12v6c0 1.657 3.582 3 8 3s8-1.343 8-3v-6" />
  </svg>
);

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
  </svg>
);

const TableIcon = ({ active }: { active: boolean }) => (
  <svg className={`w-3.5 h-3.5 flex-shrink-0 ${active ? 'text-blue-500' : 'text-slate-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M3 10h18M3 14h18M10 4v16M3 4h18a1 1 0 011 1v14a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1z" />
  </svg>
);

export default function DatabaseTree({
  connections, tablesByConnection, columnsByTable,
  expandedConnectionIds, loadingConnectionIds,
  activeConnectionId,
  selectedTableId, selectedColumnId,
  onToggleConnection, onSelectTable, onSelectColumn,
}: Props) {
  const [expandedTables, setExpandedTables] = useState<Set<number>>(new Set());

  function toggleTable(id: number) {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 pt-3 pb-1 flex-shrink-0">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-1.5">
          Data sources
        </p>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {connections.map((conn) => {
          const isConnExpanded = expandedConnectionIds.has(conn.id);
          const isLoading      = loadingConnectionIds.has(conn.id);
          const tables         = tablesByConnection[conn.id] ?? [];

          return (
            <div key={conn.id}>
              {/* ── Connection header ── */}
              <button
                onClick={() => onToggleConnection(conn.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 transition-colors group select-none ${
                  activeConnectionId === conn.id ? 'bg-blue-50' : 'hover:bg-slate-50'
                }`}
              >
                <ChevronIcon expanded={isConnExpanded} />
                <DbIcon className={`w-4 h-4 flex-shrink-0 ${activeConnectionId === conn.id ? 'text-blue-600' : 'text-blue-400'}`} />
                <span className={`text-sm font-semibold truncate flex-1 text-left ${
                  activeConnectionId === conn.id ? 'text-blue-700' : 'text-slate-700'
                }`}>
                  {conn.name}
                </span>
                {isLoading && (
                  <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                )}
                {!isLoading && isConnExpanded && tables.length === 0 && (
                  <span className="text-[9px] text-slate-400 flex-shrink-0">no tables</span>
                )}
                {!isLoading && tables.length > 0 && (
                  <span className="text-[10px] text-slate-400 flex-shrink-0">{tables.length}</span>
                )}
              </button>

              {/* ── Tables under this connection ── */}
              {isConnExpanded && !isLoading && (
                <div className="border-l-2 border-slate-100 ml-4">
                  {tables.length === 0 ? (
                    <p className="pl-4 py-2 text-xs text-slate-400 italic">
                      No tables found. Try Re-analyse in Sources.
                    </p>
                  ) : (
                    tables.map((table) => {
                      const isTableExpanded = expandedTables.has(table.id);
                      const isSelected      = selectedTableId === table.id;
                      const cols            = columnsByTable[table.id] ?? [];
                      const confirmedPct    = cols.length
                        ? Math.round((cols.filter((c) => !c.ai_draft).length / cols.length) * 100)
                        : null;

                      return (
                        <div key={table.id}>
                          {/* ── Table row ── */}
                          <div
                            className={`flex items-center gap-1 pl-2 pr-2 py-1.5 cursor-grab group select-none ${
                              isSelected && !selectedColumnId ? 'bg-blue-50' : 'hover:bg-slate-50'
                            }`}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.effectAllowed = 'copy';
                              e.dataTransfer.setData('application/x-table-id', String(table.id));
                              e.dataTransfer.setData('application/x-conn-id',   String(conn.id));
                            }}
                          >
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleTable(table.id); }}
                              className="p-0.5 rounded text-slate-300 hover:text-slate-500 flex-shrink-0"
                            >
                              <ChevronIcon expanded={isTableExpanded} />
                            </button>

                            <div
                              className="flex items-center gap-1.5 flex-1 min-w-0"
                              onClick={() => { onSelectTable(conn.id, table.id); if (!isTableExpanded) toggleTable(table.id); }}
                            >
                              <TableIcon active={isSelected && !selectedColumnId} />
                              <span className={`text-sm truncate flex-1 ${
                                isSelected && !selectedColumnId ? 'text-blue-700 font-semibold' : 'text-slate-700 font-medium'
                              }`}>
                                {table.display_name || table.table_name}
                              </span>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                {table.ai_draft && (
                                  <span className="text-[9px] px-1 py-0 bg-amber-100 text-amber-600 rounded font-medium">draft</span>
                                )}
                                {!table.is_active && (
                                  <span className="text-[9px] px-1 py-0 bg-slate-100 text-slate-400 rounded font-medium">off</span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* ── Columns ── */}
                          {isTableExpanded && (
                            <div className="border-l-2 border-slate-100 ml-5">
                              {cols.length === 0 && (
                                <p className="pl-4 py-1 text-xs text-slate-300 italic">No columns</p>
                              )}
                              {cols.map((col) => {
                                const isColSelected = selectedColumnId === col.id;
                                const dotColor = col.is_dimension
                                  ? 'bg-purple-400'
                                  : col.is_measure
                                  ? 'bg-green-400'
                                  : 'bg-slate-300';

                                return (
                                  <div
                                    key={col.id}
                                    onClick={() => onSelectColumn(table.id, col.id)}
                                    className={`flex items-center gap-2 pl-3 pr-2 py-1 cursor-pointer text-xs transition-colors ${
                                      isColSelected ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                                    }`}
                                  >
                                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
                                    <span className={`truncate flex-1 ${isColSelected ? 'font-medium' : ''}`}>
                                      {col.display_name || col.column_name}
                                    </span>
                                    <span className="text-[10px] text-slate-300 flex-shrink-0 font-mono">
                                      {col.data_type?.toLowerCase().replace('integer', 'int')}
                                    </span>
                                    {col.ai_draft && (
                                      <span className="w-1.5 h-1.5 rounded-full bg-amber-300 flex-shrink-0" title="AI draft" />
                                    )}
                                  </div>
                                );
                              })}

                              {cols.length > 0 && confirmedPct !== null && (
                                <div className="px-3 py-1.5 border-t border-slate-50">
                                  <div className="flex items-center justify-between mb-0.5">
                                    <span className="text-[9px] text-slate-400">Confirmed</span>
                                    <span className="text-[9px] text-slate-400">{confirmedPct}%</span>
                                  </div>
                                  <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
                                    <div className="h-full bg-green-400 rounded-full transition-all" style={{ width: `${confirmedPct}%` }} />
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex-shrink-0 px-3 py-2 border-t border-slate-100 flex items-center gap-3">
        <span className="flex items-center gap-1 text-[10px] text-slate-400"><span className="w-1.5 h-1.5 rounded-full bg-purple-400" /> Dim</span>
        <span className="flex items-center gap-1 text-[10px] text-slate-400"><span className="w-1.5 h-1.5 rounded-full bg-green-400" /> Meas</span>
        <span className="flex items-center gap-1 text-[10px] text-slate-400"><span className="w-1.5 h-1.5 rounded-full bg-amber-300" /> Draft</span>
      </div>
    </div>
  );
}
