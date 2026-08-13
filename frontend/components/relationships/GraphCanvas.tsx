'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background, Controls, ReactFlowProvider,
  useNodesState, useEdgesState, useReactFlow, Connection, Node, Edge, ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Loader2, AlertTriangle, CheckCircle2, Flag } from 'lucide-react';
import api from '@/lib/api';
import { TableNode, type TableNodeData } from './TableNode';
import { RelationEdge, EdgeMarkers, type RelationEdgeData } from './RelationEdge';
import { MeasurePanel } from './MeasurePanel';
import { MatchPanel } from './MatchPanel';
import { EdgeInspector } from './EdgeInspector';
import { ValueExplorer, type ValueComparisonResult } from './ValueExplorer';
import { TableList, type TableListLink, type CheckProgress } from './TableList';
import { assignColors, sourceColor } from './sourceColors';
import { outcomeOf } from './MeasurePanel';
import { radialLayout, pairLayout, rankNeighbours, MAX_NEIGHBOURS } from './focusLayout';
import { parseHandle, handleLeft, handleRight, nodeHeight, HEADER_H, NODE_W } from './geometry';
import type {
  GraphResponse, GraphColumn, Measurement, PendingDraw, Cardinality, GraphRelationship,
  MatchMeasurement, PendingMatch, Normalisation,
} from './types';

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface px-1 font-mono text-[10px] uppercase tracking-wider text-muted2">
      {children}
    </kbd>
  );
}

const nodeTypes = { table: TableNode };
const edgeTypes = { relation: RelationEdge };

/**
 * What the canvas is currently about. There is never a third answer, and there is
 * never "everything": a picture of 36 tables and 169 links is a hairball, not a
 * tool, and it is the thing this rebuild exists to remove.
 *
 *  • `pair`   — reviewing ONE relationship: its two tables, side by side.
 *  • `anchor` — exploring ONE table: it in the middle, what it connects to around it.
 */
type Focus =
  | { kind: 'pair'; a: number; b: number }
  | { kind: 'anchor'; id: number };

const EMPTY_IDS: ReadonlySet<number> = new Set<number>();

