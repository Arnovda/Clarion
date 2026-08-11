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
        <header className="border-b border-line px-6 py-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted2">
            Your data
          </div>
          <h1 className="mt-1 font-serif text-[22px] leading-tight text-ink">
            How it fits together
          </h1>
          <p className="mt-1 max-w-2xl text-[12.5px] text-muted">
            Every table Clarion has found, grouped by where it came from. Open two tables and
            drag between columns to tell Clarion how they relate — it will check the link
            against your data before saving it.
          </p>
        </header>
        <div className="min-h-0 flex-1">
          <GraphCanvas />
        </div>
      </div>
    </RequireRole>
  );
}
