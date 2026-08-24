'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import RequireRole from '@/components/RequireRole';

/**
 * The relationship canvas — two layers behind one door.
 *
 *   • Sources — the editing/measuring canvas over raw source tables
 *     (draw, measure, confirm, flag).
 *   • Topics  — the read-only canvas over built topics AND the user's own
 *     tables (budgets, mappings), so "what's linked to what" is always
 *     answerable after the build, grids included.
 *
 * Both are loaded client-side only: ReactFlow measures the DOM to place
 * edges, so there is nothing useful to render on the server, and keeping
 * them out of the initial bundle stops a graph tool nobody has opened from
 * costing every other page.
 */
const GraphCanvas = dynamic(() => import('@/components/relationships/GraphCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[13px] text-muted">
      Loading…
    </div>
  ),
});

const TopicsCanvas = dynamic(() => import('@/components/relationships/TopicsCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[13px] text-muted">
      Loading…
    </div>
  ),
});

type Layer = 'sources' | 'topics';

export default function RelationshipsPage() {
  const [layer, setLayer] = useState<Layer>('sources');

  return (
    <RequireRole roles={['admin', 'analyst']}>
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-6 py-3">
          <h1 className="font-serif text-[20px] leading-tight text-ink">
            How your data fits together
          </h1>
          <div className="flex items-center rounded-[8px] border border-line bg-bg p-0.5">
            {(['sources', 'topics'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLayer(l)}
                className={`rounded-[6px] px-3 py-1 text-[12px] transition-colors ${
                  layer === l ? 'bg-raised font-medium text-ink shadow-1' : 'text-muted hover:text-ink-3'
                }`}
              >
                {l === 'sources' ? 'Sources' : 'Topics'}
              </button>
            ))}
          </div>
          <p className="text-[12.5px] text-muted">
            {layer === 'sources'
              ? 'Pick a table to see what it connects to, and on which fields.'
              : 'Your topics and your own tables (budgets, mappings) — and how they join.'}
          </p>
        </header>
        <div className="min-h-0 flex-1">
          {layer === 'sources' ? <GraphCanvas /> : <TopicsCanvas />}
        </div>
      </div>
    </RequireRole>
  );
}
