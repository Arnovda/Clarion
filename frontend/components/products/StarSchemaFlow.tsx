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
const HEADER_H = 52;
const ROW_H    = 26;
const DIM_W    = 260;
const FACT_W   = 300;
const GAP_X    = 360;   // horizontal gap between dim and fact columns
const GAP_Y    = 24;    // vertical gap between table cards

// Handle IDs
const hL = (id: number | string) => `L_${id}`;
const hR = (id: number | string) => `R_${id}`;

// ---------------------------------------------------------------------------
// Types expected from parent
// ---------------------------------------------------------------------------
export interface PTColumn {
  id: number;
  column_name: string;
  data_type: string | null;
  column_role: string | null;
  fk_target_table: string | null;
  fk_target_column: string | null;
}

export interface PTTable {
  id: number;
  table_name: string;
  display_name: string | null;
  description: string | null;
  table_role: string;
  columns: PTColumn[];
}

export interface PTRelationship {
  id: number;
  from_table_name: string;
  from_column_name: string;
  to_table_name: string;
  to_column_name: string;
  relationship_type: string;
}

export interface StarSchemaData {
  id: number;
  name: string;
  description: string | null;
  grain: string | null;
  tables: PTTable[];
  relationships: PTRelationship[];
}

// ---------------------------------------------------------------------------
// Observatory palette for the schema diagram
// ---------------------------------------------------------------------------
const OBS = {
  ink:          '#0f1a22',
  ink2:         '#334049',
  muted:        '#6b7680',
  muted2:       '#8891a0',
  line:         '#d0d5da',
  softer:       '#edeff2',
  raised:       '#ffffff',
  ocean:        '#164e63',
  oceanHover:   '#103d4f',
  oceanSoft:    '#d0e1e6',
  oceanSofter:  '#e8f0f3',
  ai:           '#c08a5e',
  aiSoft:       '#f1e4d6',
  ok:           '#3f7a5c',
  okSoft:       '#dbe8e0',
  warn:         '#a06a1c',
  warnSoft:     '#f1e4c8',
  err:          '#a43a3a',
  errSoft:      '#f1d7d7',
  plum:         '#6b4e8c',
} as const;

// ---------------------------------------------------------------------------
// Relationship type metadata (matches RelationshipCanvas)
// ---------------------------------------------------------------------------
const TYPE_META: Record<string, { color: string; label: string; src: string; tgt: string }> = {
  many_to_one:  { color: OBS.warn,  label: 'Many -> One',  src: 'N', tgt: '1' },
  one_to_many:  { color: OBS.ocean, label: 'One -> Many',  src: '1', tgt: 'N' },
  one_to_one:   { color: OBS.ok,    label: 'One -> One',   src: '1', tgt: '1' },
  many_to_many: { color: OBS.plum,  label: 'Many <-> Many', src: 'N', tgt: 'N' },
  fact_to_dim:  { color: OBS.ocean, label: 'Fact -> Dim',  src: 'N', tgt: '1' },
  dim_to_fact:  { color: OBS.ocean, label: 'Dim -> Fact',  src: '1', tgt: 'N' },
};
const getMeta = (t: string) =>
  TYPE_META[t] ?? { color: OBS.muted, label: t, src: '?', tgt: '?' };

// ---------------------------------------------------------------------------
// Column role badge
// ---------------------------------------------------------------------------
function ColRoleBadge({ role }: { role: string | null }) {
  if (!role) return null;
  const m: Record<string, { bg: string; text: string; label: string; hint: string }> = {
    surrogate_key:         { bg: OBS.warnSoft,    text: OBS.warn,  label: 'SK',   hint: 'Surrogate key — the table’s own internal ID, generated here.' },
    natural_key:           { bg: OBS.oceanSofter, text: OBS.ocean, label: 'NK',   hint: 'Natural key — the real-world ID from the source (e.g. invoice number).' },
    foreign_key:           { bg: OBS.aiSoft,      text: OBS.ai,    label: 'FK',   hint: 'Foreign key — points at a row in a lookup table.' },
    degenerate_dimension:  { bg: OBS.errSoft,     text: OBS.err,   label: 'DD',   hint: 'Degenerate dimension — an ID kept on the measure table with no lookup of its own.' },
    measure:               { bg: OBS.okSoft,      text: OBS.ok,    label: 'M',    hint: 'Measure — a number you can sum or average.' },
    attribute:             { bg: OBS.softer,      text: OBS.muted, label: 'attr', hint: 'Attribute — descriptive text you filter or group by.' },
  };
  const s = m[role];
  if (!s) return null;
  return (
    <span title={s.hint} style={{
      fontSize: 8, fontWeight: 600, padding: '1px 4px', borderRadius: 3,
      background: s.bg, color: s.text, flexShrink: 0, lineHeight: '14px',
      border: `1px solid ${OBS.line}`,
    }}>{s.label}</span>
  );
}

