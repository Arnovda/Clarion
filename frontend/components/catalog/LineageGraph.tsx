'use client';

/**
 * <LineageGraph> — column-level lineage, anchored on one table.
 *
 * Two lanes: source tables left, topic (product) tables right, with a
 * thread per column_lineage edge and the transformation readable on
 * selection. Always anchored (§2.4 — a global lineage graph is the same
 * hairball the relationship canvas was rebuilt to avoid): this component
 * answers "where does THIS table's data go / come from", nothing more.
 *
 * Deliberately NOT ReactFlow: the geometry is deterministic (fixed card
 * width, fixed row height, stacked lanes), so the threads can be drawn as
 * plain SVG from computed positions — no DOM measuring, no pan/zoom
 * machinery for a graph that is one anchor and its direct feeds. The same
 * "fixed geometry, single source of truth" idea the canvas's nodeHeight()
 * uses, applied to a simpler layout.
 *
 * Interaction: click a column on either side to isolate its threads and
 * read the transformations; click again (or elsewhere) to release.
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, GitBranch, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';

// ── Read model (GET /api/lineage/table) ────────────────────────────────────

interface SourceNode {
  tableId: number | null;
  tableName: string;
  displayName: string | null;
  columns: Array<{ id: number | null; name: string; displayName: string | null }>;
}

interface ProductNode {
  productId: number;
  productName: string;
  productTableId: number;
  tableName: string;
  displayName: string | null;
  tableRole: string | null;
  columns: Array<{ id: number; name: string; displayName: string | null; transformation: string | null }>;
}

interface LineageEdge {
  sourceTable: string;
  sourceColumn: string;
  productTableId: number;
  productColumnId: number;
  transformation: string | null;
}

interface LineageResponse {
  anchor: { layer: 'source' | 'product'; tableId: number; tableName: string; displayName: string | null };
  sources: SourceNode[];
  products: ProductNode[];
  edges: LineageEdge[];
  totalSourceColumns?: number;
}

// ── Geometry — single source of truth for card layout AND thread anchors ──

const CARD_W = 260;
const HEADER_H = 46;
const ROW_H = 26;
const FOOTER_H = 24;
const CARD_GAP = 20;
const LANE_PAD = 8;
const CANVAS_W = 720;
const LEFT_X = LANE_PAD;
const RIGHT_X = CANVAS_W - CARD_W - LANE_PAD;

type ColKey = string; // `s:${table}.${column}` | `p:${productColumnId}`

function sKey(table: string, column: string): ColKey { return `s:${table}.${column}`; }
function pKey(id: number): ColKey { return `p:${id}`; }

/** A card identity that survives relayout, for the expand toggles. */
type CardKey = string;

interface Card {
  key: CardKey;
  side: 'source' | 'product';
  top: number;
  height: number;
  node: SourceNode | ProductNode;
  /** Column render order — row index is the thread anchor. */
  rows: Array<{ key: ColKey; label: string; mono: string | null }>;
  /** Rows hidden behind the cap (0 when expanded or under the cap). */
  moreCount: number;
  expanded: boolean;
  footerNote: string | null;
}

/**
 * Now that the builder derives lineage for every column, a measures table
 * threads 60+ rows — a card that tall buries the picture. Cap the rows the
 * way Databricks' lineage nodes do, with the cap yielding to the current
 * selection: a thread must never point at a hidden row, so any row the
 * selected column connects to is always included.
 */
const ROW_CAP = 14;

function cardHeight(rowCount: number, hasFooter: boolean): number {
  return HEADER_H + rowCount * ROW_H + (hasFooter ? FOOTER_H : 0) + 8;
}

