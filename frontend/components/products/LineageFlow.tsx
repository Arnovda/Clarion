'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  Node, NodeProps,
  Handle, Position,
  EdgeProps, getBezierPath, EdgeLabelRenderer,
  ReactFlowProvider, ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const HEADER_H = 44;
const ROW_H    = 24;
const SRC_W    = 260;
const PROD_W   = 300;
const GAP_X    = 340;
const GAP_Y    = 20;

const hR = (id: string) => `R_${id}`;
const hL = (id: string) => `L_${id}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface LineageColumn {
  id: number;
  column_name: string;
  data_type: string | null;
  column_role: string | null;
  lineage?: { source_table_name: string; source_column_name: string; transformation_description: string }[];
}

export interface LineageTable {
  id: number;
  table_name: string;
  display_name: string | null;
  table_role: string;
  columns: LineageColumn[];
}

export interface LineageData {
  tables: LineageTable[];
}

// ---------------------------------------------------------------------------
// Source table node
// ---------------------------------------------------------------------------
interface SrcNodeData {
  tableName: string;
  columns: string[];
  focused: boolean;
  highlighted: boolean;
  dimmed: boolean;
  highlightedCols: Set<string>;
  showColumns: boolean;
}

const HANDLE_STYLE = {
  width: 7, height: 7,
  border: '2px solid white',
  borderRadius: '50%',
  zIndex: 20,
};

function SourceNode({ data }: NodeProps<SrcNodeData>) {
  const { tableName, columns, focused, highlighted, dimmed, highlightedCols, showColumns } = data;
  const visibleH = showColumns ? HEADER_H + columns.length * ROW_H : HEADER_H;
  const opacity = dimmed ? 0.2 : 1;
  const borderColor = focused ? '#334155' : highlighted ? '#94a3b8' : '#e2e8f0';

  return (
    <div style={{ position: 'relative', width: SRC_W, height: visibleH, opacity, transition: 'opacity 0.2s, height 0.3s ease' }}>
      {/* Table-level handle (always present, at header center-right) */}
      <Handle type="source" position={Position.Right} id={hR(`table:${tableName}`)}
        style={{ ...HANDLE_STYLE, background: highlighted ? '#3b82f6' : '#94a3b8', position: 'absolute', top: HEADER_H / 2, right: -4, transform: 'translateY(-50%)' }} />
      {/* Column-level handles (only when expanded) */}
      {showColumns && columns.map((col, i) => {
        const top = HEADER_H + i * ROW_H + ROW_H / 2;
        const isHl = highlightedCols.has(col);
        return (
          <Fragment key={col}>
            <Handle type="source" position={Position.Right} id={hR(`${tableName}.${col}`)}
              style={{ ...HANDLE_STYLE, background: isHl ? '#3b82f6' : '#94a3b8', position: 'absolute', top, right: -4, transform: 'translateY(-50%)' }} />
          </Fragment>
        );
      })}
      <div style={{
        position: 'absolute', inset: 0, border: `2px solid ${borderColor}`, borderRadius: 10,
        overflow: 'hidden', background: '#fff',
        boxShadow: focused ? '0 0 0 3px #cbd5e1, 0 4px 16px rgba(0,0,0,.12)' : '0 2px 6px rgba(0,0,0,.05)',
      }}>
        <div style={{
          height: HEADER_H, background: focused ? '#334155' : '#475569',
          padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <p style={{ margin: 0, color: '#fff', fontSize: 12, fontWeight: 700,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{tableName}</p>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.6)', flexShrink: 0 }}>{columns.length} cols</span>
        </div>
        {showColumns && columns.map((col, i) => {
          const isHl = highlightedCols.has(col);
          return (
            <div key={col} style={{
              height: ROW_H, display: 'flex', alignItems: 'center', gap: 5, padding: '0 10px',
              background: isHl ? '#dbeafe' : i % 2 === 0 ? '#fff' : '#f8fafc',
              borderTop: '1px solid #f1f5f9',
              borderLeft: isHl ? '3px solid #3b82f6' : '3px solid transparent',
            }}>
              <span style={{ fontSize: 11, color: isHl ? '#1d4ed8' : '#334155',
                fontWeight: isHl ? 700 : 500, flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{col}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Product table node
// ---------------------------------------------------------------------------
interface ProdNodeData {
  tableName: string;
  tableRole: string;
  columns: { name: string; role: string | null }[];
  focused: boolean;
  highlighted: boolean;
  dimmed: boolean;
  highlightedCols: Set<string>;
  showColumns: boolean;
}

function ColRoleBadge({ role }: { role: string | null }) {
  if (!role) return null;
  const m: Record<string, { bg: string; text: string; label: string }> = {
    surrogate_key: { bg: '#fef3c7', text: '#92400e', label: 'SK' },
    natural_key: { bg: '#dbeafe', text: '#1e40af', label: 'NK' },
    foreign_key: { bg: '#ede9fe', text: '#6d28d9', label: 'FK' },
    degenerate_dimension: { bg: '#fce7f3', text: '#9d174d', label: 'DD' },
    measure: { bg: '#d1fae5', text: '#065f46', label: 'M' },
    attribute: { bg: '#f1f5f9', text: '#475569', label: 'attr' },
  };
  const s = m[role];
  if (!s) return null;
  return (
    <span style={{ fontSize: 8, fontWeight: 700, padding: '1px 4px', borderRadius: 4,
      background: s.bg, color: s.text, flexShrink: 0, lineHeight: '14px' }}>{s.label}</span>
  );
}

function ProductNode({ data }: NodeProps<ProdNodeData>) {
  const { tableName, tableRole, columns, focused, highlighted, dimmed, highlightedCols, showColumns } = data;
  const visibleH = showColumns ? HEADER_H + columns.length * ROW_H : HEADER_H;
  const opacity = dimmed ? 0.2 : 1;
  const isDim = tableRole !== 'fact';
  const headerBg = isDim ? (focused ? '#1e40af' : '#2563eb') : (focused ? '#6d28d9' : '#7c3aed');
  const borderColor = focused ? (isDim ? '#2563eb' : '#7c3aed') : highlighted ? (isDim ? '#93c5fd' : '#c4b5fd') : '#e2e8f0';

  return (
    <div style={{ position: 'relative', width: PROD_W, height: visibleH, opacity, transition: 'opacity 0.2s, height 0.3s ease' }}>
      {/* Table-level handle */}
      <Handle type="source" position={Position.Left} id={hL(`table:${tableName}`)}
        style={{ ...HANDLE_STYLE, background: highlighted ? '#3b82f6' : '#93c5fd', position: 'absolute', top: HEADER_H / 2, left: -4, transform: 'translateY(-50%)' }} />
      {/* Column-level handles (only when expanded) */}
      {showColumns && columns.map((col, i) => {
        const top = HEADER_H + i * ROW_H + ROW_H / 2;
        const isHl = highlightedCols.has(col.name);
        return (
          <Fragment key={col.name}>
            <Handle type="source" position={Position.Left} id={hL(`${tableName}.${col.name}`)}
              style={{ ...HANDLE_STYLE, background: isHl ? '#3b82f6' : '#93c5fd', position: 'absolute', top, left: -4, transform: 'translateY(-50%)' }} />
          </Fragment>
        );
      })}
      <div style={{
        position: 'absolute', inset: 0, border: `2px solid ${borderColor}`, borderRadius: 10,
        overflow: 'hidden', background: '#fff',
        boxShadow: focused ? `0 0 0 3px ${isDim ? '#bfdbfe' : '#ddd6fe'}, 0 4px 16px rgba(0,0,0,.12)` : '0 2px 6px rgba(0,0,0,.05)',
      }}>
        <div style={{
          height: HEADER_H, background: headerBg,
          padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 99,
            background: isDim ? 'rgba(147,197,253,0.3)' : 'rgba(196,181,253,0.3)', color: '#fff',
          }}>{isDim ? 'dim' : 'fact'}</span>
          <p style={{ margin: 0, color: '#fff', fontSize: 12, fontWeight: 700,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{tableName}</p>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.6)', flexShrink: 0 }}>{columns.length} cols</span>
        </div>
        {showColumns && columns.map((col, i) => {
          const isHl = highlightedCols.has(col.name);
          return (
            <div key={col.name} style={{
              height: ROW_H, display: 'flex', alignItems: 'center', gap: 5, padding: '0 10px',
              background: isHl ? '#dbeafe' : i % 2 === 0 ? '#fff' : '#f8fafc',
              borderTop: '1px solid #f1f5f9',
              borderLeft: isHl ? '3px solid #3b82f6' : '3px solid transparent',
            }}>
              <ColRoleBadge role={col.role} />
              <span style={{ fontSize: 11, color: isHl ? '#1d4ed8' : '#334155',
                fontWeight: isHl ? 700 : 500, flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{col.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lineage edge — bezier with optional transform tooltip
// ---------------------------------------------------------------------------
interface LineageEdgeData {
  transform: string;
  highlighted: boolean;
  dimmed: boolean;
  hovered: boolean;
  onHover: (id: string | null) => void;
  edgeId: string;
  fromLabel: string;
  toLabel: string;
}

function LineageEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data,
}: EdgeProps<LineageEdgeData>) {
  const isHighlighted = data?.highlighted ?? false;
  const isDimmed = data?.dimmed ?? false;
  const isHovered = data?.hovered ?? false;
  const active = isHighlighted || isHovered;
  const color = active ? '#3b82f6' : isDimmed ? '#e2e8f0' : '#94a3b8';
  const strokeW = active ? 2.5 : isDimmed ? 1 : 1.5;
  const opacity = isDimmed ? 0.15 : 1;
  const markerId = `arr-lin-${id}`;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    curvature: 0.25,
  });

  return (
    <g style={{ opacity, transition: 'opacity 0.2s' }}>
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
        </marker>
      </defs>
      <path d={edgePath} fill="none" stroke="white" strokeWidth={strokeW + 5} />
      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={16}
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => data?.onHover(data.edgeId)}
        onMouseLeave={() => data?.onHover(null)}
      />
      <path id={id} className="react-flow__edge-path" d={edgePath}
        fill="none" stroke={color} strokeWidth={strokeW}
        markerEnd={`url(#${markerId})`}
        style={{ cursor: 'pointer', transition: 'stroke 0.15s' }}
        onMouseEnter={() => data?.onHover(data.edgeId)}
        onMouseLeave={() => data?.onHover(null)}
      />
      <EdgeLabelRenderer>
        {isHovered && data?.transform && (
          <div className="nodrag nopan" style={{
            position: 'absolute', pointerEvents: 'none',
            transform: `translate(-50%, -100%) translate(${labelX}px,${labelY - 10}px)`,
            zIndex: 9999,
          }}>
            <div style={{
              background: '#1e293b', color: '#f1f5f9', borderRadius: 8,
              padding: '6px 10px', maxWidth: 300,
              boxShadow: '0 4px 16px rgba(0,0,0,.25)', fontSize: 10, lineHeight: 1.4,
            }}>
              <div style={{ color: '#94a3b8', fontSize: 9, marginBottom: 3 }}>
                {data.fromLabel} &#8594; {data.toLabel}
              </div>
              <div style={{ color: '#e2e8f0', fontStyle: 'italic' }}>{data.transform}</div>
              <div style={{
                position: 'absolute', bottom: -5, left: '50%', transform: 'translateX(-50%)',
                width: 0, height: 0,
                borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                borderTop: '5px solid #1e293b',
              }} />
            </div>
          </div>
        )}
        {active && !isHovered && (
          <div className="nodrag nopan" style={{
            position: 'absolute', pointerEvents: 'none',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
          }}>
            <span style={{
              fontSize: 9, fontWeight: 600, color: '#fff',
              background: '#3b82f6', padding: '2px 6px', borderRadius: 99,
              boxShadow: '0 1px 3px rgba(0,0,0,.15)',
            }}>&#8594;</span>
          </div>
        )}
      </EdgeLabelRenderer>
    </g>
  );
}

