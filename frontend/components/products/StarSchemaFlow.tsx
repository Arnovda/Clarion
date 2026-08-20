'use client';

/**
 * <StarSchemaFlow> — one star schema, drawn in the relationship pane's language.
 *
 * Rebuilt 2026-08-19 (owner: "I want 'how it fits together' to look like the
 * relations pane"). The previous version rendered EVERY column of every table
 * as a row — fine for a template table with eight columns, unusable for an
 * AI-designed table with eighty: the cards became 2,000px strips and fitView
 * zoomed out until nothing was readable. This version applies the two lessons
 * the /relationships canvas paid for:
 *
 *   1. A table renders the fields it CONNECTS ON, not all of them and not
 *      none. The join surface is two or three rows, so every edge terminates
 *      on a named field at both ends; "+N more fields" reveals the rest.
 *   2. The layout answers the question being asked. A star schema IS one
 *      table in the middle with its lookups around it, so the measures table
 *      sits dead-centre and the lookups go on an ellipse (radialLayout) —
 *      no edge crossings, by construction.
 *
 * Geometry (HEADER_H/ROW_H/handle ids/nodeHeight) and the radial layout are
 * IMPORTED from components/relationships — the numbers are solved there and
 * the two panes must agree visually, so re-deriving them here would just let
 * them drift apart. Cardinality rides the line ENDS (1 = one row, ∗ = many),
 * same notation, same 15px offset.
 */

