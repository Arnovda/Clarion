'use client';

/**
 * "Your board" — the small set of numbers this person actually watches.
 *
 * In R1 the board is the user's pulse entries, which is already the right
 * SHAPE (a per-user list of watched metrics with values, deltas and 30 days
 * of history) and needs no new storage. R3 changes only where entries come
 * FROM — promotion on repeat questions instead of a manual pick — and this
 * component does not have to change for that.
 *
 * Every tile is a conversation opener: clicking one asks about it rather
 * than drilling into a chart, because the product's core verb is asking.
 *
 * A tile whose snapshot failed SAYS SO. It does not disappear and it does
 * not render a stale number as if it were current — `pulseStateService`
 * models that state explicitly and this is the surface that honours it.
 */

import { AlertTriangle, ArrowDown, ArrowUp, Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Sparkline } from './Sparkline';
import type { PulseTile } from './types';

export function Board({
  tiles, onAsk, onEdit,
}: {
  tiles: PulseTile[];
  onAsk: (question: string) => void;
  onEdit: () => void;
}) {
  if (tiles.length === 0) return null;

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <p className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
          Your board
        </p>
        <button
          type="button"
          onClick={onEdit}
          className="font-mono text-[10.5px] tracking-[0.07em] uppercase text-ocean hover:text-ocean-hover hover:underline"
        >
          Edit
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {tiles.slice(0, 8).map((t) => {
          const failed = t.status === 'snapshot_failed';
          const waiting = t.status === 'no_observations_yet';
          const dir = t.prior?.direction ?? 'flat';

          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onAsk(`How is ${t.label} doing?`)}
              className="bg-raised border border-line rounded-[10px] shadow-1 p-3 text-left flex flex-col gap-1.5 transition-colors hover:border-ocean-soft"
            >
              <span className="text-[11.5px] text-muted leading-tight min-h-[30px]">{t.label}</span>

              {failed ? (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-warn">
                  <AlertTriangle className="w-3 h-3 shrink-0" strokeWidth={2} aria-hidden />
                  Couldn&apos;t read it
                </span>
              ) : waiting ? (
                <span className="text-[12px] text-muted-2">First reading tonight</span>
              ) : (
                <>
                  <span className="font-mono text-[19px] font-medium tracking-[-0.02em] tabular-nums text-ink leading-none">
                    {t.currentValueLabel ?? '—'}
                  </span>
                  {t.prior && t.prior.deltaPct != null && (
                    <span
                      className={cn(
                        'font-mono text-[10.5px] tabular-nums inline-flex items-center gap-1',
                        dir === 'flat' ? 'text-muted' : 'text-ink-3',
                      )}
                    >
                      {dir === 'up' ? <ArrowUp className="w-2.5 h-2.5" strokeWidth={2.8} aria-hidden />
                        : dir === 'down' ? <ArrowDown className="w-2.5 h-2.5" strokeWidth={2.8} aria-hidden />
                        : <Minus className="w-2.5 h-2.5" strokeWidth={2.8} aria-hidden />}
                      {`${(t.prior.deltaPct * 100).toFixed(1)}% vs ${t.prior.period}`}
                    </span>
                  )}
                  <Sparkline
                    points={t.sparkline}
                    width={110}
                    height={24}
                    ariaLabel={`${t.label} over the last 30 days`}
                  />
                </>
              )}
            </button>
          );
        })}

        {tiles.length < 4 && (
          <button
            type="button"
            onClick={onEdit}
            className="border border-dashed border-line-strong rounded-[10px] p-3 flex flex-col items-center justify-center gap-1 text-muted hover:border-ocean hover:text-ocean transition-colors min-h-[104px]"
          >
            <Plus className="w-4 h-4" strokeWidth={1.8} aria-hidden />
            <span className="text-[12px]">Watch something else</span>
          </button>
        )}
      </div>
    </section>
  );
}
