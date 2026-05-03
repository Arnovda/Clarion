'use client';

/**
 * Dedicated canvas for "click a table → see it centred with its direct
 * neighbours". Lives outside RelationshipCanvas so it doesn't fight that
 * 2k-line component's existing whole-schema state machine (search, drag-
 * to-add-relationship, draft review, custom-view mode, dagre, etc.).
 *
 * Design goals & how each is achieved:
 *   1. Focused table sits dead-centre of the visible canvas.
 *      → We layout the focused at flow coord (0, 0) and compute the
 *        default viewport ourselves, centred on that point. No reliance
 *        on `fitView` (which centres on bbox, not on the focused).
 *   2. All directly-related tables are visible without panning.
 *      → We compute the bbox of every node from deterministic heights
 *        (HEADER_H + cols × ROW_H), pick a zoom that fits 2× the half-
 *        extent on each axis into the container, and use `defaultViewport`
 *        so the very first paint already lands correctly.
 *   3. No unrelated tables.
 *      → The parent only passes us the focused table + its neighbours.
 *   4. Tight, readable cluster.
 *      → Radius is the smallest value that prevents box-on-box collisions
 *        and keeps adjacent neighbour chords > NODE_W + 30 px apart.
 *
 * The component never calls fitView or setCenter — viewport is set once
 * via `defaultViewport` and recomputed on container resize via a ref +
 * `setViewport`. This eliminates the timing race that plagued earlier
 * attempts to retrofit focus mode onto RelationshipCanvas.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background, ConnectionMode, Controls, MiniMap, ReactFlowProvider, useReactFlow,
  type Node, type Edge,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  TableNode, HEADER_H, NODE_W, ROW_H,
} from '@/components/semantic/RelationshipCanvas';
import type { SourceTable, SourceColumn } from '@/components/semantic/types';
import type { RelationshipRow } from './useSchema';

// ── Layout constants ─────────────────────────────────────────────────────
const MIN_GAP = 60;            // px between focused box and any neighbour box
const CHORD_GAP = NODE_W + 30; // min px between adjacent neighbour centres on the chord
const PAD = 0.18;              // 18 % padding around the cluster on each axis

// ── Layout helpers ───────────────────────────────────────────────────────
/**
 * Columns we actually render in focus mode: only the ones that participate
 * in a relationship we're drawing. Showing every column for a 30-column
 * table makes the node ~960 px tall, which forces the cluster radius huge
 * and the zoom drops to ~0.25 — text becomes unreadable. With FK-only
 * columns, each node is 4 rows tall at most, and the cluster fits at near-
 * 1.0 zoom.
 */
function compactColumns(
  t: SourceTable,
  columnsByTable: Record<number, SourceColumn[]>,
  relationshipColIds: Set<number>,
): SourceColumn[] {
  const all = columnsByTable[t.id] ?? [];
  return all.filter((c) => relationshipColIds.has(c.id));
}

function tableHeight(rowCount: number): number {
  return HEADER_H + rowCount * ROW_H;
}

