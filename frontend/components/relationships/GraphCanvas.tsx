'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background, Controls, ReactFlowProvider,
  useNodesState, useEdgesState, useReactFlow, Connection, Node, Edge, ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Loader2, AlertTriangle } from 'lucide-react';
import api from '@/lib/api';
import { TableNode, type TableNodeData } from './TableNode';
import { LaneNode, type LaneNodeData } from './LaneNode';
import { RelationEdge, EdgeMarkers, type RelationEdgeData } from './RelationEdge';
import { MeasurePanel } from './MeasurePanel';
import { MatchPanel } from './MatchPanel';
import { EdgeInspector } from './EdgeInspector';
import { TableList } from './TableList';
import { laneLayout, laneColor } from './laneLayout';
import { parseHandle, handleLeft, handleRight } from './geometry';
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

const nodeTypes = { table: TableNode, lane: LaneNode };
const edgeTypes = { relation: RelationEdge };

function CanvasInner() {
  const { fitView } = useReactFlow();
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [draw, setDraw] = useState<PendingDraw | null>(null);
  const [match, setMatch] = useState<PendingMatch | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<number | null>(null);
  const [busy, setBusy] = useState<'confirm' | 'delete' | 'measure' | 'save' | null>(null);
  const [payoff, setPayoff] = useState<string | null>(null);
  /**
   * 'review' shows only what you are deciding on right now — the focused
   * relationship's two tables plus one hop. 'explore' shows the whole graph.
   *
   * Review is the default because reviewing is the job, and because rendering
   * everything does not work: 36 tables in one source is a wall of nodes that
   * fitView has to shrink past the point of legibility. The plan said never
   * render everything; this is that rule, applied.
   */
  const [mode, setMode] = useState<'review' | 'explore'>('review');
  /**
   * Explore centres on ONE table and shows what it connects to. There is no
   * "everything" view: 36 tables and 169 edges is a picture of a hairball, not a
   * tool, and it stops being readable the moment a second source is added.
   */
  const [anchorId, setAnchorId] = useState<number | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeData | LaneNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelationEdgeData>([]);

  // Columns are fetched with the graph, so expanding a node is instant. At SMB
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
   * Land on the first thing to review, with both its tables already open on the
   * joined columns. Opening to an unanchored map of everything asks the user to
   * find the work before they can do it.
   */
  useEffect(() => {
    if (!graph || selectedEdgeId !== null) return;
    const first = graph.relationships.find((r) => r.provenance === 'ai');
    if (!first) { setMode('explore'); return; }
    setSelectedEdgeId(first.id);
    setExpanded(new Set([first.fromTableId, first.toTableId]));
  }, [graph, selectedEdgeId]);

  useEffect(() => {
    if (mode !== 'explore' || !graph || anchorId !== null) return;
    const hub = [...graph.tables].sort((a, b) => b.relationshipCount - a.relationshipCount)[0];
    if (hub) setAnchorId(hub.id);
  }, [mode, graph, anchorId]);

  /**
   * Expansion is scoped to the pair being linked, and resets on every mode
   * change. A table with forty columns is ~1,200px tall; letting one follow you
   * out of Review is what shredded the Explore grid.
   */
  useEffect(() => { setExpanded(new Set()); }, [mode]);

  /** Keep the focused relationship's tables open as the queue advances. */
  useEffect(() => {
    if (mode !== 'review' || !graph || selectedEdgeId === null) return;
    const rel = graph.relationships.find((r) => r.id === selectedEdgeId);
    if (!rel) return;
    setExpanded((prev) => {
      if (prev.has(rel.fromTableId) && prev.has(rel.toTableId)) return prev;
      return new Set([...prev, rel.fromTableId, rel.toTableId]);
    });
  }, [mode, graph, selectedEdgeId]);

  const columnsByTable = useMemo(() => {
    const m = new Map<number, GraphColumn[]>();
    for (const c of graph?.columns ?? []) {
      if (!m.has(c.table_id)) m.set(c.table_id, []);
      m.get(c.table_id)!.push(c);
    }
    return m;
  }, [graph]);

  const toggleExpanded = useCallback((tableId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) next.delete(tableId); else next.add(tableId);
      return next;
    });
  }, []);

  const matches = useCallback((tableId: number) => {
    if (!search.trim()) return true;
    const t = graph?.tables.find((x) => x.id === tableId);
    if (!t) return false;
    const q = search.toLowerCase();
    return `${t.tableName} ${t.displayName ?? ''}`.toLowerCase().includes(q);
  }, [search, graph]);

  /**
   * In review mode, the canvas shows the focused relationship's two tables and
   * their immediate neighbours — enough context to judge the link, and nothing
   * else competing for attention.
   */
  /** The tables the current view is about — never the whole catalog. */
  const focusIds = useMemo(() => {
    if (!graph) return null;
    if (mode === 'explore') return anchorId != null ? new Set([anchorId]) : null;
    if (selectedEdgeId == null) return null;
    const rel = graph.relationships.find((r) => r.id === selectedEdgeId);
    return rel ? new Set([rel.fromTableId, rel.toTableId]) : null;
  }, [graph, mode, anchorId, selectedEdgeId]);

  const visibleTables = useMemo(() => {
    if (!graph) return [];
    if (!focusIds) return graph.tables;
    const keep = new Set(focusIds);
    for (const r of graph.relationships) {
      if (focusIds.has(r.fromTableId)) keep.add(r.toTableId);
      if (focusIds.has(r.toTableId)) keep.add(r.fromTableId);
    }
    return graph.tables.filter((t) => keep.has(t.id));
  }, [graph, focusIds]);

  const visibleTableIds = useMemo(
    () => new Set(visibleTables.map((t) => t.id)),
    [visibleTables],
  );

  const layout = useMemo(() => {
    if (!graph) return null;
    const counts = new Map<number, number>();
    for (const t of visibleTables) counts.set(t.id, columnsByTable.get(t.id)?.length ?? 0);
    return laneLayout(graph.sources, visibleTables, counts, expanded);
  }, [graph, visibleTables, columnsByTable, expanded]);

  /** Tables at the centre of the current view — rendered prominently. */
  const focusPair = focusIds;

  // Rebuild nodes and edges whenever the graph, layout or filters change.
  useEffect(() => {
    if (!graph || !layout) return;
    const colorByConnection = new Map(layout.lanes.map((l) => [l.connectionId, laneColor(l.colorIndex)]));

    // Lanes first and at a lower z so tables always sit on top of their band.
    const laneNodes: Node<LaneNodeData>[] = layout.lanes.map((lane) => ({
      id: `lane-${lane.connectionId}`,
      type: 'lane',
      position: { x: lane.x, y: -24 },
      data: {
        name: lane.name,
        color: laneColor(lane.colorIndex),
        width: lane.width,
        height: Math.max(lane.height, 240) + 48,
      },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: 0,
    }));

    const tableNodes = visibleTables.map((t) => {
      const pos = layout.positions.get(t.id) ?? { x: 0, y: 0 };
      return {
        id: String(t.id),
        type: 'table',
        position: pos,
        draggable: true,
        data: {
          tableId: t.id,
          label: t.displayName || t.tableName,
          subtitle: t.description,
          relationshipCount: t.relationshipCount,
          laneColor: colorByConnection.get(t.connectionId) ?? '#6b7680',
          columns: columnsByTable.get(t.id) ?? [],
          expanded: expanded.has(t.id),
          dimmed: !matches(t.id),
          focused: !!focusPair && focusPair.has(t.id),
          onToggle: toggleExpanded,
        },
        zIndex: 1,
      } satisfies Node<TableNodeData>;
    });

    setNodes([...laneNodes, ...tableNodes]);

    setEdges(graph.relationships
      .filter((r) => visibleTableIds.has(r.fromTableId) && visibleTableIds.has(r.toTableId))
      // Only lines that touch what the view is about. A neighbour's own
      // relationships are not this view's subject, and drawing them is what
      // turned 169 links into an unreadable scribble.
      .filter((r) => !focusIds || focusIds.has(r.fromTableId) || focusIds.has(r.toTableId))
      .map((r) => {
        // Attach to a column row when that node is expanded; otherwise to the
        // node itself. An edge pointing at a hidden row would float in space.
        const fromExpanded = expanded.has(r.fromTableId) && r.fromColumnId != null;
        const toExpanded = expanded.has(r.toTableId) && r.toColumnId != null;
        return {
          id: String(r.id),
          source: String(r.fromTableId),
          target: String(r.toTableId),
          sourceHandle: fromExpanded ? handleRight(r.fromColumnId!) : handleRight('table'),
          targetHandle: toExpanded ? handleLeft(r.toColumnId!) : handleLeft('table'),
          type: 'relation',
          data: {
            kind: r.kind,
            provenance: r.provenance,
            isCrossSource: r.isCrossSource,
            cardinality: (r.relationshipType as Cardinality) ?? null,
            matchRate: r.kind === 'match'
              ? ((r.measured as unknown as MatchMeasurement | null)?.matchRate ?? null)
              : null,
            dimmed: (!matches(r.fromTableId) && !matches(r.toTableId))
              || (mode === 'review' && selectedEdgeId != null && r.id !== selectedEdgeId),
          },
          selected: r.id === selectedEdgeId,
        } satisfies Edge<RelationEdgeData>;
      }));
  }, [graph, layout, visibleTables, visibleTableIds, focusIds, columnsByTable, expanded, matches, selectedEdgeId, mode, focusPair, setNodes, setEdges, toggleExpanded]);

  useEffect(() => {
    if (!nodes.length) return;
    // A frame's delay lets ReactFlow measure the new nodes first; fitting before
    // that uses stale sizes and lands off-centre.
    const t = setTimeout(() => fitView({ padding: 0.2, maxZoom: 1, duration: 300 }), 60);
    return () => clearTimeout(t);
  }, [nodes.length, mode, selectedEdgeId, fitView]);

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
        error: 'Open both tables and drag between two specific columns — a relationship needs to know which columns match.',
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

  const selectedRel: GraphRelationship | null = selectedEdgeId != null
    ? graph?.relationships.find((r) => r.id === selectedEdgeId) ?? null
    : null;

  /**
   * Relationships still awaiting a human, in the order the canvas walks them.
   * This is the queue — J and K step through it without the user hunting for
   * dashed lines by eye.
   */
  const pendingQueue = useMemo(
    () => (graph?.relationships ?? []).filter((r) => r.provenance === 'ai').map((r) => r.id),
    [graph],
  );

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
      setSelectedEdgeId(null);
      await load();
    } finally {
      setBusy(null);
    }
  }, [load]);

  const deleteRel = useCallback(async (rel: GraphRelationship) => {
    setBusy('delete');
    try {
      await api.delete(`/semantic/relationships/${rel.id}`);
      setSelectedEdgeId(null);
      await load();
    } finally {
      setBusy(null);
    }
  }, [load]);

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
      const res = await api.post('/relationships/measure', {
        fromTableId: rel.fromTableId,
        fromColumnId: rel.fromColumnId,
        toTableId: rel.toTableId,
        toColumnId: rel.toColumnId,
      });
      const measurement = res.data.data as Measurement;
      // Cache it on the row so the next visit shows it without re-running.
      await api.patch(`/semantic/relationships/${rel.id}`, { measured: measurement });
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
          setSelectedEdgeId(null); setDraw(null); setMatch(null);
          break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, selectedRel, busy, confirmRel, deleteRel]);

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
  const anchorTable = graph?.tables.find((t) => t.id === anchorId) ?? null;
  const colorForConnection = (connectionId: number) => {
    const lane = layout?.lanes.find((l) => l.connectionId === connectionId);
    return lane ? laneColor(lane.colorIndex) : '#6b7680';
  };

  return (
    <div className="flex h-full">
      {mode === 'explore' && graph && (
        <TableList
          tables={graph.tables}
          sources={graph.sources}
          colorFor={colorForConnection}
          anchorId={anchorId}
          search={search}
          onSearch={setSearch}
          onPick={(id) => { setAnchorId(id); setSelectedEdgeId(null); }}
        />
      )}
      <div className="relative min-w-0 flex-1">
      <EdgeMarkers />

      {/* Toolbar */}
      <div className="absolute left-4 right-4 top-4 z-10 flex items-center gap-3">
        {/* Mode is a real switch, not a filter: reviewing and exploring want
            different amounts of the graph on screen, and conflating them is what
            produced a wall of unreadable nodes. */}
        <div className="flex items-center rounded-xl border border-line bg-raised/95 p-0.5 shadow-sm backdrop-blur">
          {(['review', 'explore'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); if (m === 'explore') setSelectedEdgeId(null); }}
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

        {mode === 'explore' && anchorTable && (
          <div className="rounded-xl border border-line bg-raised/95 px-3 py-1.5 text-[12.5px] text-ink2 shadow-sm backdrop-blur">
            Showing what <span className="font-medium text-ink">{anchorTable.displayName || anchorTable.tableName}</span> connects to
          </div>
        )}

        {stats && (
          <div className="ml-auto flex items-center gap-3 rounded-xl border border-line bg-raised/95 px-3 py-1.5 text-[11.5px] text-muted shadow-sm backdrop-blur">
            <span className="tabular-nums">{stats.tables} tables</span>
            <span className="tabular-nums">{stats.relationships} links</span>
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
        onNodeClick={(_, node) => {
          // Walking the graph: click a neighbour to make it the centre.
          if (mode === 'explore' && node.type === 'table') setAnchorId(Number(node.id));
        }}
        onPaneClick={() => setSelectedEdgeId(null)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.6}
        defaultEdgeOptions={{ type: 'relation' }}
      >
        <Background color="#d0d5da" gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {graph?.truncated && (
        <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-warn/40 bg-warnSoft px-3 py-1.5 text-[11.5px] text-ink2">
          Showing the first {graph.tables.length} of {graph.stats.tables} tables.
        </div>
      )}

      {payoff && (
        <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-ocean/30 bg-oceanSofter px-3.5 py-2 text-[12.5px] text-ink shadow-sm">
          {payoff}
        </div>
      )}

      {mode === 'review' && pendingQueue.length > 0 && !draw && !match && (
        <div className="absolute bottom-4 left-4 z-10 flex items-center gap-2.5 rounded-lg border border-line bg-raised/95 px-3 py-1.5 text-[11.5px] text-muted shadow-sm backdrop-blur">
          <span><Kbd>Y</Kbd> looks right</span>
          <span><Kbd>N</Kbd> remove</span>
          <span><Kbd>J</Kbd> next</span>
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
          fromColumns={columnsByTable.get(selectedRel.fromTableId) ?? []}
          toColumns={columnsByTable.get(selectedRel.toTableId) ?? []}
          onClose={() => setSelectedEdgeId(null)}
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