import { useCallback, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Node, Edge, NodeProps,
  Handle, Position,
  EdgeProps, getBezierPath,
  ReactFlowProvider, ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { KeyRound, Hash, Plus, Minus } from 'lucide-react';
import {
  HEADER_H, ROW_H, FOOTER_H, NODE_W, handleLeft, handleRight, rowCentreY, nodeHeight,
} from '@/components/relationships/geometry';
import { radialLayout } from '@/components/relationships/focusLayout';

// ---------------------------------------------------------------------------
// Types expected from parent (the GET /products/:id payload)
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
  /** Relationship-endpoint columns the is_technical firewall keeps out of
      `columns` (FKs, surrogate keys). The diagram needs them — without
      these the join surface is empty and edges land on card edges instead
      of named fields. Optional: older payloads simply lack the list. */
  join_columns?: PTColumn[];
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

// The two identities on this canvas: the measures table (fact) and its
// lookups (dims). Same spine-mark treatment as the relationship pane's
// source colours — one strong mark reads as identity.
const FACT_COLOR = '#6b4e8c';
const DIM_COLOR = '#164e63';
const EDGE_COLOR = '#164e63';

// ---------------------------------------------------------------------------
// Node — the relationship pane's TableNode, retargeted at product tables
// ---------------------------------------------------------------------------
interface SchemaNodeData {
  table: PTTable;
  isFact: boolean;
  /** Exactly the columns to render, in order. The parent decides which. */
  shown: PTColumn[];
  hiddenCount: number;
  showingAll: boolean;
  dimmed: boolean;
  /** Column names lit because a selected/hovered table connects on them. */
  litColumns: ReadonlySet<string>;
  linkCount: number;
  onToggleAll: (tableId: number) => void;
}

const HANDLE_STYLE: React.CSSProperties = {
  width: 9,
  height: 9,
  background: '#ffffff',
  border: '1.5px solid #b8bec5',
  borderRadius: 9,
};

function SchemaNodeImpl({ data, selected }: NodeProps<SchemaNodeData>) {
  const { table, isFact, shown, hiddenCount, showingAll, dimmed, litColumns, linkCount } = data;
  const hasFooter = hiddenCount > 0 || showingAll;
  const height = nodeHeight(shown.length, hasFooter);
  const color = isFact ? FACT_COLOR : DIM_COLOR;

  return (
    <div
      style={{ position: 'relative', width: NODE_W, height }}
      className={dimmed ? 'opacity-40 transition-opacity' : 'transition-opacity'}
    >
      {/* Whole-node handles so an endpoint that is somehow not rendered can
          still anchor its edge at the header. Handles are SIBLINGS of the
          box, never children — the box clips (rounded corners), and a handle
          inside it is clipped away at exactly the node edge. */}
      <Handle
        type="source" position={Position.Left} id={handleLeft('table')}
        style={{ ...HANDLE_STYLE, position: 'absolute', top: HEADER_H / 2, left: -5, transform: 'translateY(-50%)' }}
      />
      <Handle
        type="source" position={Position.Right} id={handleRight('table')}
        style={{ ...HANDLE_STYLE, position: 'absolute', top: HEADER_H / 2, right: -5, transform: 'translateY(-50%)' }}
      />
      {shown.map((col, i) => {
        const top = rowCentreY(i);
        return (
          <span key={col.id}>
            <Handle
              type="source" position={Position.Left} id={handleLeft(col.id)}
              style={{ ...HANDLE_STYLE, position: 'absolute', top, left: -5, transform: 'translateY(-50%)' }}
            />
            <Handle
              type="source" position={Position.Right} id={handleRight(col.id)}
              style={{ ...HANDLE_STYLE, position: 'absolute', top, right: -5, transform: 'translateY(-50%)' }}
            />
          </span>
        );
      })}

      <div
        className="overflow-hidden rounded-xl bg-raised"
        style={{
          width: NODE_W,
          height,
          border: `1px solid ${isFact ? color : '#d0d5da'}`,
          boxShadow: isFact
            ? `0 0 0 4px ${color}26, 0 10px 28px rgba(15,26,34,0.14)`
            : selected
              ? '0 0 0 3px rgba(22,78,99,0.14), 0 6px 18px rgba(15,26,34,0.10)'
              : '0 1px 3px rgba(15,26,34,0.07)',
        }}
      >
        <div className="relative flex items-start gap-2 pl-4 pr-3" style={{ height: HEADER_H }}>
          <span className="absolute inset-y-0 left-0 w-[5px]" style={{ background: color }} aria-hidden />
          <div className="min-w-0 flex-1 pt-[10px]">
            <div className={`truncate leading-tight text-ink ${isFact ? 'text-[14px] font-semibold' : 'text-[13px] font-medium'}`}>
              {table.display_name || table.table_name}
            </div>
            <div className="truncate text-[11px] leading-tight text-muted">
              {isFact ? 'the measures table' : 'lookup'}
              {' · '}
              {linkCount === 0 ? 'not linked yet' : `${linkCount} link${linkCount === 1 ? '' : 's'}`}
            </div>
          </div>
        </div>

        {shown.map((col) => {
          const lit = litColumns.has(col.column_name);
          const isMeasure = col.column_role === 'measure';
          return (
            <div
              key={col.id}
              className="flex items-center gap-1.5 border-t border-line/50 pl-4 pr-3 text-[11.5px]"
              style={{
                height: ROW_H,
                background: lit ? `${color}1a` : undefined,
                color: lit ? '#0f1a22' : '#334049',
                fontWeight: lit ? 600 : 400,
              }}
            >
              {isMeasure
                ? <Hash size={11} className="shrink-0 text-muted2" />
                : <KeyRound size={11} className="shrink-0" style={{ color: lit ? color : '#8891a0' }} />}
              <span className="min-w-0 flex-1 truncate">{col.column_name}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted2">
                {(col.data_type ?? '').slice(0, 7)}
              </span>
            </div>
          );
        })}

        {hasFooter && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); data.onToggleAll(table.id); }}
            className="flex w-full items-center gap-1.5 border-t border-line/50 pl-4 pr-3 text-left text-[11px] text-muted hover:bg-soft hover:text-ink2"
            style={{ height: FOOTER_H }}
          >
            {showingAll ? <Minus size={10} /> : <Plus size={10} />}
            {showingAll ? 'Show only linked fields' : `${hiddenCount} more field${hiddenCount === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edge — solid line, cardinality on the ENDS (1 = one row, ∗ = many)
// ---------------------------------------------------------------------------
interface SchemaEdgeData {
  dimmed: boolean;
  /** [symbol at the rendered source end, symbol at the rendered target end] */
  ends: readonly [string, string];
}

const END_OFFSET = 15;

function EndSymbol({ x, y, symbol, faded }: { x: number; y: number; symbol: string; faded: boolean }) {
  return (
    <g pointerEvents="none" opacity={faded ? 0.18 : 1}>
      <circle cx={x} cy={y} r={7.5} fill="#fffdfa" stroke={EDGE_COLOR} strokeWidth={1.25} />
      <text
        x={x} y={y} textAnchor="middle" dominantBaseline="central"
        fontSize={10} fontWeight={600} fill={EDGE_COLOR}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
      >
        {symbol}
      </text>
    </g>
  );
}

function SchemaEdgeImpl({
  sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data,
}: EdgeProps<SchemaEdgeData>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const dimmed = data?.dimmed ?? false;
  return (
    <>
      <path
        d={path}
        fill="none"
        stroke={EDGE_COLOR}
        strokeWidth={2.2}
        strokeOpacity={dimmed ? 0.18 : 1}
        style={{ pointerEvents: 'none' }}
      />
      {data?.ends && (
        <>
          <EndSymbol
            x={sourceX + (sourcePosition === Position.Left ? -END_OFFSET : END_OFFSET)}
            y={sourceY}
            symbol={data.ends[0]}
            faded={dimmed}
          />
          <EndSymbol
            x={targetX + (targetPosition === Position.Left ? -END_OFFSET : END_OFFSET)}
            y={targetY}
            symbol={data.ends[1]}
            faded={dimmed}
          />
        </>
      )}
    </>
  );
}

const nodeTypes = { schemaNode: SchemaNodeImpl };
const edgeTypes = { schemaEdge: SchemaEdgeImpl };

// `∗` is U+2217, not the typographic asterisk — it sits on the centre line
// inside the circle. Symbols follow the STORED from→to orientation and are
// swapped when the edge is rendered the other way around.
const END_SYMBOLS: Record<string, readonly [string, string]> = {
  many_to_one: ['∗', '1'],
  one_to_many: ['1', '∗'],
  one_to_one: ['1', '1'],
  many_to_many: ['∗', '∗'],
  fact_to_dim: ['∗', '1'],
  dim_to_fact: ['1', '∗'],
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
function StarSchemaFlowInner({ schema }: { schema: StarSchemaData }) {
  const [activeTableId, setActiveTableId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const toggleAll = useCallback((tableId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      return next;
    });
  }, []);

  const byName = useMemo(() => new Map(schema.tables.map((t) => [t.table_name, t])), [schema]);

  // What a card can show: the firewalled column list PLUS the join columns
  // the endpoint needs. Join columns lead — the linked fields are the answer
  // to the question this canvas is asked, so they must never hide below a
  // fold of attributes.
  const effectiveColumns = useMemo(() => {
    const m = new Map<number, PTColumn[]>();
    for (const t of schema.tables) {
      const have = new Set(t.columns.map((c) => c.column_name));
      const extras = (t.join_columns ?? []).filter((c) => !have.has(c.column_name));
      m.set(t.id, extras.length ? [...extras, ...t.columns] : t.columns);
    }
    return m;
  }, [schema.tables]);

  // The join surface per table: every column that is an endpoint of a
  // relationship in this schema, in the table's own column order.
  const joinSurface = useMemo(() => {
    const surface = new Map<number, Set<string>>();
    for (const rel of schema.relationships) {
      const from = byName.get(rel.from_table_name);
      const to = byName.get(rel.to_table_name);
      if (from) {
        if (!surface.has(from.id)) surface.set(from.id, new Set());
        surface.get(from.id)!.add(rel.from_column_name);
      }
      if (to) {
        if (!surface.has(to.id)) surface.set(to.id, new Set());
        surface.get(to.id)!.add(rel.to_column_name);
      }
    }
    return surface;
  }, [schema.relationships, byName]);

  const shownColumns = useCallback((t: PTTable): PTColumn[] => {
    const all = effectiveColumns.get(t.id) ?? t.columns;
    if (expanded.has(t.id)) return all;
    const names = joinSurface.get(t.id);
    if (!names || names.size === 0) return [];
    return all.filter((c) => names.has(c.column_name));
  }, [expanded, joinSurface, effectiveColumns]);

  const linkCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const rel of schema.relationships) {
      const from = byName.get(rel.from_table_name);
      const to = byName.get(rel.to_table_name);
      if (from) counts.set(from.id, (counts.get(from.id) ?? 0) + 1);
      if (to) counts.set(to.id, (counts.get(to.id) ?? 0) + 1);
    }
    return counts;
  }, [schema.relationships, byName]);

  // Which tables sit next to the active one (for the dim/highlight pass).
  const neighbours = useMemo(() => {
    const m = new Map<number, Set<number>>();
    for (const rel of schema.relationships) {
      const a = byName.get(rel.from_table_name);
      const b = byName.get(rel.to_table_name);
      if (!a || !b) continue;
      if (!m.has(a.id)) m.set(a.id, new Set());
      if (!m.has(b.id)) m.set(b.id, new Set());
      m.get(a.id)!.add(b.id);
      m.get(b.id)!.add(a.id);
    }
    return m;
  }, [schema.relationships, byName]);

  // Column names lit on each table: the fields the active table connects on.
  const litByTable = useMemo(() => {
    const m = new Map<number, Set<string>>();
    if (activeTableId === null) return m;
    const active = schema.tables.find((t) => t.id === activeTableId);
    if (!active) return m;
    for (const rel of schema.relationships) {
      if (rel.from_table_name !== active.table_name && rel.to_table_name !== active.table_name) continue;
      const from = byName.get(rel.from_table_name);
      const to = byName.get(rel.to_table_name);
      if (from) {
        if (!m.has(from.id)) m.set(from.id, new Set());
        m.get(from.id)!.add(rel.from_column_name);
      }
      if (to) {
        if (!m.has(to.id)) m.set(to.id, new Set());
        m.get(to.id)!.add(rel.to_column_name);
      }
    }
    return m;
  }, [activeTableId, schema, byName]);

  const { nodes, edges } = useMemo(() => {
    // The measures table anchors the ring. A schema is one fact plus its
    // lookups by construction; if the data carries no fact (or several),
    // anchor on the most-linked table — the centre must be the table the
    // picture is about, and that is the one everything joins to.
    const facts = schema.tables.filter((t) => t.table_role === 'fact');
    const anchor = facts[0]
      ?? [...schema.tables].sort((a, b) => (linkCounts.get(b.id) ?? 0) - (linkCounts.get(a.id) ?? 0))[0];
    if (!anchor) return { nodes: [] as Node[], edges: [] as Edge[] };
    const ringTables = schema.tables.filter((t) => t.id !== anchor.id);

    const heightOf = (id: number) => {
      const t = schema.tables.find((x) => x.id === id)!;
      const shown = shownColumns(t);
      const total = (effectiveColumns.get(t.id) ?? t.columns).length;
      const hasFooter = total > shown.length || expanded.has(t.id);
      return nodeHeight(shown.length, hasFooter);
    };

    const { positions } = radialLayout(anchor.id, ringTables.map((t) => t.id), heightOf);

    const nodes: Node[] = schema.tables.map((t) => {
      const shown = shownColumns(t);
      const pos = positions.get(t.id) ?? { x: 0, y: 0 };
      const dimmed = activeTableId !== null
        && t.id !== activeTableId
        && !(neighbours.get(activeTableId)?.has(t.id) ?? false);
      return {
        id: String(t.id),
        type: 'schemaNode',
        position: pos,
        data: {
          table: t,
          isFact: t.id === anchor.id,
          shown,
          hiddenCount: (effectiveColumns.get(t.id) ?? t.columns).length - shown.length,
          showingAll: expanded.has(t.id),
          dimmed,
          litColumns: litByTable.get(t.id) ?? new Set<string>(),
          linkCount: linkCounts.get(t.id) ?? 0,
          onToggleAll: toggleAll,
        } satisfies SchemaNodeData,
      };
    });

    const centreX = (id: number) => (positions.get(id)?.x ?? 0) + NODE_W / 2;

    const edges: Edge[] = [];
    for (const rel of schema.relationships) {
      const from = byName.get(rel.from_table_name);
      const to = byName.get(rel.to_table_name);
      if (!from || !to) continue;

      const fromShown = shownColumns(from);
      const toShown = shownColumns(to);
      const fromCol = fromShown.find((c) => c.column_name === rel.from_column_name);
      const toCol = toShown.find((c) => c.column_name === rel.to_column_name);

      // Handles follow the geometry: the edge leaves each node on the side
      // facing the other node, or every neighbour on the left half of the
      // ring gets a line sweeping all the way around its card.
      const fromOnLeft = centreX(from.id) < centreX(to.id);
      const sourceHandle = fromOnLeft ? handleRight(fromCol?.id ?? 'table') : handleLeft(fromCol?.id ?? 'table');
      const targetHandle = fromOnLeft ? handleLeft(toCol?.id ?? 'table') : handleRight(toCol?.id ?? 'table');

      const dimmed = activeTableId !== null && from.id !== activeTableId && to.id !== activeTableId;
      const ends = END_SYMBOLS[rel.relationship_type] ?? (['∗', '1'] as const);

      edges.push({
        id: `rel-${rel.id}`,
        source: String(from.id),
        sourceHandle,
        target: String(to.id),
        targetHandle,
        type: 'schemaEdge',
        data: { dimmed, ends } satisfies SchemaEdgeData,
      });
    }

    return { nodes, edges };
  }, [schema, shownColumns, effectiveColumns, expanded, activeTableId, neighbours, litByTable, linkCounts, byName, toggleAll]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    const id = Number(node.id);
    setActiveTableId((prev) => (prev === id ? null : id));
  }, []);

  return (
    <div style={{ height: 560 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={onNodeClick}
        onPaneClick={() => setActiveTableId(null)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        // The relationship pane's lesson: nothing may shrink below reading
        // size. If the ring is bigger than the pane, the user pans.
        minZoom={0.25}
        maxZoom={1}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        panOnScroll
        zoomOnScroll={false}
      >
        <Background color="#d0d5da" gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exported wrapper
// ---------------------------------------------------------------------------
export default function StarSchemaFlow({ schema }: { schema: StarSchemaData }) {
  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-raised">
      <div className="border-b border-line px-6 pb-3 pt-4">
        <h3 className="font-display text-[17px] tracking-[-0.01em] text-ink">{schema.name}</h3>
        {schema.grain && (
          <p className="mt-0.5 text-[12.5px] text-muted">
            <span title="What one row of the measures table represents (e.g. one order line).">Grain:</span> {schema.grain}
          </p>
        )}
        <p className="mt-1 text-[11.5px] text-muted-2">
          {schema.tables.length} tables · {schema.relationships.length} links · every line joins on the named
          fields at both ends — <span className="font-mono">1</span> side has one row,{' '}
          <span className="font-mono">∗</span> side has many · click a table to focus its connections
        </p>
      </div>
      <ReactFlowProvider>
        <StarSchemaFlowInner schema={schema} />
      </ReactFlowProvider>
    </div>
  );
}
