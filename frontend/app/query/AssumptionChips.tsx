'use client';

/**
 * AssumptionChips — the worksheet's "reading" row (spec §4.3).
 *
 * Each non-silent assumption renders as a chip with a chevron; clicking
 * opens a menu with the assumption's `detail` as help text and its
 * `options` (current value marked). Choosing a different option BRANCHES:
 * the parent passes the pick to `onPick`, which re-asks the same question
 * with only that assumption changed. `+ add` lists the assumptions
 * Clarion resolved silently — how a user tightens a question without
 * rewriting it.
 *
 * Chips with no options (legacy string assumptions, or a model that
 * emitted none) fall back to `onLegacy` — the sentence re-ask.
 *
 * A11y: chips are buttons with aria-haspopup="menu"; menus close on
 * Escape and outside click; options are menuitemradio with aria-checked.
 */

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import type { AssumptionDetail } from './types';

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function OptionList({ a, onPick }: {
  a: AssumptionDetail;
  onPick: (a: AssumptionDetail, opt: { value: string; label: string }) => void;
}) {
  return (
    <div role="menu" className="py-1">
      {a.detail && (
        <p className="px-3 pb-1.5 pt-0.5 text-[11px] text-muted leading-relaxed border-b border-line mb-1">{a.detail}</p>
      )}
      {a.options.map((opt) => {
        const current = opt.value === a.value;
        return (
          <button
            key={opt.value}
            role="menuitemradio"
            aria-checked={current}
            disabled={current}
            onClick={() => onPick(a, opt)}
            className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 ${
              current ? 'text-ink font-medium cursor-default' : 'text-ink-3 hover:bg-ocean-softer hover:text-ocean'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${current ? 'bg-ocean' : 'bg-transparent border border-line-strong'}`} aria-hidden="true" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function AssumptionChip({ a, onPick, onLegacy }: {
  a: AssumptionDetail;
  onPick: (a: AssumptionDetail, opt: { value: string; label: string }) => void;
  onLegacy: (label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const hasMenu = a.options.length > 0;

  return (
    <span className="relative inline-flex" ref={ref}>
      <button
        type="button"
        aria-haspopup={hasMenu ? 'menu' : undefined}
        aria-expanded={hasMenu ? open : undefined}
        onClick={() => (hasMenu ? setOpen((o) => !o) : onLegacy(a.label))}
        title={hasMenu
          ? 'Change this assumption — starts a new branch'
          : 'Ask again with this assumption changed — starts a new branch'}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-line-strong bg-raised text-[11.5px] text-ink-3 hover:border-ocean/50 hover:text-ocean transition-colors text-left"
      >
        {a.label}
        <ChevronDown className={`w-3 h-3 opacity-50 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && hasMenu && (
        <div className="absolute top-full left-0 mt-1 z-30 min-w-[220px] max-w-[320px] rounded-lg border border-line bg-raised shadow-lg">
          <OptionList a={a} onPick={(aa, opt) => { setOpen(false); onPick(aa, opt); }} />
        </div>
      )}
    </span>
  );
}

export default function AssumptionChips({ details, onPick, onLegacy }: {
  details: AssumptionDetail[];
  onPick: (a: AssumptionDetail, opt: { value: string; label: string }) => void;
  onLegacy: (label: string) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useOutsideClose(addOpen, () => setAddOpen(false));

  const visible = details.filter((a) => !a.silent);
  const silent = details.filter((a) => a.silent);
  if (details.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
      <span className="font-mono text-[10px] lowercase tracking-[0.1em] text-muted-2 mr-0.5">reading</span>
      {visible.map((a, i) => (
        <AssumptionChip key={`${a.label}-${i}`} a={a} onPick={onPick} onLegacy={onLegacy} />
      ))}
      {silent.length > 0 && (
        <span className="relative inline-flex" ref={addRef}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => setAddOpen((o) => !o)}
            title="Assumptions Clarion applied without asking — surface one to change it"
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-dashed border-line-strong bg-transparent text-[11.5px] text-muted hover:border-ocean/50 hover:text-ocean transition-colors"
          >
            <Plus className="w-3 h-3" strokeWidth={2} aria-hidden="true" />
            add
          </button>
          {addOpen && (
            <div className="absolute top-full left-0 mt-1 z-30 min-w-[260px] max-w-[340px] rounded-lg border border-line bg-raised shadow-lg py-1">
              <p className="px-3 py-1 font-mono text-[9.5px] lowercase tracking-[0.1em] text-muted-2">also applied, silently</p>
              {silent.map((a, i) => (
                <div key={`${a.label}-${i}`} className={i > 0 ? 'border-t border-line/60' : ''}>
                  <p className="px-3 pt-1.5 text-[12px] text-ink font-medium">{a.label}</p>
                  {a.options.length > 0 ? (
                    <OptionList a={a} onPick={(aa, opt) => { setAddOpen(false); onPick(aa, opt); }} />
                  ) : (
                    <button
                      onClick={() => { setAddOpen(false); onLegacy(a.label); }}
                      className="w-full text-left px-3 py-1.5 text-[12px] text-ink-3 hover:bg-ocean-softer hover:text-ocean"
                    >
                      Change this…
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
}
