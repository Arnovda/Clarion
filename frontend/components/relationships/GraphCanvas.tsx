'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background, Controls, ReactFlowProvider,
  useNodesState, useEdgesState, Connection, Node, Edge, ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Search, Loader2, AlertTriangle } from 'lucide-react';
import api from '@/lib/api';
import { TableNode, type TableNodeData } from './TableNode';
import { LaneNode, type LaneNodeData } from './LaneNode';
import { RelationEdge, EdgeMarkers, type RelationEdgeData } from './RelationEdge';
import { MeasurePanel } from './MeasurePanel';
import { EdgeInspector } from './EdgeInspector';
import { laneLayout, laneColor } from './laneLayout';
import { parseHandle, handleLeft, handleRight } from './geometry';
import type {
  GraphResponse, GraphColumn, Measurement, PendingDraw, Cardinality, GraphRelationship,
} from './types';

const nodeTypes = { table: TableNode, lane: LaneNode };
const edgeTypes = { relation: RelationEdge };

function CanvasInner() {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [onlyPending, setOnlyPending] = useState(false);
  const [draw, setDraw] = useState<PendingDraw | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<number | null>(null);
  const [busy, setBusy] = useState<'confirm' | 'delete' | 'measure' | 'save' | null>(null);
  const [payoff, setPayoff] = useState<string | null>(null);

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

  const layout = useMemo(() => {
    if (!graph) return null;
    const counts = new Map<number, number>();
    for (const t of graph.tables) counts.set(t.id, columnsByTable.get(t.id)?.length ?? 0);
    return laneLayout(graph.sources, graph.tables, counts, expanded);
  }, [graph, columnsByTable, expanded]);

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

    const tableNodes = graph.tables.map((t) => {
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
          focused: false,
          onToggle: toggleExpanded,
        },
        zIndex: 1,
      } satisfies Node<TableNodeData>;
    });

    setNodes([...laneNodes, ...tableNodes]);

    setEdges(graph.relationships
      .filter((r) => !onlyPending || r.provenance === 'ai')
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
            matchRate: null,
            dimmed: !matches(r.fromTableId) && !matches(r.toTableId),
          },
          selected: r.id === selectedEdgeId,
        } satisfies Edge<RelationEdgeData>;
      }));
  }, [graph, layout, columnsByTable, expanded, onlyPending, matches, selectedEdgeId, setNodes, setEdges, toggleExpanded]);

  const labelFor = useCallback((tableId: number, columnId: number | null) => {
    const t = graph?.tables.find((x) => x.id === tableId);
    const c = columnsByTable.get(tableId)?.find((x) => x.id === columnId);
    return `${t?.displayName || t?.tableName || 'table'}${c ? `.${c.column_name}` : ''}`;
  }, [graph, columnsByTable]);

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
  }, [labelFor]);

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
        ? 'Ask AI can now answer questions that span both sources.'
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
          setSelectedEdgeId(null); setDraw(null);
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

  return (
    <div className="flex h-full">
      <div className="relative min-w-0 flex-1">
      <EdgeMarkers />

      {/* Toolbar */}
      <div className="absolute left-4 right-4 top-4 z-10 flex items-center gap-3">
        <div className="flex items-center gap-2 rounded-xl border border-line bg-raised/95 px-3 py-1.5 shadow-sm backdrop-blur">
          <Search size={13} className="text-muted2" />
          <input
            id="rel-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a table…"
            className="w-44 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted2"
          />
        </div>

        <button
          type="button"
          onClick={() => setOnlyPending((v) => !v)}
          className={`rounded-xl border px-3 py-1.5 text-[12.5px] shadow-sm backdrop-blur transition-colors ${
            onlyPending
              ? 'border-ocean bg-ocean text-white'
              : 'border-line bg-raised/95 text-ink2 hover:bg-soft'
          }`}
        >
          Needs review
          {stats && stats.pendingReview > 0 && (
            <span className={`ml-1.5 tabular-nums ${onlyPending ? 'text-white/80' : 'text-muted'}`}>
              {stats.pendingReview}
            </span>
          )}
        </button>

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
        onPaneClick={() => setSelectedEdgeId(null)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        proOptions={{ hideAttribution: true }}
        fitView
        minZoom={0.15}
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

      {pendingQueue.length > 0 && !selectedRel && !draw && (
        <div className="absolute bottom-4 left-4 z-10 rounded-lg border border-line bg-raised/95 px-3 py-1.5 text-[11.5px] text-muted shadow-sm backdrop-blur">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted2">J</span> to start reviewing
          {' · '}
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted2">/</span> to search
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