// ---------------------------------------------------------------------------
// Table node — similar to RelationshipCanvas TableNode
// ---------------------------------------------------------------------------
interface TableNodeData {
  table: PTTable;
  isDim: boolean;
  focused: boolean;             // this table is clicked
  highlighted: boolean;         // connected to the clicked table
  dimmed: boolean;              // another table is clicked but this one is unrelated
  highlightedFkCols: Set<string>; // FK column names to highlight
}

const HANDLE_STYLE_BASE = {
  width: 8, height: 8,
  border: '2px solid white',
  borderRadius: '50%',
  zIndex: 20,
};

function TableNode({ data }: NodeProps<TableNodeData>) {
  const { table, isDim, focused, highlighted, dimmed, highlightedFkCols } = data;
  const cols = table.columns;
  const totalH = HEADER_H + cols.length * ROW_H;

  const headerBg = isDim ? (focused ? OBS.oceanHover : OBS.ocean) : (focused ? '#4e3a66' : OBS.plum);
  const borderColor = focused ? (isDim ? OBS.ocean : OBS.plum) : highlighted ? (isDim ? OBS.oceanSoft : '#c8bcd6') : OBS.line;
  const opacity = dimmed ? 0.3 : 1;

  return (
    <div style={{
      position: 'relative',
      width: isDim ? DIM_W : FACT_W,
      height: totalH,
      opacity,
      transition: 'opacity 0.2s',
    }}>
      {/* Handles — column-level */}
      {cols.map((col, i) => {
        const top = HEADER_H + i * ROW_H + ROW_H / 2;
        const handleBg = highlightedFkCols.has(col.column_name) ? OBS.warn : OBS.oceanSoft;
        return (
          <Fragment key={col.id}>
            <Handle type="source" position={Position.Left} id={hL(col.id)}
              style={{ ...HANDLE_STYLE_BASE, background: handleBg, position: 'absolute', top, left: -4, transform: 'translateY(-50%)' }} />
            <Handle type="source" position={Position.Right} id={hR(col.id)}
              style={{ ...HANDLE_STYLE_BASE, background: handleBg, position: 'absolute', top, right: -4, transform: 'translateY(-50%)' }} />
          </Fragment>
        );
      })}

      {/* Visual box */}
      <div style={{
        position: 'absolute', inset: 0,
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        overflow: 'hidden',
        background: OBS.raised,
        boxShadow: focused
          ? `0 0 0 2px ${isDim ? OBS.oceanSoft : '#d6ccdf'}, 0 6px 20px rgba(13,28,47,0.1)`
          : highlighted
          ? `0 0 0 1px ${isDim ? OBS.oceanSoft : '#d6ccdf'}`
          : '0 2px 6px rgba(13,28,47,0.04)',
      }}>
        {/* Header */}
        <div style={{
          height: HEADER_H,
          background: headerBg,
          padding: '8px 12px',
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontSize: 9, fontWeight: 500, padding: '1px 6px', borderRadius: 3,
              background: 'rgba(255,255,255,0.18)',
              color: 'rgba(255,255,255,0.9)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              fontFamily: 'var(--font-mono)',
            }}>{isDim ? 'dimension' : 'fact'}</span>
          </div>
          <p style={{
            margin: '2px 0 0', color: '#fff', fontSize: 12, fontWeight: 500,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{table.display_name || table.table_name}</p>
        </div>

        {/* Column rows */}
        {cols.map((col, i) => {
          const isFkHighlighted = highlightedFkCols.has(col.column_name);
          const rowBg = isFkHighlighted ? OBS.warnSoft : i % 2 === 0 ? OBS.raised : OBS.softer;
          const leftBdr = isFkHighlighted ? `2px solid ${OBS.warn}` : '2px solid transparent';

          return (
            <div key={col.id} style={{
              height: ROW_H,
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '0 10px',
              background: rowBg,
              borderTop: `1px solid ${OBS.line}`,
              borderLeft: leftBdr,
            }}>
              <ColRoleBadge role={col.column_role} />
              <span style={{
                fontSize: 11, color: isFkHighlighted ? OBS.warn : OBS.ink2,
                fontWeight: isFkHighlighted ? 600 : 400,
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{col.column_name}</span>
              {col.fk_target_table && (
                <span style={{
                  fontSize: 9, color: OBS.plum, fontFamily: 'var(--font-mono), monospace', flexShrink: 0,
                }}>&#8594; {col.fk_target_table}</span>
              )}
              {!col.fk_target_table && (
                <span style={{
                  fontSize: 9, color: OBS.muted2, fontFamily: 'var(--font-mono), monospace', flexShrink: 0,
                }}>{col.data_type?.toLowerCase().slice(0, 8)}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relationship edge — bezier with 1/N labels, hover tooltip
// ---------------------------------------------------------------------------
interface RelEdgeData {
  relType: string;
  relId: number;
  fromLabel: string;
  toLabel: string;
  highlighted: boolean;
  dimmed: boolean;
  onHover: (id: number | null) => void;
  hovered: boolean;
}

function RelEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data,
}: EdgeProps<RelEdgeData>) {
  const meta = getMeta(data?.relType ?? '');
  const isHighlighted = data?.highlighted ?? false;
  const isDimmed = data?.dimmed ?? false;
  const isHovered = data?.hovered ?? false;
  const active = isHighlighted || isHovered;
  const color = active ? OBS.ocean : isDimmed ? OBS.line : meta.color;
  const strokeW = active ? 2.5 : isDimmed ? 1 : 1.5;
  const opacity = isDimmed ? 0.25 : 1;
  const markerId = `arr-star-${id}`;

  const nColor = active ? OBS.ocean : OBS.muted2;
  const oColor = active ? OBS.warn : OBS.muted2;
  const srcLabelColor = meta.src === 'N' ? nColor : oColor;
  const tgtLabelColor = meta.tgt === 'N' ? nColor : oColor;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    curvature: 0.3,
  });

  return (
    <g style={{ opacity, transition: 'opacity 0.2s' }}>
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
        </marker>
      </defs>

      {/* White knockout */}
      <path d={edgePath} fill="none" stroke="white" strokeWidth={strokeW + 6} />

      {/* Wide hit zone */}
      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={18}
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => data?.onHover(data.relId)}
        onMouseLeave={() => data?.onHover(null)}
      />

      {/* Visible stroke */}
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeW}
        markerEnd={`url(#${markerId})`}
        style={{ cursor: 'pointer', transition: 'stroke 0.15s, stroke-width 0.15s' }}
        onMouseEnter={() => data?.onHover(data.relId)}
        onMouseLeave={() => data?.onHover(null)}
      />

      <EdgeLabelRenderer>
        {/* Source cardinality */}
        <div className="nodrag nopan" style={{
          position: 'absolute', pointerEvents: 'none',
          transform: `translate(-50%,-50%) translate(${
            sourceX + (sourcePosition === Position.Right ? 14 : -14)
          }px,${sourceY - 10}px)`,
        }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: srcLabelColor }}>{meta.src}</span>
        </div>

        {/* Target cardinality */}
        <div className="nodrag nopan" style={{
          position: 'absolute', pointerEvents: 'none',
          transform: `translate(-50%,-50%) translate(${
            targetX + (targetPosition === Position.Left ? -14 : 14)
          }px,${targetY - 10}px)`,
        }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: tgtLabelColor }}>{meta.tgt}</span>
        </div>

        {/* Centre label — type pill on hover */}
        <div className="nodrag nopan" style={{
          position: 'absolute', pointerEvents: 'all', cursor: 'default',
          transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
        }}
          onMouseEnter={() => data?.onHover(data!.relId)}
          onMouseLeave={() => data?.onHover(null)}
        >
          <span style={{
            fontSize: 10, fontWeight: 500, color: 'white',
            background: color, padding: '2px 8px', borderRadius: 3,
            whiteSpace: 'nowrap',
            letterSpacing: '0.04em',
            opacity: active ? 1 : 0,
            transition: 'opacity 0.15s',
            pointerEvents: active ? 'all' : 'none',
          }}>{meta.label}</span>
        </div>

        {/* Hover tooltip */}
        {isHovered && (
          <div className="nodrag nopan" style={{
            position: 'absolute', pointerEvents: 'none',
            transform: `translate(-50%, -100%) translate(${labelX}px,${labelY - 18}px)`,
            zIndex: 9999,
          }}>
            <div style={{
              background: OBS.ink, color: 'rgba(255,255,255,0.9)',
              borderRadius: 6, padding: '8px 12px',
              minWidth: 180, maxWidth: 280,
              boxShadow: '0 4px 16px rgba(13,28,47,0.18)',
              border: '1px solid rgba(255,255,255,0.08)',
              fontSize: 11, lineHeight: 1.5, whiteSpace: 'nowrap',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, letterSpacing: '0.08em' }}>FROM</span>
                <span style={{ fontWeight: 500, color: 'rgba(255,255,255,0.92)' }}>{data?.fromLabel}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ color: meta.color, fontWeight: 600, fontSize: 13 }}>{meta.src}</span>
                <div style={{ flex: 1, height: 1, background: meta.color, borderRadius: 1 }} />
                <span style={{ fontSize: 10, color: meta.color, fontWeight: 500, letterSpacing: '0.04em' }}>{meta.label}</span>
                <div style={{ flex: 1, height: 1, background: meta.color, borderRadius: 1 }} />
                <span style={{ color: meta.color, fontWeight: 600, fontSize: 13 }}>{meta.tgt}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, letterSpacing: '0.08em' }}>TO</span>
                <span style={{ fontWeight: 500, color: 'rgba(255,255,255,0.92)' }}>{data?.toLabel}</span>
              </div>
              <div style={{
                position: 'absolute', bottom: -6, left: '50%', transform: 'translateX(-50%)',
                width: 0, height: 0,
                borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
                borderTop: `6px solid ${OBS.ink}`,
              }} />
            </div>
          </div>
        )}
      </EdgeLabelRenderer>
    </g>
  );
}

