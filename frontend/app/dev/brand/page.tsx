'use client';

// ─── /dev/brand — the Clarion mark, every state at every size ────────────────
// Internal playground route (gated like the rest of /dev). It exists so the
// mark can be judged where it matters — at 16, 20 and 24px, in the real
// components that use it — instead of on a poster. Pick a state to watch its
// transitions (leaving Working must decelerate, never jump).

import { useState } from 'react';
import { ClarionLockup, ClarionMark, type ClarionMarkState } from '@/components/brand/ClarionMark';
import { ThinkingBubble, ThinkingPanel } from '../../query/thinking';

const STATES: Array<{ id: ClarionMarkState; label: string; note: string }> = [
  { id: 'idle', label: 'Idle', note: 'Ready. No motion.' },
  { id: 'working', label: 'Working', note: 'Reading, looking up, calculating.' },
  { id: 'checking', label: 'Double-checking', note: 'Verifying a result.' },
  { id: 'done', label: 'Done', note: 'The answer is ready.' },
  { id: 'uncertain', label: 'Uncertain', note: 'Take this with care.' },
];
const SIZES = [16, 20, 24, 32, 48, 96];

export default function BrandGallery() {
  const [live, setLive] = useState<ClarionMarkState>('idle');

  return (
    <div className="min-h-screen bg-bg p-8 space-y-10 text-ink">
      <header className="space-y-2">
        <ClarionLockup size={32} />
        <p className="text-[13px] text-muted">The mark in every state and size — /dev/brand</p>
      </header>

      <section className="space-y-3" data-testid="state-grid">
        <h2 className="text-[11px] font-mono uppercase tracking-[0.12em] text-muted">States × sizes</h2>
        <div className="bg-raised border border-line rounded-lg divide-y divide-line">
          {STATES.map((s) => (
            <div key={s.id} className="flex items-center gap-6 px-5 py-4" data-state={s.id}>
              <div className="w-40 shrink-0">
                <div className="text-[13px] font-medium">{s.label}</div>
                <div className="text-[11.5px] text-muted">{s.note}</div>
              </div>
              {SIZES.map((px) => (
                <div key={px} className="flex flex-col items-center gap-1 w-[100px]">
                  <ClarionMark size={px} state={s.id} />
                  <span className="text-[10px] font-mono text-muted-2">{px}px</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-[11px] font-mono uppercase tracking-[0.12em] text-muted">On dark, and mono</h2>
        <div className="flex gap-4 flex-wrap">
          <div className="bg-[#081521] rounded-lg p-5 flex items-center gap-5">
            {STATES.map((s) => <ClarionMark key={s.id} size={24} state={s.id} onDark />)}
            <ClarionLockup size={28} onDark />
          </div>
          <div className="bg-raised border border-line rounded-lg p-5 flex items-center gap-5 text-muted-2">
            {STATES.map((s) => <ClarionMark key={s.id} size={24} state={s.id} tone="mono" />)}
          </div>
          <div className="bg-ocean rounded-lg px-4 py-2 flex items-center gap-2 text-white text-[13px]">
            <ClarionMark size={16} tone="mono" /> Create my topics
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-[11px] font-mono uppercase tracking-[0.12em] text-muted">Transitions — pick a state</h2>
        <div className="flex items-center gap-6">
          <ClarionMark size={96} state={live} />
          <ClarionMark size={24} state={live} />
          <div className="flex gap-2">
            {STATES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setLive(s.id)}
                className={`px-3 py-1.5 rounded-md text-[12.5px] border ${live === s.id ? 'bg-ocean text-white border-ocean' : 'bg-raised border-line text-ink-2'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-3 max-w-[720px]">
        <h2 className="text-[11px] font-mono uppercase tracking-[0.12em] text-muted">In Ask AI</h2>
        <ThinkingBubble
          bare
          phase="Running your query…"
          liveText=""
          sql={null}
          confidence={null}
          tables={['fact_sales_invoice_lines', 'dim_account']}
          canSeeSql={false}
        />
        <ThinkingPanel
          bare
          canSeeSql={false}
          onClarify={() => {}}
          repair={{
            forMessageId: 1,
            isActive: true,
            revealed: false,
            events: [{ kind: 'thinking', text: 'The total looks high for one month — checking for duplicated invoice lines.' }],
          }}
        />
      </section>
    </div>
  );
}
