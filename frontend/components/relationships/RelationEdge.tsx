'use client';

import { memo } from 'react';
import { EdgeProps, getBezierPath, EdgeLabelRenderer } from 'reactflow';
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

/** Compact cardinality notation. `1—N` reads faster than "one to many". */
const CARDINALITY_LABEL: Record<Cardinality, string> = {
  one_to_one: '1—1',
  one_to_many: '1—N',
  many_to_one: 'N—1',
  many_to_many: 'N—N',
};

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
      <path
        id={id}
        d={path}
        fill="none"
        stroke={style.color}
        strokeWidth={selected ? style.width + 1 : style.width}
        strokeDasharray={style.dash}
        strokeOpacity={data?.dimmed ? 0.18 : 1}
        markerEnd="url(#rel-arrow)"
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
        />
      )}

      {!data?.dimmed && (data?.cardinality || isMatch) && (
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
            {isMatch
              ? data?.matchRate != null ? `${Math.round(data.matchRate * 100)}% matched` : 'match'
              : CARDINALITY_LABEL[data!.cardinality!]}
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