export default function LineageGraph({ layer, tableId }: { layer: 'source' | 'product'; tableId: number }) {
  const [data, setData] = useState<LineageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ColKey | null>(null);
  const [expandedCards, setExpandedCards] = useState<ReadonlySet<CardKey>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setSelected(null);
    setExpandedCards(new Set());
    api.get(`/lineage/table?layer=${layer}&tableId=${tableId}`)
      .then((res) => { if (!cancelled) setData(res.data?.data ?? null); })
      .catch(() => { if (!cancelled) setError('Could not load lineage.'); });
    return () => { cancelled = true; };
  }, [layer, tableId]);

  const layout = useMemo(() => {
    if (!data) return null;

    // Rows the current selection touches — these pierce the row cap, so a
    // thread can never point at a hidden row.
    const pinned = new Set<ColKey>();
    if (selected) {
      pinned.add(selected);
      for (const e of edgesTouching(data.edges, selected)) {
        pinned.add(sKey(e.sourceTable, e.sourceColumn));
        pinned.add(pKey(e.productColumnId));
      }
    }

    const capRows = (all: Card['rows'], expanded: boolean) => {
      if (expanded || all.length <= ROW_CAP) return { rows: all, moreCount: 0 };
      const rows = all.filter((r, i) => i < ROW_CAP || pinned.has(r.key));
      return { rows, moreCount: all.length - rows.length };
    };

    const sourceCards: Card[] = [];
    let y = LANE_PAD;
    for (const s of data.sources) {
      const all = s.columns.map((c) => ({
        key: sKey(s.tableName, c.name),
        label: c.displayName || c.name,
        mono: c.displayName ? c.name : null,
      }));
      const cardKey = `s:${s.tableName}`;
      const expanded = expandedCards.has(cardKey);
      const { rows, moreCount } = capRows(all, expanded);
      const unfed = data.anchor.layer === 'source' && data.totalSourceColumns != null
        ? data.totalSourceColumns - s.columns.length
        : 0;
      const footerNote = unfed > 0 ? `+ ${unfed} column${unfed === 1 ? '' : 's'} not feeding a topic yet` : null;
      const hasFooter = !!footerNote || moreCount > 0 || expanded;
      const height = cardHeight(rows.length, hasFooter);
      sourceCards.push({ key: cardKey, side: 'source', top: y, height, node: s, rows, moreCount, expanded, footerNote });
      y += height + CARD_GAP;
    }
    const productCards: Card[] = [];
    y = LANE_PAD;
    for (const p of data.products) {
      const all = p.columns.map((c) => ({
        key: pKey(c.id),
        label: c.displayName || c.name,
        mono: c.displayName ? c.name : null,
      }));
      const cardKey = `p:${p.productTableId}`;
      const expanded = expandedCards.has(cardKey);
      const { rows, moreCount } = capRows(all, expanded);
      const hasFooter = moreCount > 0 || expanded;
      const height = cardHeight(rows.length, hasFooter);
      productCards.push({ key: cardKey, side: 'product', top: y, height, node: p, rows, moreCount, expanded, footerNote: null });
      y += height + CARD_GAP;
    }

    // Row centre positions, keyed the same way edges are.
    const rowY = new Map<ColKey, number>();
    for (const card of [...sourceCards, ...productCards]) {
      card.rows.forEach((r, i) => rowY.set(r.key, card.top + HEADER_H + i * ROW_H + ROW_H / 2));
    }

    const height = Math.max(
      sourceCards.at(-1) ? sourceCards.at(-1)!.top + sourceCards.at(-1)!.height : 0,
      productCards.at(-1) ? productCards.at(-1)!.top + productCards.at(-1)!.height : 0,
      120,
    ) + LANE_PAD;

    return { sourceCards, productCards, rowY, height };
  }, [data, selected, expandedCards]);

  if (error) return <p className="px-6 py-6 text-[13px] text-err">{error}</p>;
  if (!data || !layout) {
    return (
      <div className="flex items-center gap-2 px-6 py-6 text-[13px] text-muted">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden /> Loading lineage…
      </div>
    );
  }

  if (data.edges.length === 0) {
    return (
      <div className="px-6 py-6">
        <div className="bg-raised border border-line rounded-lg p-6 text-center">
          <GitBranch className="w-8 h-8 text-muted-2 mx-auto mb-3" strokeWidth={1.5} />
          <p className="font-display text-[16px] text-ink tracking-[-0.01em]">No lineage recorded</p>
          <p className="text-[12px] text-muted mt-1.5 max-w-md mx-auto leading-relaxed">
            {data.anchor.layer === 'source'
              ? 'Nothing built from this table yet — lineage is written when topics are created on Build.'
              : 'No column-level lineage was recorded for this table.'}
          </p>
        </div>
      </div>
    );
  }

  const isActive = (key: ColKey) => selected === null || edgesTouching(data.edges, selected).some(
    (e) => sKey(e.sourceTable, e.sourceColumn) === key || pKey(e.productColumnId) === key,
  ) || selected === key;

  const selectedEdges = selected ? edgesTouching(data.edges, selected) : [];
  const productColLabel = (id: number): string => {
    for (const p of data.products) {
      const c = p.columns.find((x) => x.id === id);
      if (c) return c.displayName || c.name;
    }
    return String(id);
  };

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="overflow-x-auto">
        <div className="relative" style={{ width: CANVAS_W, height: layout.height }}>
          {/* Threads under the cards. */}
          <svg width={CANVAS_W} height={layout.height} className="absolute inset-0 pointer-events-none">
            {data.edges.map((e, i) => {
              const y1 = layout.rowY.get(sKey(e.sourceTable, e.sourceColumn));
              const y2 = layout.rowY.get(pKey(e.productColumnId));
              if (y1 == null || y2 == null) return null;
              const x1 = LEFT_X + CARD_W;
              const x2 = RIGHT_X;
              const midX = (x1 + x2) / 2;
              const active = selected === null
                || selected === sKey(e.sourceTable, e.sourceColumn)
                || selected === pKey(e.productColumnId);
              return (
                <path
                  key={i}
                  d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={active && selected !== null ? 'var(--ocean)' : 'var(--line-strong)'}
                  strokeWidth={active && selected !== null ? 2 : 1.4}
                  opacity={active ? 1 : 0.18}
                />
              );
            })}
          </svg>

          {[...layout.sourceCards, ...layout.productCards].map((card) => {
            const isSource = card.side === 'source';
            const node = card.node;
            const anchorHere = isSource
              ? data.anchor.layer === 'source' && (node as SourceNode).tableId === data.anchor.tableId
              : data.anchor.layer === 'product' && (node as ProductNode).productTableId === data.anchor.tableId;
            const title = isSource
              ? ((node as SourceNode).displayName || (node as SourceNode).tableName)
              : ((node as ProductNode).displayName || (node as ProductNode).tableName);
            const eyebrow = isSource
              ? ((node as SourceNode).tableId == null ? 'source · no longer in the catalog' : 'source')
              : (node as ProductNode).productName;
            return (
              <div
                key={card.key}
                className={cn(
                  'absolute rounded-[10px] border bg-raised',
                  anchorHere ? 'border-ocean shadow-1' : 'border-line',
                )}
                style={{ left: isSource ? LEFT_X : RIGHT_X, top: card.top, width: CARD_W }}
              >
                <div className="px-3 pt-2 pb-1.5 border-b border-line" style={{ height: HEADER_H }}>
                  <p className="text-[9.5px] font-mono uppercase tracking-[0.1em] text-muted-2 truncate">{eyebrow}</p>
                  <p className="text-[13px] font-medium text-ink truncate">{title}</p>
                </div>
                <div className="py-1">
                  {card.rows.map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => setSelected((cur) => (cur === r.key ? null : r.key))}
                      className={cn(
                        'flex w-full items-baseline gap-2 px-3 text-left transition-opacity',
                        isActive(r.key) ? 'opacity-100' : 'opacity-30',
                        selected === r.key ? 'bg-ocean-softer' : 'hover:bg-softer',
                      )}
                      style={{ height: ROW_H }}
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{r.label}</span>
                      {r.mono && <span className="shrink-0 font-mono text-[10px] text-muted-2 truncate max-w-[45%]">{r.mono}</span>}
                    </button>
                  ))}
                </div>
                {(card.footerNote || card.moreCount > 0 || card.expanded) && (
                  <div className="flex items-baseline gap-2 px-3 pb-2" style={{ height: FOOTER_H }}>
                    {(card.moreCount > 0 || card.expanded) && (
                      <button
                        type="button"
                        onClick={() => setExpandedCards((cur) => {
                          const next = new Set(cur);
                          if (next.has(card.key)) next.delete(card.key);
                          else next.add(card.key);
                          return next;
                        })}
                        className="shrink-0 text-[10.5px] text-ocean hover:underline"
                      >
                        {card.expanded ? 'Show fewer' : `Show all ${card.rows.length + card.moreCount} columns`}
                      </button>
                    )}
                    {card.footerNote && (
                      <span className="min-w-0 truncate text-[10.5px] text-muted-2">{card.footerNote}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* The transformations — readable, not hover-only. */}
      {selectedEdges.length > 0 && (
        <div className="mt-4 rounded-[10px] border border-line bg-raised px-4 py-3">
          <p className="mb-2 text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2">How it flows</p>
          <ul className="space-y-1.5">
            {selectedEdges.map((e, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
                <span className="font-mono text-[11.5px] text-ink-2">{e.sourceTable}.{e.sourceColumn}</span>
                <ArrowRight className="h-3 w-3 shrink-0 self-center text-muted-2" strokeWidth={2} aria-hidden />
                <span className="text-ink">{productColLabel(e.productColumnId)}</span>
                {e.transformation && <span className="text-muted">— {e.transformation}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function edgesTouching(edges: LineageEdge[], key: ColKey): LineageEdge[] {
  return edges.filter((e) => sKey(e.sourceTable, e.sourceColumn) === key || pKey(e.productColumnId) === key);
}
