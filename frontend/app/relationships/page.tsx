'use client';

import dynamic from 'next/dynamic';
import RequireRole from '@/components/RequireRole';

/**
 * The relationship canvas.
 *
 * Loaded client-side only: ReactFlow measures the DOM to place edges, so there
 * is nothing useful to render on the server, and keeping it out of the initial
 * bundle stops a graph tool nobody has opened from costing every other page.
 */
const GraphCanvas = dynamic(() => import('@/components/relationships/GraphCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[13px] text-muted">
      Loading…
    </div>
  ),
});

export default function RelationshipsPage() {
  return (
    <RequireRole roles={['admin', 'analyst']}>
      <div className="flex h-full flex-col">
        {/* One sentence. The header had three, describing gestures the screen
            below already offers, on a page whose whole problem was that it was
            busy — and a paragraph of instructions is read once and then costs
            vertical space to the canvas on every visit afterwards. */}
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-6 py-3">
          <h1 className="font-serif text-[20px] leading-tight text-ink">
            How your data fits together
          </h1>
          <p className="text-[12.5px] text-muted">
            Pick a table to see what it connects to, and on which fields.
          </p>
        </header>
        <div className="min-h-0 flex-1">
          <GraphCanvas />
        </div>
      </div>
    </RequireRole>
  );
}
