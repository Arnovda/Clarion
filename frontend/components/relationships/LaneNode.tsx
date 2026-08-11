'use client';

import { memo } from 'react';
import { NodeProps } from 'reactflow';

export interface LaneNodeData {
  name: string;
  color: string;
  width: number;
  height: number;
}

/**
 * A source lane, rendered as a NODE rather than an overlay.
 *
 * It has to live in flow coordinates: an absolutely-positioned div layered over
 * the canvas sits in screen space and drifts away from its tables the moment
 * anyone pans or zooms. Making it a node means ReactFlow applies the same
 * viewport transform it applies to everything else, and the band stays welded
 * to the tables it contains.
 *
 * Non-interactive by construction — a lane is scenery, and a click or drag on it
 * should behave as if it were the canvas beneath.
 */
function LaneNodeImpl({ data }: NodeProps<LaneNodeData>) {
  return (
    <div
      className="pointer-events-none rounded-2xl"
      style={{
        width: data.width,
        height: data.height,
        background: `${data.color}0d`,
        border: `1px solid ${data.color}22`,
      }}
    >
      <div
        className="px-4 pt-3 font-mono text-[10px] uppercase tracking-[0.14em]"
        style={{ color: data.color }}
      >
        {data.name}
      </div>
    </div>
  );
}

export const LaneNode = memo(LaneNodeImpl);