const nodeTypes = { starTableNode: TableNode };
const edgeTypes = { starRelEdge: RelEdge };

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
function StarSchemaFlowInner({ schema }: { schema: StarSchemaData }) {
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [hoveredRelId, setHoveredRelId] = useState<number | null>(null);

  const factTables = useMemo(() => schema.tables.filter((t) => t.table_role === 'fact'), [schema]);
  const dimTables = useMemo(() => schema.tables.filter((t) => t.table_role !== 'fact'), [schema]);

  // Relationship map for highlighting
  const relMap = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const rel of schema.relationships) {
      const a = rel.from_table_name;
      const b = rel.to_table_name;
      if (!m.has(a)) m.set(a, new Set());
      if (!m.has(b)) m.set(b, new Set());
      m.get(a)!.add(b);
      m.get(b)!.add(a);
    }
    return m;
  }, [schema]);

  // Build column name lookup: table_name -> { id -> column }
  const colLookup = useMemo(() => {
    const m = new Map<string, Map<string, PTColumn>>();
    for (const t of schema.tables) {
      const cm = new Map<string, PTColumn>();
      for (const c of t.columns) cm.set(c.column_name, c);
      m.set(t.table_name, cm);
    }
    return m;
  }, [schema]);

  const isHighlighted = useCallback((tableName: string) => {
    if (!activeTable) return false;
    if (tableName === activeTable) return true;
    return relMap.get(activeTable)?.has(tableName) ?? false;
  }, [activeTable, relMap]);

  const isDimmed = useCallback((tableName: string) => {
    return activeTable !== null && !isHighlighted(tableName);
  }, [activeTable, isHighlighted]);

  // FK columns that should be highlighted for the active table
  const highlightedFkCols = useMemo(() => {
    if (!activeTable) return new Set<string>();
    const cols = new Set<string>();
    for (const rel of schema.relationships) {
      if (rel.from_table_name === activeTable || rel.to_table_name === activeTable) {
        cols.add(rel.from_column_name);
        cols.add(rel.to_column_name);
      }
    }
    return cols;
  }, [activeTable, schema.relationships]);

  // Compute layout: dims on left, facts on right
  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: any[] = [];

    // Layout dims vertically on the left
    let dimY = 0;
    for (const dim of dimTables) {
      const h = HEADER_H + dim.columns.length * ROW_H;
      nodes.push({
        id: `table-${dim.table_name}`,
        type: 'starTableNode',
        position: { x: 0, y: dimY },
        data: {
          table: dim,
          isDim: true,
          focused: false,
          highlighted: false,
          dimmed: false,
          highlightedFkCols: new Set<string>(),
        },
        style: { width: DIM_W, height: h },
      });
      dimY += h + GAP_Y;
    }

    // Layout facts vertically on the right, centered relative to dims
    const totalDimH = dimY - GAP_Y;
    let factY = 0;
    const factHeights = factTables.map((f) => HEADER_H + f.columns.length * ROW_H);
    const totalFactH = factHeights.reduce((s, h) => s + h + GAP_Y, -GAP_Y);
    const factStartY = Math.max(0, (totalDimH - totalFactH) / 2);
    factY = factStartY;

    for (let i = 0; i < factTables.length; i++) {
      const fact = factTables[i];
      const h = factHeights[i];
      nodes.push({
        id: `table-${fact.table_name}`,
        type: 'starTableNode',
        position: { x: DIM_W + GAP_X, y: factY },
        data: {
          table: fact,
          isDim: false,
          focused: false,
          highlighted: false,
          dimmed: false,
          highlightedFkCols: new Set<string>(),
        },
        style: { width: FACT_W, height: h },
      });
      factY += h + GAP_Y;
    }

    // Build edges from relationships — connect at column level
    for (const rel of schema.relationships) {
      // Figure out which is the dim and which is the fact
      const fromIsDim = dimTables.some((d) => d.table_name === rel.from_table_name);
      const dimName = fromIsDim ? rel.from_table_name : rel.to_table_name;
      const factName = fromIsDim ? rel.to_table_name : rel.from_table_name;
      const dimColName = fromIsDim ? rel.from_column_name : rel.to_column_name;
      const factColName = fromIsDim ? rel.to_column_name : rel.from_column_name;

      const dimCol = colLookup.get(dimName)?.get(dimColName);
      const factCol = colLookup.get(factName)?.get(factColName);

      if (!dimCol || !factCol) continue;

      edges.push({
        id: `rel-${rel.id}`,
        source: `table-${dimName}`,
        sourceHandle: hR(dimCol.id),     // right side of dim
        target: `table-${factName}`,
        targetHandle: hL(factCol.id),    // left side of fact
        type: 'starRelEdge',
        data: {
          relType: rel.relationship_type,
          relId: rel.id,
          fromLabel: `${dimName}.${dimColName}`,
          toLabel: `${factName}.${factColName}`,
          highlighted: false,
          dimmed: false,
          onHover: () => {},
          hovered: false,
        },
      });
    }

    return { nodes, edges };
  }, [schema, dimTables, factTables, colLookup]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Update node/edge data when activeTable or hoveredRelId changes
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const tableName = n.id.replace('table-', '');
        return {
          ...n,
          data: {
            ...n.data,
            focused: activeTable === tableName,
            highlighted: isHighlighted(tableName),
            dimmed: isDimmed(tableName),
            highlightedFkCols: activeTable === tableName || isHighlighted(tableName) ? highlightedFkCols : new Set<string>(),
          },
        };
      }),
    );
  }, [activeTable, isHighlighted, isDimmed, highlightedFkCols, setNodes]);

  useEffect(() => {
    setEdges((eds) =>
      eds.map((e) => {
        const relData = e.data;
        if (!relData) return e;
        const fromTable = e.source.replace('table-', '');
        const toTable = e.target.replace('table-', '');
        const relIsHighlighted = activeTable === fromTable || activeTable === toTable;
        const relIsDimmed = activeTable !== null && !relIsHighlighted;
        return {
          ...e,
          data: {
            ...relData,
            highlighted: relIsHighlighted,
            dimmed: relIsDimmed,
            hovered: hoveredRelId === relData.relId,
            onHover: setHoveredRelId,
          },
        };
      }),
    );
  }, [activeTable, hoveredRelId, setEdges]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    const tableName = node.id.replace('table-', '');
    setActiveTable((prev) => (prev === tableName ? null : tableName));
  }, []);

  const onPaneClick = useCallback(() => setActiveTable(null), []);

  return (
    <div style={{ height: Math.max(600, (dimTables.length + factTables.length) * 120 + 200) }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
        panOnScroll={true}
        zoomOnScroll={false}
      >
        <Background color={OBS.line} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            const isDim = n.data?.isDim;
            return isDim ? OBS.oceanSoft : '#d6ccdf';
          }}
          maskColor="rgba(13,28,47,0.06)"
          style={{ borderRadius: 6, border: `1px solid ${OBS.line}` }}
        />
      </ReactFlow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exported wrapper with ReactFlowProvider
// ---------------------------------------------------------------------------
export default function StarSchemaFlow({ schema }: { schema: StarSchemaData }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-6 pt-5 pb-2">
        <h3 className="text-lg font-bold text-slate-800">{schema.name}</h3>
        {schema.grain && (
          <p className="text-sm text-slate-500">
            <span title="Grain — what one row of the measures table represents (e.g. one order line, one day per product).">Grain:</span> {schema.grain}
          </p>
        )}
        <p className="text-xs text-slate-400 mt-1">
          {schema.tables.length} tables · {schema.relationships.length} relationships · Click a table to highlight connections · Drag to reposition
        </p>
      </div>
      <ReactFlowProvider>
        <StarSchemaFlowInner schema={schema} />
      </ReactFlowProvider>
    </div>
  );
}
