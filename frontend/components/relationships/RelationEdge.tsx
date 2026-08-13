'use client';

import { memo } from 'react';
import { EdgeProps, getBezierPath, EdgeLabelRenderer, Position } from 'reactflow';
import type { Cardinality, EdgeKind, Provenance } from './types';

export interface RelationEdgeData {
  kind: EdgeKind;
  provenance: Provenance;
  isCrossSource: boolean;
  cardinality: Cardinality | null;
  dimmed: boolean;
  /** Match rate for a match edge, 0..1. */
  matchRate: number | null;
}

/**
 * Provenance is carried by the LINE STYLE, not by a badge.
 *
 * The default view of this canvas is a review queue, so "which of these has
 * nobody checked?" has to be answerable at a glance across the whole graph. A
 * dashed line reads as provisional without needing a legend; a badge would have
 * to be found, one edge at a time.
 */
const STROKE: Record<Provenance, { color: string; dash?: string; width: number }> = {
  // Confirmed by a person — the strongest thing on the canvas.
  human: { color: '#164e63', width: 2 },
  // Straight from the connector's documentation. Trusted, but not personally owned.
  declared: { color: '#4a5660', width: 1.5 },
  // AI's suggestion, awaiting a human. This is the work.
  ai: { color: '#c08a5e', dash: '5 4', width: 1.5 },
};

/**
 * Cardinality is read off the ENDS of the line, not a badge in the middle.
 *
 * `N—1` floating between two tables tells you the shape but not which side is
 * which; you have to work out which end the N belongs to, every time. A symbol
 * sitting on each end says it where it applies: **1** = one row, **∗** = many.
 * That is the notation every ERD tool uses, for this reason.
 *
 * `∗` is U+2217, not the typographic asterisk — it sits on the centre line
 * rather than riding high, which matters inside a small circle.
 */
const ENDS: Record<Cardinality, readonly [string, string]> = {
  one_to_one:   ['1', '1'],
  one_to_many:  ['1', '∗'],
  many_to_one:  ['∗', '1'],
  many_to_many: ['∗', '∗'],
};

/** How far along the line from the node edge the symbol sits. */
const END_OFFSET = 15;

function EndSymbol({ x, y, symbol, color, faded }: {
  x: number; y: number; symbol: string; color: string; faded: boolean;
}) {
  return (
    <g pointerEvents="none" opacity={faded ? 0.18 : 1}>
      <circle cx={x} cy={y} r={7.5} fill="#fffdfa" stroke={color} strokeWidth={1.25} />
      <text
        x={x} y={y} textAnchor="middle" dominantBaseline="central"
        fontSize={10} fontWeight={600} fill={color}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
      >
        {symbol}
      </text>
    </g>
  );
}

function RelationEdgeImpl({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data, selected,
}: EdgeProps<RelationEdgeData>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  const style = STROKE[data?.provenance ?? 'declared'];
  const isMatch = data?.kind === 'match';

  return (
    <>
      {/* Invisible hit area. A hand-rolled edge gets no interaction path of its
          own — ReactFlow only adds one inside BaseEdge — so the visible 2px
          stroke was the entire click target and edges were effectively
          unselectable. This makes the whole corridor grabbable. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        strokeLinecap="round"
        className="react-flow__edge-interaction"
      />
      <path
        id={id}
        d={path}
        fill="none"
        stroke={style.color}
        strokeWidth={selected ? style.width + 1.5 : style.width}
        strokeDasharray={style.dash}
        strokeOpacity={data?.dimmed ? 0.18 : 1}
        markerEnd="url(#rel-arrow)"
        style={{ pointerEvents: 'none' }}
      />
      {/* A match edge is not a join, and must not read like one. The second
          stroke gives it a distinct texture at a glance, before any label is
          read — collapsing the two is what makes cross-system look easy and
          then be wrong. */}
      {isMatch && (
        <path
          d={path}
          fill="none"
          stroke={style.color}
          strokeWidth={style.width}
          strokeDasharray="2 6"
          strokeOpacity={data?.dimmed ? 0.12 : 0.55}
          transform="translate(0,3)"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* A match has no cardinality worth asserting — it is a claim that two
          things are the same, not a join — so it keeps the rate in the middle
          and gets no end symbols. Two different objects, two different reads. */}
      {!isMatch && data?.cardinality && (
        <>
          <EndSymbol
            x={sourceX + (sourcePosition === Position.Left ? -END_OFFSET : END_OFFSET)}
            y={sourceY}
            symbol={ENDS[data.cardinality][0]}
            color={style.color}
            faded={!!data.dimmed}
          />
          <EndSymbol
            x={targetX + (targetPosition === Position.Left ? -END_OFFSET : END_OFFSET)}
            y={targetY}
            symbol={ENDS[data.cardinality][1]}
            color={style.color}
            faded={!!data.dimmed}
          />
        </>
      )}

      {!data?.dimmed && isMatch && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'none',
              borderColor: style.color,
              color: style.color,
            }}
            className="rounded-full border bg-raised/95 px-1.5 py-[1px] text-[10px] font-medium tabular-nums"
          >
            {data?.matchRate != null ? `${Math.round(data.matchRate * 100)}% matched` : 'match'}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const RelationEdge = memo(RelationEdgeImpl);

/** Shared arrowhead. Rendered once by the canvas, referenced by every edge. */
export function EdgeMarkers() {
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
      <defs>
        <marker
          id="rel-arrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#4a5660" />
        </marker>
      </defs>
    </svg>
  );
}