interface Layout {
  positions: Map<number, { x: number; y: number }>;  // node centre, not top-left
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

function computeLayout(
  focused: SourceTable,
  neighbours: SourceTable[],
  rowCounts: Map<number, number>,    // pre-computed visible-row count per table id
): Layout {
  const positions = new Map<number, { x: number; y: number }>();

  const focusH = tableHeight(rowCounts.get(focused.id) ?? 0);
  positions.set(focused.id, { x: 0, y: 0 });

  const N = neighbours.length;
  if (N === 0) {
    return {
      positions,
      bbox: { minX: -NODE_W / 2, minY: -focusH / 2, maxX: NODE_W / 2, maxY: focusH / 2 },
    };
  }

  const maxNeighbourH = Math.max(
    HEADER_H + ROW_H,
    ...neighbours.map((t) => tableHeight(rowCounts.get(t.id) ?? 0)),
  );
  // Clearance: focus half-size + neighbour half-size + MIN_GAP, on both axes.
  const clearance = Math.max(
    NODE_W + MIN_GAP,
    (focusH + maxNeighbourH) / 2 + MIN_GAP,
  );
  // Chord constraint: neighbours separated by 2π/N on a full circle, so
  // chord = 2R·sin(π/N). Solve for R.
  const chordR = N > 1 ? CHORD_GAP / (2 * Math.sin(Math.PI / N)) : 0;
  const radius = Math.max(clearance, chordR);

  // Angle distribution: evenly around the full circle so the bbox is
  // symmetric around the focused (focused = bbox centre).
  // For N=1 we use angle 0 (right of focus) — bbox isn't symmetric in x
  // for that case but the picture is still useful.
  // For N≥2 we start at -π and step 2π/N so the cluster wraps fully.
  const startAngle = N === 1 ? 0 : -Math.PI;
  const step = N === 1 ? 0 : (2 * Math.PI) / N;

  let minX =  Infinity, minY =  Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  // Include focused in bbox.
  minX = Math.min(minX, -NODE_W / 2);
  maxX = Math.max(maxX,  NODE_W / 2);
  minY = Math.min(minY, -focusH / 2);
  maxY = Math.max(maxY,  focusH / 2);

  for (let i = 0; i < N; i++) {
    const t = neighbours[i];
    const angle = startAngle + i * step;
    const cx = Math.cos(angle) * radius;
    const cy = Math.sin(angle) * radius;
    positions.set(t.id, { x: cx, y: cy });

    const h = tableHeight(rowCounts.get(t.id) ?? 0);
    minX = Math.min(minX, cx - NODE_W / 2);
    maxX = Math.max(maxX, cx + NODE_W / 2);
    minY = Math.min(minY, cy - h / 2);
    maxY = Math.max(maxY, cy + h / 2);
  }

  return { positions, bbox: { minX, minY, maxX, maxY } };
}

/**
 * Compute the ReactFlow viewport tuple (x, y, zoom) that places the focused
 * table at (focusedFlowX, focusedFlowY) at the SCREEN centre of a container
 * of size (cw, ch), with a zoom that keeps the entire bbox inside the
 * container with PAD margin on each side.
 *
 * ReactFlow's viewport math: a flow point (fx, fy) is rendered at screen
 * point (vp.x + fx·zoom, vp.y + fy·zoom). For (0, 0) to land at screen
 * (cw/2, ch/2) at zoom z we need vp = (cw/2, ch/2).
 */
function computeViewport(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  cw: number,
  ch: number,
): { x: number; y: number; zoom: number } {
  // We want the focused (which is at flow 0, 0) to be at screen centre.
  // Half-extent we must fit on each axis = max distance from origin to
  // any bbox corner.
  const halfW = Math.max(Math.abs(bbox.minX), Math.abs(bbox.maxX));
  const halfH = Math.max(Math.abs(bbox.minY), Math.abs(bbox.maxY));

  // Zoom so 2 × halfW fits in cw × (1 - 2·PAD), same on Y.
  const usableW = cw * (1 - 2 * PAD);
  const usableH = ch * (1 - 2 * PAD);
  const zoomX = halfW > 0 ? usableW / (2 * halfW) : 1;
  const zoomY = halfH > 0 ? usableH / (2 * halfH) : 1;
  const zoom = Math.max(0.2, Math.min(1.0, zoomX, zoomY));

  // For flow point (0,0) to render at screen centre (cw/2, ch/2) the
  // viewport translate must equal (cw/2, ch/2).
  return { x: cw / 2, y: ch / 2, zoom };
}

// ── Inner component (inside ReactFlowProvider) ───────────────────────────
interface Props {
  focused:        SourceTable;
  neighbours:     SourceTable[];
  relationships:  RelationshipRow[];
  columnsByTable: Record<number, SourceColumn[]>;
}

function Inner({ focused, neighbours, relationships, columnsByTable }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { setViewport } = useReactFlow();
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Watch the container so we can recompute viewport on resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The set of columns we'll render — only those that participate in a
  // relationship being drawn. Keeps wide tables (e.g. "General Ledger
  // Accounts" with 30+ columns) from blowing the cluster radius out.
  const relColIds = useMemo(() => {
    const s = new Set<number>();
    for (const r of relationships) {
      if (r.from_column_id) s.add(r.from_column_id);
      if (r.to_column_id)   s.add(r.to_column_id);
    }
    return s;
  }, [relationships]);

  // Per-table visible columns + row counts (used by both layout + render).
  const visibleCols = useMemo(() => {
    const m = new Map<number, SourceColumn[]>();
    const all = [focused, ...neighbours];
    for (const t of all) {
      m.set(t.id, compactColumns(t, columnsByTable, relColIds));
    }
    return m;
  }, [focused, neighbours, columnsByTable, relColIds]);

  const rowCounts = useMemo(() => {
    const m = new Map<number, number>();
    visibleCols.forEach((cols, id) => m.set(id, cols.length));
    return m;
  }, [visibleCols]);

  const layout = useMemo(
    () => computeLayout(focused, neighbours, rowCounts),
    [focused, neighbours, rowCounts],
  );

  // Build ReactFlow nodes. Position is top-left, so subtract half-size
  // from the centre we computed.
  const nodes = useMemo<Node[]>(() => {
    const all = [focused, ...neighbours];
    return all.map((t) => {
      const centre = layout.positions.get(t.id) ?? { x: 0, y: 0 };
      const cols = visibleCols.get(t.id) ?? [];
      const h = tableHeight(cols.length);
      return {
        id: String(t.id),
        type: 'tableNode',
        position: { x: centre.x - NODE_W / 2, y: centre.y - h / 2 },
        // Setting these helps ReactFlow lay out edges before DOM measurement.
        width: NODE_W,
        height: h,
        data: {
          table: t,
          columns: cols,
          allColumnCount: (columnsByTable[t.id] ?? []).length,
          relCount: relationships.filter(
            (r) => r.from_table_id === t.id || r.to_table_id === t.id,
          ).length,
          searchDimmed: false,
          focused: t.id === focused.id,
          focusColId: null,
          pairedColIds: new Set<number>(),
          colSideMap: new Map<number, 'N' | '1'>(),
          onSelectTable: () => { /* read-only here */ },
          onSelectColumn: () => { /* read-only here */ },
        },
      };
    });
  }, [focused, neighbours, columnsByTable, relationships, layout.positions, visibleCols]);

  // Edges connect to the column-level handle when we know which column is
  // the FK (matches the handle ids the TableNode renders). Falls back to
  // the table-level handle when columns aren't known. Side (left vs right
  // of the box) is picked based on which side of the focused the neighbour
  // sits on, so edges don't loop back through nodes.
  const edges = useMemo<Edge[]>(() => {
    // Match the handle ids TableNode renders: `L_<id>` and `R_<id>`, where
    // <id> is either a column id or the literal string 'table' for the
    // table-level handle.
    const handleId = (side: 'l' | 'r', key: number | 'table') =>
      `${side === 'l' ? 'L' : 'R'}_${key}`;
    return relationships.map((r) => {
      const srcCentre = layout.positions.get(r.from_table_id);
      const tgtCentre = layout.positions.get(r.to_table_id);
      const srcIsRight = srcCentre && tgtCentre ? srcCentre.x > tgtCentre.x : false;
      const srcKey: number | 'table' = r.from_column_id ?? 'table';
      const tgtKey: number | 'table' = r.to_column_id   ?? 'table';
      return {
        id: `rel-${r.id}`,
        source: String(r.from_table_id),
        target: String(r.to_table_id),
        sourceHandle: srcIsRight ? handleId('l', srcKey) : handleId('r', srcKey),
        targetHandle: srcIsRight ? handleId('r', tgtKey) : handleId('l', tgtKey),
        animated: false,
        style: { stroke: '#0e7490', strokeWidth: 1.5 },
      };
    });
  }, [relationships, layout.positions]);

  // Recompute viewport whenever layout or container size changes.
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    const vp = computeViewport(layout.bbox, size.w, size.h);
    setViewport(vp, { duration: 0 });
  }, [layout.bbox, size.w, size.h, setViewport]);

  // First-paint default viewport (used until the resize observer fires).
  const defaultViewport = useMemo(() => {
    if (size.w > 0 && size.h > 0) return computeViewport(layout.bbox, size.w, size.h);
    return { x: 600, y: 400, zoom: 0.8 };
  }, [layout.bbox, size.w, size.h]);

  return (
    <div ref={containerRef} className="flex-1 relative" style={{ height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        defaultViewport={defaultViewport}
        minZoom={0.2}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // TableNode renders both ends of every handle as `type="source"`,
        // so ReactFlow's default strict mode would refuse to draw any edge
        // between them. Loose mode lets source→source edges render.
        connectionMode={ConnectionMode.Loose}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#e2e8f0" gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => (n.data?.focused ? '#0e7490' : '#94a3b8')}
          maskColor="rgba(241,245,249,0.7)"
          style={{ borderRadius: 8, border: '1px solid #e2e8f0' }}
        />
      </ReactFlow>
    </div>
  );
}

const NODE_TYPES = { tableNode: TableNode };

// ── Public component ─────────────────────────────────────────────────────
export default function FocusedClusterView(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