function CanvasInner() {
  const { fitView } = useReactFlow();
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [draw, setDraw] = useState<PendingDraw | null>(null);
  const [match, setMatch] = useState<PendingMatch | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<number | null>(null);
  const [busy, setBusy] = useState<'confirm' | 'delete' | 'measure' | 'save' | 'flag' | null>(null);
  const [payoff, setPayoff] = useState<string | null>(null);
  const [mode, setMode] = useState<'review' | 'explore'>('review');
  /** The table being worked on: anchored in Explore, expanded in the list always. */
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  /**
   * Narrows the review queue to one table. Set only by an explicit click, never
   * derived from the current item — deriving it would let the queue narrow
   * itself to whatever it happened to land on.
   */
  const [reviewScopeId, setReviewScopeId] = useState<number | null>(null);
  /**
   * Tables showing every column rather than just the ones they connect on.
   * Only drawing a NEW relationship needs the full list; everything else is
   * better served by the join surface alone.
   */
  const [showAll, setShowAll] = useState<Set<number>>(new Set());
  /**
   * A per-table check in flight, and the results that have landed so far.
   *
   * Results are held locally as they arrive rather than reloading the graph per
   * link: a sweep of a hub table is dozens of measurements, and watching them
   * fill in one by one is what makes a thirty-second wait legible instead of a
   * spinner. One reload at the end folds them into the graph proper.
   */
  const [check, setCheck] = useState<CheckProgress | null>(null);
  /** Filter the table list down to what is unresolved. */
  const [onlyAttention, setOnlyAttention] = useState(false);
  /** The side-by-side value comparison, when open. */
  const [values, setValues] = useState<
    { title: string; loading: boolean; result: ValueComparisonResult | null } | null
  >(null);
  const [freshMeasured, setFreshMeasured] = useState<Map<number, Measurement>>(new Map());
  /** Bumped to abandon a sweep the user has navigated away from. */
  const checkRun = useRef(0);

  const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelationEdgeData>([]);

  // Columns come with the graph, so revealing a table's fields is instant. At SMB
  // scale that payload is small, and a per-node round trip would make the one
  // interaction that must feel immediate feel laggy instead.
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get('/relationships/graph?withColumns=1');
      setGraph(res.data.data as GraphResponse);
    } catch {
      setLoadError('Could not load your data relationships. Try again in a moment.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Land on the first thing to review; with nothing pending, open Explore.
   *
   * Once only. Re-running it would drag the user back to Explore the moment they
   * clear the queue, which is exactly when they should be told they are done.
   */
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (!graph || bootstrapped.current) return;
    bootstrapped.current = true;
    const first = graph.relationships.find((r) => r.provenance === 'ai');
    if (first) setSelectedEdgeId(first.id); else setMode('explore');
  }, [graph]);

  /** Explore opens on the most connected table — the hub is what people look for. */
  useEffect(() => {
    if (mode !== 'explore' || !graph || selectedTableId !== null) return;
    const hub = [...graph.tables].sort((a, b) => b.relationshipCount - a.relationshipCount)[0];
    if (hub) setSelectedTableId(hub.id);
  }, [mode, graph, selectedTableId]);

  /**
   * Keep the list pointing at whatever the queue is showing, so "where am I?"
   * is answered without looking for it. This only moves the highlight — the
   * queue's own scope is set by clicking, never by where it happened to land.
   */
  useEffect(() => {
    if (mode !== 'review' || !graph || selectedEdgeId == null) return;
    const rel = graph.relationships.find((r) => r.id === selectedEdgeId);
    if (rel) setSelectedTableId(reviewScopeId ?? rel.fromTableId);
  }, [mode, graph, selectedEdgeId, reviewScopeId]);

  /** A revealed column list belongs to the table you were just looking at. */
  useEffect(() => { setShowAll(new Set()); }, [mode, selectedTableId, selectedEdgeId]);

  const columnsByTable = useMemo(() => {
    const m = new Map<number, GraphColumn[]>();
    for (const c of graph?.columns ?? []) {
      if (!m.has(c.table_id)) m.set(c.table_id, []);
      m.get(c.table_id)!.push(c);
    }
    return m;
  }, [graph]);

  const colorIndexBySource = useMemo(
    () => assignColors(graph?.sources ?? []),
    [graph],
  );
  const colorForConnection = useCallback(
    (connectionId: number) => sourceColor(colorIndexBySource.get(connectionId) ?? 0),
    [colorIndexBySource],
  );

  const columnNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of graph?.columns ?? []) m.set(c.id, c.column_name);
    return m;
  }, [graph]);

  const tableNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of graph?.tables ?? []) m.set(t.id, t.displayName || t.tableName);
    return m;
  }, [graph]);

  /**
   * Tables with something unresolved on them: a raised flag, a measurement the
   * data contradicts, or a suggestion nobody has decided on. Deliberately NOT
   * "anything unchecked" — before the first sweep that would be every table,
   * and a filter that matches everything filters nothing.
   */
  const needsAttention = useMemo(() => {
    const s = new Set<number>();
    for (const r of graph?.relationships ?? []) {
      const o = outcomeOf(freshMeasured.get(r.id) ?? r.measured);
      if (!(r.flagged || r.provenance === 'ai' || o === 'none' || o === 'partial')) continue;
      s.add(r.fromTableId);
      s.add(r.toTableId);
    }
    return s;
  }, [graph, freshMeasured]);

  /** How many of each table's relationships someone marked as a problem. */
  const flaggedByTable = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of graph?.relationships ?? []) {
      if (!r.flagged) continue;
      m.set(r.fromTableId, (m.get(r.fromTableId) ?? 0) + 1);
      if (r.toTableId !== r.fromTableId) m.set(r.toTableId, (m.get(r.toTableId) ?? 0) + 1);
    }
    return m;
  }, [graph]);

  /** How many of each table's relationships nobody has decided on yet. */
  const pendingByTable = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of graph?.relationships ?? []) {
      if (r.provenance !== 'ai') continue;
      m.set(r.fromTableId, (m.get(r.fromTableId) ?? 0) + 1);
      if (r.toTableId !== r.fromTableId) m.set(r.toTableId, (m.get(r.toTableId) ?? 0) + 1);
    }
    return m;
  }, [graph]);

  /** A table's relationships, phrased from that table's side. */
  const linksFor = useCallback((tableId: number): TableListLink[] => {
    const out: TableListLink[] = [];
    for (const r of graph?.relationships ?? []) {
      const outgoing = r.fromTableId === tableId;
      const incoming = r.toTableId === tableId;
      if (!outgoing && !incoming) continue;
      const ownCol = outgoing ? r.fromColumnId : r.toColumnId;
      const otherTable = outgoing ? r.toTableId : r.fromTableId;
      const otherCol = outgoing ? r.toColumnId : r.fromColumnId;
      const otherName = tableNameById.get(otherTable) ?? 'table';
      const otherColName = otherCol != null ? columnNameById.get(otherCol) : null;
      out.push({
        id: r.id,
        ownLabel: (ownCol != null ? columnNameById.get(ownCol) : null) ?? 'this table',
        otherLabel: otherColName ? `${otherName}.${otherColName}` : otherName,
        provenance: r.provenance,
        kind: r.kind,
        isCrossSource: r.isCrossSource,
        measured: freshMeasured.get(r.id) ?? (r.measured as Measurement | null),
        flagged: r.flagged,
        siblingTargets: 0,
      });
    }
    // Grouped by the field they leave from, because that is the question the
    // pane answers ("what does this table connect to, and on which fields?")
    // — and because it puts a column's competing targets side by side. One
    // column pointing at two different targets is the single most common
    // defect in this catalog, and it is invisible when the two rows are
    // scattered: `JournalCode → Journals.Code` at 100% next to
    // `JournalCode → Journals.ID` at 0% needs no explanation at all.
    // Triage ordering is the sidebar's filter's job, not this list's.
    const perColumn = new Map<string, number>();
    for (const l of out) perColumn.set(l.ownLabel, (perColumn.get(l.ownLabel) ?? 0) + 1);
    for (const l of out) l.siblingTargets = perColumn.get(l.ownLabel) ?? 1;

    const rank = { none: 0, partial: 1, unknown: 2, holds: 3 } as const;
    return out.sort((a, b) =>
      a.ownLabel.localeCompare(b.ownLabel)
      || rank[outcomeOf(a.measured)] - rank[outcomeOf(b.measured)]
      || a.otherLabel.localeCompare(b.otherLabel));
  }, [graph, columnNameById, tableNameById, freshMeasured]);

  const toggleAllColumns = useCallback((tableId: number) => {
    setShowAll((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) next.delete(tableId); else next.add(tableId);
      return next;
    });
  }, []);


  /**
   * Check every link on one table against the data.
   *
   * Two at a time, because DuckDB allows two concurrent queries per tenant —
   * more would only queue, while making each one likelier to hit its own
   * budget and come back "could not check".
   *
   * A failed link does not stop the sweep: one unreadable table would
   * otherwise cost you the answer for every other link on the table.
   *
   * `withExamples: false` — the sweep produces a list of pass/fail, and the
   * example values are what you look at afterwards, on the one that failed.
   */
  const runCheck = useCallback(async (
    links: readonly TableListLink[],
    tableId: number | null,
  ) => {
    if (!links.length) return;

    const token = ++checkRun.current;
    setCheck({ tableId, done: 0, total: links.length });

    const queue = [...links];
    const worker = async () => {
      for (;;) {
        const l = queue.shift();
        if (!l || checkRun.current !== token) return;
        try {
          const res = await api.post(`/relationships/${l.id}/check`, { withExamples: false });
          if (checkRun.current !== token) return;
          const m = res.data.data as Measurement;
          setFreshMeasured((prev) => new Map(prev).set(l.id, m));
        } catch {
          /* leave it unchecked; the sweep is worth more than any one link */
        }
        if (checkRun.current !== token) return;
        setCheck((c) => (c ? { ...c, done: c.done + 1 } : c));
      }
    };

    await Promise.all([worker(), worker()]);
    if (checkRun.current !== token) return;
    setCheck(null);
    // Fold the results into the graph, then drop the local copies so there is
    // one source of truth again.
    await load();
    setFreshMeasured(new Map());
  }, [load]);

  const checkTable = useCallback(
    (tableId: number) => runCheck(linksFor(tableId).filter((l) => l.kind !== 'match'), tableId),
    [runCheck, linksFor],
  );

  /**
   * Sweep several tables at once — the way you find out where the problem IS,
   * rather than confirming one you already suspect.
   *
   * Deduped by relationship id: a link appears on both of its tables, and
   * measuring it twice would double the wait for the same answer.
   */
  const checkMany = useCallback((tableIds: readonly number[]) => {
    const seen = new Map<number, TableListLink>();
    for (const id of tableIds) {
      for (const l of linksFor(id)) {
        if (l.kind !== 'match') seen.set(l.id, l);
      }
    }
    return runCheck([...seen.values()], null);
  }, [runCheck, linksFor]);

  const focus: Focus | null = useMemo(() => {
    if (!graph) return null;
    if (mode === 'explore') return selectedTableId != null ? { kind: 'anchor', id: selectedTableId } : null;
    if (selectedEdgeId == null) return null;
    const rel = graph.relationships.find((r) => r.id === selectedEdgeId);
    return rel ? { kind: 'pair', a: rel.fromTableId, b: rel.toTableId } : null;
  }, [graph, mode, selectedTableId, selectedEdgeId]);

  /**
   * The neighbours that make the ring, in the order they are placed around it.
   *
   * Chosen by how many links they share with the anchor — "most strongly related"
   * is what someone exploring means — then re-sorted so tables from the same
   * source sit next to each other. A ring that alternates sources makes the
   * colour spine useless; a ring that groups them makes "this half is Exact" a
   * thing you see rather than read.
   */
  const { neighbours, neighbourTotal } = useMemo(() => {
    if (!graph || focus?.kind !== 'anchor') return { neighbours: [] as number[], neighbourTotal: 0 };
    const seen = new Set<number>();
    for (const r of graph.relationships) {
      if (r.fromTableId === focus.id && r.toTableId !== focus.id) seen.add(r.toTableId);
      if (r.toTableId === focus.id && r.fromTableId !== focus.id) seen.add(r.fromTableId);
    }
    const known = [...seen].filter((id) => graph.tables.some((t) => t.id === id));
    const ranked = rankNeighbours(focus.id, graph.relationships, known).slice(0, MAX_NEIGHBOURS);

    const tableById = new Map(graph.tables.map((t) => [t.id, t]));
    const placed = [...ranked].sort((a, b) => {
      const ta = tableById.get(a)!; const tb = tableById.get(b)!;
      return (colorIndexBySource.get(ta.connectionId) ?? 0) - (colorIndexBySource.get(tb.connectionId) ?? 0)
        || (ta.displayName || ta.tableName).localeCompare(tb.displayName || tb.tableName);
    });
    return { neighbours: placed, neighbourTotal: known.length };
  }, [graph, focus, colorIndexBySource]);

  const visibleIds = useMemo(() => {
    if (!focus) return EMPTY_IDS;
    return focus.kind === 'pair'
      ? new Set([focus.a, focus.b])
      : new Set([focus.id, ...neighbours]);
  }, [focus, neighbours]);

  /**
   * Only lines that touch what the view is about. A neighbour's own
   * relationships are not this view's subject, and drawing them is what turned
   * 169 links into an unreadable scribble.
   */
  const drawnRels = useMemo(() => {
    if (!graph || !focus) return [] as GraphRelationship[];
    if (focus.kind === 'pair') {
      return graph.relationships.filter((r) =>
        (r.fromTableId === focus.a && r.toTableId === focus.b)
        || (r.fromTableId === focus.b && r.toTableId === focus.a));
    }
    return graph.relationships.filter((r) =>
      (r.fromTableId === focus.id && visibleIds.has(r.toTableId))
      || (r.toTableId === focus.id && visibleIds.has(r.fromTableId)));
  }, [graph, focus, visibleIds]);

  /**
   * Per table: exactly which columns to render, and how tall that makes it.
   *
   * A table shows the fields it CONNECTS ON. Forty columns buries the answer to
   * the only question being asked; zero columns makes you click to find it. The
   * join surface is both the answer and small.
   */
  const nodeSpec = useMemo(() => {
    const linked = new Map<number, Set<number>>();
    const add = (t: number, c: number) => {
      if (!linked.has(t)) linked.set(t, new Set());
      linked.get(t)!.add(c);
    };
    for (const r of drawnRels) {
      if (r.fromColumnId != null) add(r.fromTableId, r.fromColumnId);
      if (r.toColumnId != null) add(r.toTableId, r.toColumnId);
    }

    const out = new Map<number, {
      columns: GraphColumn[]; hiddenCount: number; showingAll: boolean; height: number;
    }>();
    for (const id of visibleIds) {
      const all = columnsByTable.get(id) ?? [];
      const lit = linked.get(id) ?? EMPTY_IDS;
      const linkedCols = all.filter((c) => lit.has(c.id));
      const canToggle = all.length > linkedCols.length;
      const showingAll = canToggle && showAll.has(id);
      const columns = showingAll ? all : linkedCols;
      const hiddenCount = all.length - columns.length;
      out.set(id, {
        columns,
        hiddenCount,
        showingAll,
        height: nodeHeight(columns.length, hiddenCount > 0 || showingAll),
      });
    }
    return out;
  }, [drawnRels, visibleIds, columnsByTable, showAll]);

  const positions = useMemo(() => {
    const heightOf = (id: number) => nodeSpec.get(id)?.height ?? HEADER_H;
    if (!focus) return new Map<number, { x: number; y: number }>();
    if (focus.kind === 'anchor') return radialLayout(focus.id, neighbours, heightOf).positions;
    // A self-referencing relationship has one table, not two.
    if (focus.a === focus.b) {
      return new Map([[focus.a, { x: -NODE_W / 2, y: -heightOf(focus.a) / 2 }]]);
    }
    return pairLayout(focus.a, focus.b, heightOf).positions;
  }, [focus, neighbours, nodeSpec]);

  /** Both ends of the relationship being inspected, lit up in their tables. */
  const highlightColumnIds = useMemo(() => {
    const rel = selectedEdgeId != null
      ? graph?.relationships.find((r) => r.id === selectedEdgeId)
      : null;
    const s = new Set<number>();
    if (rel?.fromColumnId != null) s.add(rel.fromColumnId);
    if (rel?.toColumnId != null) s.add(rel.toColumnId);
    return s;
  }, [graph, selectedEdgeId]);

  // Rebuild nodes and edges whenever the focus, layout or selection changes.
  useEffect(() => {
    if (!graph || !focus) { setNodes([]); setEdges([]); return; }

    const focusedId = focus.kind === 'anchor' ? focus.id : null;

    const tableNodes = graph.tables
      .filter((t) => visibleIds.has(t.id))
      .map((t) => {
        const spec = nodeSpec.get(t.id)!;
        return {
          id: String(t.id),
          type: 'table',
          position: positions.get(t.id) ?? { x: 0, y: 0 },
          draggable: true,
          data: {
            tableId: t.id,
            label: t.displayName || t.tableName,
            relationshipCount: t.relationshipCount,
            sourceColor: colorForConnection(t.connectionId),
            columns: spec.columns,
            hiddenCount: spec.hiddenCount,
            highlightColumnIds,
            showingAll: spec.showingAll,
            dimmed: false,
            focused: focusedId === t.id,
            onToggleAllColumns: toggleAllColumns,
          },
        } satisfies Node<TableNodeData>;
      });

    setNodes(tableNodes);

    setEdges(drawnRels.map((r) => {
      // Which side each end leaves from follows the geometry: a neighbour to the
      // left of the anchor is reached from the anchor's left edge. Fixed
      // right-to-left handles made every edge on the left half sweep all the way
      // around the node.
      const fromX = positions.get(r.fromTableId)?.x ?? 0;
      const toX = positions.get(r.toTableId)?.x ?? 0;
      const leftToRight = fromX <= toX;
      const fromShown = nodeSpec.get(r.fromTableId)?.columns.some((c) => c.id === r.fromColumnId);
      const toShown = nodeSpec.get(r.toTableId)?.columns.some((c) => c.id === r.toColumnId);

      const sourceHandle = leftToRight
        ? handleRight(fromShown ? r.fromColumnId! : 'table')
        : handleLeft(fromShown ? r.fromColumnId! : 'table');
      const targetHandle = leftToRight
        ? handleLeft(toShown ? r.toColumnId! : 'table')
        : handleRight(toShown ? r.toColumnId! : 'table');

      return {
        id: String(r.id),
        source: String(r.fromTableId),
        target: String(r.toTableId),
        sourceHandle,
        targetHandle,
        type: 'relation',
        data: {
          kind: r.kind,
          provenance: r.provenance,
          isCrossSource: r.isCrossSource,
          cardinality: (r.relationshipType as Cardinality) ?? null,
          matchRate: r.kind === 'match'
            ? ((r.measured as unknown as MatchMeasurement | null)?.matchRate ?? null)
            : null,
          outcome: outcomeOf(freshMeasured.get(r.id) ?? r.measured),
          flagged: r.flagged,
          dimmed: mode === 'review' && selectedEdgeId != null && r.id !== selectedEdgeId,
        },
        selected: r.id === selectedEdgeId,
      } satisfies Edge<RelationEdgeData>;
    }));
  }, [graph, focus, visibleIds, drawnRels, nodeSpec, positions, highlightColumnIds,
      colorForConnection, toggleAllColumns, mode, selectedEdgeId, freshMeasured,
      setNodes, setEdges]);

  useEffect(() => {
    if (!nodes.length) return;
    // A frame's delay lets ReactFlow measure the new nodes first; fitting before
    // that uses stale sizes and lands off-centre.
    const t = setTimeout(() => fitView({ padding: 0.18, maxZoom: 1, duration: 300 }), 60);
    return () => clearTimeout(t);
  }, [nodes.length, mode, selectedTableId, selectedEdgeId, fitView]);

  const labelFor = useCallback((tableId: number, columnId: number | null) => {
    const t = graph?.tables.find((x) => x.id === tableId);
    const c = columnsByTable.get(tableId)?.find((x) => x.id === columnId);
    return `${t?.displayName || t?.tableName || 'table'}${c ? `.${c.column_name}` : ''}`;
  }, [graph, columnsByTable]);

  /** Compare two sources on the chosen columns, then show the result. */
  const runMatch = useCallback(async (pending: PendingMatch) => {
    setMatch(pending);
    try {
      const res = await api.post('/relationships/match-preview', {
        fromTableId: pending.fromTableId,
        fromColumnId: pending.fromColumnId,
        toTableId: pending.toTableId,
        toColumnId: pending.toColumnId,
        normalisation: pending.normalisation,
      });
      const measurement = res.data.data as MatchMeasurement;
      setMatch((prev) => (prev && prev.fromColumnId === pending.fromColumnId
        ? { ...prev, measurement } : prev));
    } catch {
      setMatch((prev) => (prev && prev.fromColumnId === pending.fromColumnId
        ? { ...prev, error: 'Could not compare those two sources.' } : prev));
    }
  }, []);

  const keepMatch = useCallback(async () => {
    if (!match) return;
    setSaving(true);
    try {
      await api.post('/semantic/relationships', {
        from_table_id: match.fromTableId,
        from_column_id: match.fromColumnId,
        to_table_id: match.toTableId,
        to_column_id: match.toColumnId,
        // Stored as a match, never as a join: the AI must phrase it as an
        // identity assertion rather than a JOIN instruction.
        kind: 'match',
        relationship_type: 'many_to_many',
        match_keys: {
          normalisation: match.normalisation,
          fromColumnId: match.fromColumnId,
          toColumnId: match.toColumnId,
        },
        measured: match.measurement,
        description: null,
      });
      setMatch(null);
      setPayoff('Clarion now knows these describe the same things across both sources.');
      await load();
    } catch {
      setMatch((prev) => prev ? { ...prev, error: 'Could not save this link. Try again.' } : prev);
    } finally {
      setSaving(false);
    }
  }, [match, load]);

  /**
   * A drawn connection measures before it saves. Nothing is written until the
   * user chooses to keep it, so an exploratory drag costs nothing.
   */
  const onConnect = useCallback(async (c: Connection) => {
    const fromTableId = Number(c.source);
    const toTableId = Number(c.target);
    const fromColumnId = parseHandle(c.sourceHandle);
    const toColumnId = parseHandle(c.targetHandle);

    if (!fromColumnId || !toColumnId) {
      // Both ends must name a column: a relationship between two tables with no
      // columns cannot express a join. Say so rather than failing silently.
      setDraw({
        fromTableId, toTableId, fromColumnId: 0, toColumnId: 0,
        fromLabel: labelFor(fromTableId, fromColumnId),
        toLabel: labelFor(toTableId, toColumnId),
        measurement: null,
        error: 'Drag between two specific fields — use "more fields" on each table to see them all.',
      });
      return;
    }

    // A link inside one source is a JOIN, verified by containment. A link
    // between two sources is a MATCH — an assertion that both sides describe the
    // same real things, verified by how many rows find a partner. Different
    // questions, so different panels; asking one with the other's question is
    // what makes cross-system look easy and then be wrong.
    const fromConn = graph?.tables.find((t) => t.id === fromTableId)?.connectionId;
    const toConn = graph?.tables.find((t) => t.id === toTableId)?.connectionId;
    if (fromConn != null && toConn != null && fromConn !== toConn) {
      void runMatch({
        fromTableId, fromColumnId, toTableId, toColumnId,
        fromLabel: labelFor(fromTableId, fromColumnId),
        toLabel: labelFor(toTableId, toColumnId),
        normalisation: 'loose',
        measurement: null,
        error: null,
      });
      return;
    }

    setDraw({
      fromTableId, fromColumnId, toTableId, toColumnId,
      fromLabel: labelFor(fromTableId, fromColumnId),
      toLabel: labelFor(toTableId, toColumnId),
      measurement: null,
      error: null,
    });

    try {
      const res = await api.post('/relationships/measure', {
        fromTableId, fromColumnId, toTableId, toColumnId,
      });
      const measurement = res.data.data as Measurement;
      setDraw((prev) => (prev && prev.fromColumnId === fromColumnId ? { ...prev, measurement } : prev));
    } catch (err) {
      const code = (err as { response?: { data?: { code?: string; error?: string } } })?.response?.data;
      setDraw((prev) => prev && prev.fromColumnId === fromColumnId
        ? {
            ...prev,
            error: code?.code === 'cross_source_unsupported'
              ? 'Linking two different sources is coming soon — for now you can only relate tables within one source.'
              : (code?.error ?? 'Could not check this against your data.'),
          }
        : prev);
    }
  }, [labelFor, graph, runMatch]);

  const keepDrawn = useCallback(async () => {
    if (!draw) return;
    setSaving(true);
    try {
      // snake_case: this is what createRelationshipSchema validates. The
      // measured cardinality is stored as the type, so the graph reflects what
      // the data says rather than what anyone assumed.
      await api.post('/semantic/relationships', {
        from_table_id: draw.fromTableId,
        from_column_id: draw.fromColumnId,
        to_table_id: draw.toTableId,
        to_column_id: draw.toColumnId,
        relationship_type: draw.measurement?.cardinality?.type ?? 'many_to_one',
        description: null,
      });
      setDraw(null);
      await load();
    } catch {
      setDraw((prev) => prev ? { ...prev, error: 'Could not save this relationship. Try again.' } : prev);
    } finally {
      setSaving(false);
    }
  }, [draw, load]);

  const compareValues = useCallback(async (rel: GraphRelationship, title: string) => {
    setValues({ title, loading: true, result: null });
    try {
      const res = await api.get(`/relationships/${rel.id}/values`);
      setValues((v) => (v ? { ...v, loading: false, result: res.data.data } : v));
    } catch {
      setValues((v) => (v
        ? { ...v, loading: false, result: { ok: false, reason: 'query-failed', left: null, right: null, limit: 0 } }
        : v));
    }
  }, []);

  const selectedRel: GraphRelationship | null = selectedEdgeId != null
    ? graph?.relationships.find((r) => r.id === selectedEdgeId) ?? null
    : null;

  /**
   * Relationships still awaiting a human, in the order the canvas walks them.
   * This is the queue — J and K step through it without the user hunting for
   * dashed lines by eye.
   */
  const pendingQueue = useMemo(() => {
    const pending = (graph?.relationships ?? []).filter((r) => r.provenance === 'ai');
    const scoped = reviewScopeId == null
      ? pending
      : pending.filter((r) => r.fromTableId === reviewScopeId || r.toTableId === reviewScopeId);
    return scoped.map((r) => r.id);
  }, [graph, reviewScopeId]);

  /**
   * Picking a table is the main gesture, and it means the same thing in both
   * modes: *this* is the table I am working on. In Explore that re-centres the
   * ring; in Review it narrows the queue to that table's suggestions, which is
   * how someone goes over one table rather than the whole catalog in whatever
   * order it came back in.
   */
  const pickTable = useCallback((tableId: number) => {
    // Abandon a sweep of the table being left: its progress line is attached to
    // that table, so letting it run on would report into a collapsed row.
    // Only a single-table sweep belongs to the table being left. A run over
    // several tables is not attached to any one row, so leaving does not
    // abandon it.
    if (check && check.tableId !== null && check.tableId !== tableId) {
      checkRun.current += 1;
      setCheck(null);
    }
    setSelectedTableId(tableId);
    if (mode !== 'review') return;
    setReviewScopeId(tableId);
    const links = linksFor(tableId);
    const next = links.find((l) => l.provenance === 'ai') ?? links[0];
    setSelectedEdgeId(next ? next.id : null);
  }, [mode, linksFor, check]);

  const queuePosition = (() => {
    if (mode !== 'review' || selectedEdgeId == null) return null;
    const at = pendingQueue.indexOf(selectedEdgeId);
    return at === -1 ? null : `${at + 1}/${pendingQueue.length}`;
  })();

  const step = useCallback((delta: number) => {
    if (pendingQueue.length === 0) return;
    const at = selectedEdgeId != null ? pendingQueue.indexOf(selectedEdgeId) : -1;
    const next = at === -1
      ? (delta > 0 ? 0 : pendingQueue.length - 1)
      : (at + delta + pendingQueue.length) % pendingQueue.length;
    setSelectedEdgeId(pendingQueue[next]);
  }, [pendingQueue, selectedEdgeId]);

  /** After deciding, land on the next item rather than on nothing. */
  const advance = useCallback((decidedId: number) => {
    const at = pendingQueue.indexOf(decidedId);
    const rest = pendingQueue.filter((id) => id !== decidedId);
    setSelectedEdgeId(rest.length ? rest[Math.min(Math.max(at, 0), rest.length - 1)] : null);
  }, [pendingQueue]);

  const confirmRel = useCallback(async (rel: GraphRelationship) => {
    setBusy('confirm');
    try {
      // An empty PATCH is a valid confirm — the server flips ai_draft and
      // stamps confirmed_by_user, which is what makes it survive a re-profile.
      await api.patch(`/semantic/relationships/${rel.id}`, {
        ...(rel.measured ? { measured: rel.measured } : {}),
      });
      // Close the loop: the point of this pane is AI context, so say what the
      // confirmation bought. Without it people draw lines on faith.
      setPayoff(rel.isCrossSource
        ? 'Clarion now knows these describe the same things across both sources.'
        : 'Ask AI can now use this link when answering questions.');
      advance(rel.id);
      await load();
    } finally {
      setBusy(null);
    }
  }, [load, advance]);

  const deleteRel = useCallback(async (rel: GraphRelationship) => {
    setBusy('delete');
    try {
      await api.delete(`/semantic/relationships/${rel.id}`);
      advance(rel.id);
      await load();
    } finally {
      setBusy(null);
    }
  }, [load, advance]);

  const saveDescription = useCallback(async (rel: GraphRelationship, text: string) => {
    setBusy('save');
    try {
      await api.patch(`/semantic/relationships/${rel.id}`, { description: text });
      await load();
    } finally {
      setBusy(null);
    }
  }, [load]);

  const remeasure = useCallback(async (rel: GraphRelationship) => {
    if (!rel.fromColumnId || !rel.toColumnId) return;
    setBusy('measure');
    try {
      // Measure AND cache in one call. This used to POST /measure and then
      // PATCH the row — but that PATCH handler treats any patch as a person
      // acting on the relationship: it stamps confirmed_by_user and clears
      // ai_draft. So asking "does this still hold?" silently confirmed an AI
      // suggestion nobody had looked at, and quietly removed it from the
      // review queue. Checking is not deciding.
      await api.post(`/relationships/${rel.id}/check`, { withExamples: true });
      await load();
    } catch {
      /* the inspector keeps showing whatever it had; a failed check is not a
         reason to lose the panel */
    } finally {
      setBusy(null);
    }
  }, [load]);

  const changeType = useCallback(async (rel: GraphRelationship, type: string) => {
    setBusy('save');
    try {
      await api.patch(`/semantic/relationships/${rel.id}`, { relationship_type: type });
      await load();
    } finally {
      setBusy(null);
    }
  }, [load]);

  /**
   * Raise or clear a flag.
   *
   * Deliberately its own endpoint rather than a PATCH: flagging is an
   * observation about the data, and the PATCH handler treats any write as a
   * person deciding the relationship is correct.
   */
  const flagRel = useCallback(async (rel: GraphRelationship, flagged: boolean, reason: string) => {
    setBusy('flag');
    try {
      await api.post(`/relationships/${rel.id}/flag`, { flagged, reason: reason || null });
      if (flagged) setPayoff('Flagged. Clarion will stop using this link until you clear it.');
      await load();
    } finally {
      setBusy(null);
    }
  }, [load]);

  const changeColumns = useCallback(async (rel: GraphRelationship, change: { from?: number; to?: number }) => {
    setBusy('save');
    try {
      await api.patch(`/semantic/relationships/${rel.id}`, {
        ...(change.from !== undefined ? { from_column_id: change.from } : {}),
        ...(change.to !== undefined ? { to_column_id: change.to } : {}),
      });
      // The old measurement described different columns, so it is now wrong.
      // Clearing it is more honest than leaving a stale number on screen.
      await api.patch(`/semantic/relationships/${rel.id}`, { measured: null });
      await load();
    } finally {
      setBusy(null);
    }
  }, [load]);

  /**
   * Keyboard model. Reviewing is repetitive, so the hand should not have to
   * leave the keys — and shortcuts must never fire while someone is typing a
   * description, which is why the target is checked first.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case 'j': case 'J': e.preventDefault(); step(1); break;
        case 'k': case 'K': e.preventDefault(); step(-1); break;
        case 'y': case 'Y':
          if (selectedRel && busy === null) { e.preventDefault(); void confirmRel(selectedRel); }
          break;
        case 'n': case 'N':
          if (selectedRel && busy === null) { e.preventDefault(); void deleteRel(selectedRel); }
          break;
        case '/':
          e.preventDefault();
          document.getElementById('rel-search')?.focus();
          break;
        case 'Escape':
          setDraw(null); setMatch(null);
          break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, selectedRel, busy, confirmRel, deleteRel, mode]);

  // Payoff is a transient acknowledgement, not a notification to dismiss.
  useEffect(() => {
    if (!payoff) return;
    const t = setTimeout(() => setPayoff(null), 5000);
    return () => clearTimeout(t);
  }, [payoff]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted">
        <Loader2 size={15} className="animate-spin" />
        Loading how your data fits together…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink2">
        <AlertTriangle size={15} className="text-warn" />
        {loadError}
      </div>
    );
  }

  const stats = graph?.stats;
  const health = (() => {
    let checked = 0; let bad = 0;
    for (const r of graph?.relationships ?? []) {
      const o = outcomeOf(freshMeasured.get(r.id) ?? r.measured);
      if (o === 'unknown') continue;
      checked += 1;
      if (o !== 'holds') bad += 1;
    }
    return { checked, bad };
  })();
  const anchorTable = focus?.kind === 'anchor'
    ? graph?.tables.find((t) => t.id === focus.id) ?? null
    : null;
  const reviewEmpty = mode === 'review' && !focus;
  const scopeTable = reviewScopeId != null
    ? graph?.tables.find((t) => t.id === reviewScopeId) ?? null
    : null;

  return (
    <div className="flex h-full">
      {/* Always present, in both modes. It is how you choose what to work on;
          without it the canvas decides for you and there is nothing to click. */}
      {graph && (
        <TableList
          tables={graph.tables}
          sources={graph.sources}
          colorFor={colorForConnection}
          pendingByTable={pendingByTable}
          flaggedByTable={flaggedByTable}
          selectedTableId={selectedTableId}
          selectedEdgeId={selectedEdgeId}
          linksFor={linksFor}
          check={check}
          needsAttention={needsAttention}
          onlyAttention={onlyAttention}
          onToggleAttention={() => setOnlyAttention((v) => !v)}
          onCheckMany={(ids) => void checkMany(ids)}
          search={search}
          onSearch={setSearch}
          onPickTable={pickTable}
          onPickLink={setSelectedEdgeId}
          onCheckTable={checkTable}
        />
      )}
      <div className="relative min-w-0 flex-1">
      <EdgeMarkers />

      {/* Toolbar */}
      <div className="absolute left-4 right-4 top-4 z-10 flex items-center gap-3">
        {/* Mode is a real switch, not a filter: deciding on one link and looking
            around are different jobs, and conflating them is what produced a
            wall of unreadable nodes. */}
        <div className="flex items-center rounded-xl border border-line bg-raised/95 p-0.5 shadow-sm backdrop-blur">
          {(['review', 'explore'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                // Coming back to Review with nothing selected should land on the
                // queue, not on the "all done" card.
                if (m === 'review' && selectedEdgeId == null && pendingQueue.length) {
                  setSelectedEdgeId(pendingQueue[0]);
                }
              }}
              className={`rounded-[10px] px-2.5 py-1 text-[12.5px] transition-colors ${
                mode === m ? 'bg-ocean text-white' : 'text-ink2 hover:bg-soft'
              }`}
            >
              {m === 'review' ? 'Review' : 'Explore'}
              {m === 'review' && queuePosition && (
                <span className={`ml-1.5 tabular-nums ${mode === m ? 'text-white/80' : 'text-muted'}`}>
                  {queuePosition}
                </span>
              )}
            </button>
          ))}
        </div>

        {anchorTable && (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-raised/95 px-3 py-1.5 text-[12.5px] text-ink2 shadow-sm backdrop-blur">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: colorForConnection(anchorTable.connectionId) }}
            />
            What <span className="font-medium text-ink">{anchorTable.displayName || anchorTable.tableName}</span> connects to
            {neighbourTotal > neighbours.length && (
              <span className="text-muted">
                · showing {neighbours.length} of {neighbourTotal}
              </span>
            )}
          </div>
        )}

        {/* Say when the queue is narrowed, and make widening it one click — a
            filter you cannot see is a filter you get stuck in. */}
        {mode === 'review' && scopeTable && (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-raised/95 py-1.5 pl-3 pr-1.5 text-[12.5px] text-ink2 shadow-sm backdrop-blur">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: colorForConnection(scopeTable.connectionId) }}
            />
            Going through <span className="font-medium text-ink">{scopeTable.displayName || scopeTable.tableName}</span>
            <button
              type="button"
              onClick={() => {
                setReviewScopeId(null);
                const all = (graph?.relationships ?? []).filter((r) => r.provenance === 'ai');
                if (selectedEdgeId == null && all.length) setSelectedEdgeId(all[0].id);
              }}
              className="rounded-lg px-1.5 py-0.5 text-[12px] text-ocean hover:bg-soft"
            >
              Review everything
            </button>
          </div>
        )}

        {stats && (
          <div className="ml-auto flex items-center gap-3 rounded-xl border border-line bg-raised/95 px-3 py-1.5 text-[11.5px] text-muted shadow-sm backdrop-blur">
            <span className="tabular-nums">{stats.relationships} links</span>
            {/* What the data says, at tenant scale. "169 links" alone gave no
                hint that a third of them might not hold. */}
            {health.checked > 0 && (
              <>
                <span className="tabular-nums">{health.checked} checked</span>
                {health.bad > 0 && (
                  <span className="tabular-nums" style={{ color: '#a43a3a' }}>
                    {health.bad} don&apos;t hold
                  </span>
                )}
              </>
            )}
            {stats.flagged > 0 && (
              <span className="flex items-center gap-1 tabular-nums text-err">
                <Flag size={10} />
                {stats.flagged} flagged
              </span>
            )}
            {stats.crossSource > 0 && (
              <span className="tabular-nums text-ocean">{stats.crossSource} across sources</span>
            )}
          </div>
        )}
      </div>

      {/* Measurement popover */}
      {match && (
        <div className="absolute right-4 top-20 z-20">
          <MatchPanel
            match={match}
            saving={saving}
            onKeep={keepMatch}
            onDiscard={() => setMatch(null)}
            onToggleNormalisation={() => void runMatch({
              ...match,
              normalisation: (match.normalisation === 'loose' ? 'exact' : 'loose') as Normalisation,
              measurement: null,
              error: null,
            })}
          />
        </div>
      )}

      {draw && (
        <div className="absolute right-4 top-20 z-20">
          <MeasurePanel
            draw={draw}
            saving={saving}
            onKeep={keepDrawn}
            onDiscard={() => setDraw(null)}
          />
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeClick={(_, edge) => setSelectedEdgeId(Number(edge.id))}
        // Clicking a table means the same thing here as in the list.
        onNodeClick={(_, node) => pickTable(Number(node.id))}
        onPaneClick={() => { if (mode === 'explore') setSelectedEdgeId(null); }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        defaultEdgeOptions={{ type: 'relation' }}
      >
        <Background color="#d0d5da" gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {reviewEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-2 rounded-2xl border border-line bg-raised/95 px-6 py-7 text-center shadow-sm backdrop-blur">
            <CheckCircle2 size={22} className="text-ok" />
            <p className="text-[14px] font-medium text-ink">
              {scopeTable
                ? `${scopeTable.displayName || scopeTable.tableName} is done`
                : 'Nothing left to review'}
            </p>
            <p className="text-[12.5px] leading-relaxed text-muted">
              {scopeTable
                ? 'Nothing on this table is waiting on you. Pick another table on the left, or go back to the full queue.'
                : 'Every relationship Clarion suggested has been decided on. Pick a table on the left to go over its links anyway.'}
            </p>
            <button
              type="button"
              onClick={() => {
                if (scopeTable) {
                  setReviewScopeId(null);
                  const all = (graph?.relationships ?? []).filter((r) => r.provenance === 'ai');
                  if (all.length) { setSelectedEdgeId(all[0].id); return; }
                }
                setMode('explore');
              }}
              className="mt-1 rounded-lg bg-ocean px-3 py-1.5 text-[12.5px] text-white hover:opacity-90"
            >
              {scopeTable ? 'Review everything' : 'Explore your data'}
            </button>
          </div>
        </div>
      )}

      {values && (
        <ValueExplorer
          title={values.title}
          result={values.result}
          loading={values.loading}
          onClose={() => setValues(null)}
        />
      )}

      {payoff && (
        <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-ocean/30 bg-oceanSofter px-3.5 py-2 text-[12.5px] text-ink shadow-sm">
          {payoff}
        </div>
      )}

      {!draw && !match && (
        <div className="absolute bottom-4 left-4 z-10 flex items-center gap-2.5 rounded-lg border border-line bg-raised/95 px-3 py-1.5 text-[11.5px] text-muted shadow-sm backdrop-blur">
          {/* The end symbols carry the cardinality now, so say what they mean
              once rather than making each user work it out. */}
          {/* The colour changed meaning, so it has to be stated. Line colour is
              what the DATA says; a dashed line is still an unreviewed
              suggestion. Two facts, two channels, both named here. */}
          {([
            ['#8c96a0', 'not checked'],
            ['#2f6f57', 'holds'],
            ['#a06a1c', 'partly'],
            ['#a43a3a', 'no match'],
          ] as const).map(([c, label]) => (
            <span key={label} className="flex items-center gap-1">
              <span className="h-[2px] w-3 rounded-full" style={{ background: c }} />
              {label}
            </span>
          ))}
          <span className="text-muted2">·</span>
          <span className="flex items-center gap-1">
            <span className="inline-flex h-[15px] w-[15px] items-center justify-center rounded-full border border-line bg-raised font-mono text-[9px] text-ink2">1</span>
            one row
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-flex h-[15px] w-[15px] items-center justify-center rounded-full border border-line bg-raised font-mono text-[9px] text-ink2">∗</span>
            many rows
          </span>
          {mode === 'review' && focus && (
            <>
              <span className="text-muted2">·</span>
              <span><Kbd>Y</Kbd> looks right</span>
              <span><Kbd>N</Kbd> remove</span>
              <span><Kbd>J</Kbd> next</span>
            </>
          )}
        </div>
      )}
      </div>

      {selectedRel && (
        <EdgeInspector
          relationship={selectedRel}
          fromLabel={labelFor(selectedRel.fromTableId, selectedRel.fromColumnId)}
          toLabel={labelFor(selectedRel.toTableId, selectedRel.toColumnId)}
          busy={busy}
          onConfirm={() => void confirmRel(selectedRel)}
          onDelete={() => void deleteRel(selectedRel)}
          onRemeasure={() => void remeasure(selectedRel)}
          onSaveDescription={(text) => void saveDescription(selectedRel, text)}
          onChangeType={(type) => void changeType(selectedRel, type)}
          onChangeColumns={(change) => void changeColumns(selectedRel, change)}
          onFlag={(flagged, reason) => void flagRel(selectedRel, flagged, reason)}
          onCompareValues={() => void compareValues(
            selectedRel,
            `${labelFor(selectedRel.fromTableId, selectedRel.fromColumnId)} → ${labelFor(selectedRel.toTableId, selectedRel.toColumnId)}`,
          )}
          fromColumns={columnsByTable.get(selectedRel.fromTableId) ?? []}
          toColumns={columnsByTable.get(selectedRel.toTableId) ?? []}
          // In Review the inspector IS the decision surface — closing it means
          // "skip", so it moves on rather than leaving an empty canvas.
          onClose={() => (mode === 'review' ? step(1) : setSelectedEdgeId(null))}
        />
      )}
    </div>
  );
}

export default function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