const nodeTypes = { srcNode: SourceNode, prodNode: ProductNode };
const edgeTypes = { lineageEdge: LineageEdge };

// ---------------------------------------------------------------------------
// Inner component
// ---------------------------------------------------------------------------
function LineageFlowInner({ data }: { data: LineageData }) {
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

  // Extract all columns with lineage
  const columnsWithLineage = useMemo(() =>
    data.tables.flatMap((t) =>
      t.columns
        .filter((c) => c.lineage && c.lineage.length > 0)
        .map((c) => ({ ...c, tableName: t.table_name, tableRole: t.table_role })),
    ), [data]);

  // Source table -> columns map
  const sourceTableMap = useMemo(() => {
    const m = new Map<string, Set<string>>();
    columnsWithLineage.forEach((c) =>
      c.lineage!.forEach((l) => {
        if (!m.has(l.source_table_name)) m.set(l.source_table_name, new Set());
        m.get(l.source_table_name)!.add(l.source_column_name);
      }),
    );
    return m;
  }, [columnsWithLineage]);

  const sourceTables = useMemo(() =>
    Array.from(sourceTableMap.entries()).sort(([a], [b]) => a.localeCompare(b)),
  [sourceTableMap]);

  // Product tables that have lineage columns
  const productTables = useMemo(() => {
    const seen = new Set<string>();
    return data.tables.filter((t) => {
      const hasLineage = t.columns.some((c) => c.lineage && c.lineage.length > 0);
      if (hasLineage && !seen.has(t.table_name)) { seen.add(t.table_name); return true; }
      return false;
    });
  }, [data]);

  // Which source tables feed which product tables
  const srcToProdTables = useMemo(() => {
    const m = new Map<string, Set<string>>();
    columnsWithLineage.forEach((c) =>
      c.lineage!.forEach((l) => {
        if (!m.has(l.source_table_name)) m.set(l.source_table_name, new Set());
        m.get(l.source_table_name)!.add(c.tableName);
      }),
    );
    return m;
  }, [columnsWithLineage]);

  // Connected tables for highlighting
  const connectedTables = useMemo(() => {
    if (!activeTable) return new Set<string>();
    const s = new Set<string>();
    s.add(activeTable);
    // If active is a source table, add all product tables it feeds
    const prods = srcToProdTables.get(activeTable);
    if (prods) prods.forEach((p) => s.add(p));
    // If active is a product table, add all source tables that feed it
    srcToProdTables.forEach((prods, src) => {
      if (prods.has(activeTable)) s.add(src);
    });
    return s;
  }, [activeTable, srcToProdTables]);

  // Highlighted columns when a table is active
  const highlightedSrcCols = useMemo(() => {
    if (!activeTable) return new Map<string, Set<string>>();
    const m = new Map<string, Set<string>>();
    columnsWithLineage.forEach((c) => {
      c.lineage!.forEach((l) => {
        const relevant = activeTable === c.tableName || activeTable === l.source_table_name;
        if (relevant) {
          if (!m.has(l.source_table_name)) m.set(l.source_table_name, new Set());
          m.get(l.source_table_name)!.add(l.source_column_name);
        }
      });
    });
    return m;
  }, [activeTable, columnsWithLineage]);

  const highlightedProdCols = useMemo(() => {
    if (!activeTable) return new Map<string, Set<string>>();
    const m = new Map<string, Set<string>>();
    columnsWithLineage.forEach((c) => {
      c.lineage!.forEach((l) => {
        const relevant = activeTable === c.tableName || activeTable === l.source_table_name;
        if (relevant) {
          if (!m.has(c.tableName)) m.set(c.tableName, new Set());
          m.get(c.tableName)!.add(c.column_name);
        }
      });
    });
    return m;
  }, [activeTable, columnsWithLineage]);

  // Precompute source column data per source table (sorted)
  const srcColsMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [st, cols] of sourceTables) m.set(st, Array.from(cols).sort());
    return m;
  }, [sourceTables]);

  // Precompute product lineage columns per product table
  const prodLineageColsMap = useMemo(() => {
    const m = new Map<string, { name: string; role: string | null }[]>();
    for (const t of productTables) {
      m.set(t.table_name, t.columns.filter((c) => c.lineage && c.lineage.length > 0).map((c) => ({ name: c.column_name, role: c.column_role })));
    }
    return m;
  }, [productTables]);

  // Which source tables are connected to the active table (for expand)
  const expandedSrcTables = useMemo(() => {
    if (!activeTable) return new Set<string>();
    const s = new Set<string>();
    // If active is a source table, expand it
    if (sourceTableMap.has(activeTable)) s.add(activeTable);
    // If active is a product table, expand all source tables that feed it
    srcToProdTables.forEach((prods, src) => { if (prods.has(activeTable)) s.add(src); });
    return s;
  }, [activeTable, sourceTableMap, srcToProdTables]);

  const expandedProdTables = useMemo(() => {
    if (!activeTable) return new Set<string>();
    const s = new Set<string>();
    // If active is a product table, expand it
    if (prodLineageColsMap.has(activeTable)) s.add(activeTable);
    // If active is a source table, expand all product tables it feeds
    const prods = srcToProdTables.get(activeTable);
    if (prods) prods.forEach((p) => s.add(p));
    return s;
  }, [activeTable, prodLineageColsMap, srcToProdTables]);

  // Build table-level edges (always available)
  const tableLevelEdges = useMemo(() => {
    const edges: any[] = [];
    const seen = new Set<string>();
    srcToProdTables.forEach((prods, src) => {
      prods.forEach((prod) => {
        const key = `${src}->${prod}`;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push({
          id: `tbl-${key}`,
          source: `src-${src}`,
          sourceHandle: hR(`table:${src}`),
          target: `prod-${prod}`,
          targetHandle: hL(`table:${prod}`),
          type: 'lineageEdge',
          data: {
            transform: '',
            highlighted: false,
            dimmed: false,
            hovered: false,
            onHover: () => {},
            edgeId: `tbl-${key}`,
            fromLabel: src,
            toLabel: prod,
          },
        });
      });
    });
    return edges;
  }, [srcToProdTables]);

  // Build column-level edges for the active table
  const columnLevelEdges = useMemo(() => {
    if (!activeTable) return [];
    const edges: any[] = [];
    const edgeSet = new Set<string>();
    columnsWithLineage.forEach((c) => {
      c.lineage!.forEach((l) => {
        const relevant = activeTable === c.tableName || activeTable === l.source_table_name;
        if (!relevant) return;
        const edgeId = `col-${l.source_table_name}.${l.source_column_name}->${c.tableName}.${c.column_name}`;
        if (edgeSet.has(edgeId)) return;
        edgeSet.add(edgeId);
        edges.push({
          id: edgeId,
          source: `src-${l.source_table_name}`,
          sourceHandle: hR(`${l.source_table_name}.${l.source_column_name}`),
          target: `prod-${c.tableName}`,
          targetHandle: hL(`${c.tableName}.${c.column_name}`),
          type: 'lineageEdge',
          data: {
            transform: l.transformation_description ?? '',
            highlighted: true,
            dimmed: false,
            hovered: false,
            onHover: () => {},
            edgeId,
            fromLabel: `${l.source_table_name}.${l.source_column_name}`,
            toLabel: `${c.tableName}.${c.column_name}`,
          },
        });
      });
    });
    return edges;
  }, [activeTable, columnsWithLineage]);

  // Build current nodes — recalculate Y positions every time so expanded tables push others down
  const currentNodes = useMemo(() => {
    const nodes: Node[] = [];

    // Source column: recalculate Y with actual heights
    let srcY = 0;
    for (const [st] of sourceTables) {
      const cols = srcColsMap.get(st) ?? [];
      const expanded = expandedSrcTables.has(st);
      const h = expanded ? HEADER_H + cols.length * ROW_H : HEADER_H;
      nodes.push({
        id: `src-${st}`,
        type: 'srcNode',
        position: { x: 0, y: srcY },
        data: {
          tableName: st, columns: cols,
          focused: activeTable === st,
          highlighted: connectedTables.has(st),
          dimmed: activeTable !== null && !connectedTables.has(st),
          highlightedCols: highlightedSrcCols.get(st) ?? new Set(),
          showColumns: expanded,
        },
        style: { width: SRC_W, height: h },
      });
      srcY += h + GAP_Y;
    }

    // Product column: recalculate Y with actual heights, centered vs source column
    const totalSrcH = Math.max(0, srcY - GAP_Y);
    let totalProdH = 0;
    const prodHeights: number[] = [];
    for (const t of productTables) {
      const cols = prodLineageColsMap.get(t.table_name) ?? [];
      const expanded = expandedProdTables.has(t.table_name);
      const h = expanded ? HEADER_H + cols.length * ROW_H : HEADER_H;
      prodHeights.push(h);
      totalProdH += h + GAP_Y;
    }
    totalProdH = Math.max(0, totalProdH - GAP_Y);
    let prodY = Math.max(0, (totalSrcH - totalProdH) / 2);

    for (let i = 0; i < productTables.length; i++) {
      const t = productTables[i];
      const cols = prodLineageColsMap.get(t.table_name) ?? [];
      const expanded = expandedProdTables.has(t.table_name);
      const h = prodHeights[i];
      nodes.push({
        id: `prod-${t.table_name}`,
        type: 'prodNode',
        position: { x: SRC_W + GAP_X, y: prodY },
        data: {
          tableName: t.table_name, tableRole: t.table_role,
          columns: cols,
          focused: activeTable === t.table_name,
          highlighted: connectedTables.has(t.table_name),
          dimmed: activeTable !== null && !connectedTables.has(t.table_name),
          highlightedCols: highlightedProdCols.get(t.table_name) ?? new Set(),
          showColumns: expanded,
        },
        style: { width: PROD_W, height: h },
      });
      prodY += h + GAP_Y;
    }
    return nodes;
  }, [sourceTables, productTables, srcColsMap, prodLineageColsMap, activeTable, connectedTables, expandedSrcTables, expandedProdTables, highlightedSrcCols, highlightedProdCols]);

  // Merge edges: table-level (dimmed when detail shown) + column-level (when active)
  const currentEdges = useMemo(() => {
    if (!activeTable) {
      // No selection: show only table-level edges
      return tableLevelEdges.map((e) => ({
        ...e,
        data: { ...e.data, highlighted: false, dimmed: false, hovered: hoveredEdge === e.data.edgeId, onHover: setHoveredEdge },
      }));
    }
    // Selection active: show dimmed table-level for unrelated + column-level for related
    const dimmedTableEdges = tableLevelEdges.map((e) => {
      const srcTable = e.source.replace('src-', '');
      const prodTable = e.target.replace('prod-', '');
      const isRelated = activeTable === srcTable || activeTable === prodTable;
      // Hide related table-level edges (column-level replaces them)
      if (isRelated) return null;
      return {
        ...e,
        data: { ...e.data, highlighted: false, dimmed: true, hovered: false, onHover: setHoveredEdge },
      };
    }).filter(Boolean);

    const colEdges = columnLevelEdges.map((e) => ({
      ...e,
      data: { ...e.data, highlighted: true, dimmed: false, hovered: hoveredEdge === e.data.edgeId, onHover: setHoveredEdge },
    }));

    return [...dimmedTableEdges, ...colEdges];
  }, [activeTable, tableLevelEdges, columnLevelEdges, hoveredEdge]);

  const [nodes, setNodes, onNodesChange] = useNodesState(currentNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(currentEdges);

  // Sync nodes & edges when computed values change
  useEffect(() => { setNodes(currentNodes); }, [currentNodes, setNodes]);
  useEffect(() => { setEdges(currentEdges); }, [currentEdges, setEdges]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    const tableName = node.id.replace(/^(src|prod)-/, '');
    setActiveTable((prev) => (prev === tableName ? null : tableName));
  }, []);

  const onPaneClick = useCallback(() => setActiveTable(null), []);

  const height = Math.max(500, (sourceTables.length + productTables.length) * 80 + 200);

  return (
    <div style={{ height }}>
      <ReactFlow
        nodes={nodes} edges={edges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick} onPaneClick={onPaneClick}
        nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        fitView fitViewOptions={{ padding: 0.12 }}
        minZoom={0.2} maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable nodesConnectable={false} elementsSelectable
        panOnScroll zoomOnScroll={false}
      >
        <Background color="#e2e8f0" gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => n.id.startsWith('src-') ? '#94a3b8' : '#93c5fd'}
          maskColor="rgba(0,0,0,.08)"
          style={{ borderRadius: 8, border: '1px solid #e2e8f0' }}
        />
      </ReactFlow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export default function LineageFlow({ data }: { data: LineageData }) {
  return (
    <ReactFlowProvider>
      <LineageFlowInner data={data} />
    </ReactFlowProvider>
  );
}
