'use client';

/**
 * "What moved" — the cards under the lead.
 *
 * One card per brief bullet that says something happened. Each carries the
 * movement, a sparkline from the matching pulse entry, and two doors:
 *
 *   Why?      → the investigation. When the overnight job already ran this
 *               one (R2), the button says so and the panel REPLAYS the
 *               stored trail — no model call, and the answer is on screen
 *               in the time it takes to open a slide-over. Otherwise it
 *               starts a fresh run, which is the pre-R2 behaviour.
 *   Show me   → the chat, with the question already asked.
 *
 * Severity is carried by a left stripe AND a worded tag, never colour alone.
 */

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { AlertCircle, ArrowDown, ArrowUp, Clock, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/dates';
import { Sparkline } from './Sparkline';
import type { BriefBullet, BriefInvestigation, HomeAlert, PulseTile } from './types';
import type { HomeCard } from './lead';

const InvestigationPanel = dynamic(
  () => import('@/components/investigate/InvestigationPanel'),
  { ssr: false },
);

/**
 * Which pulse entry a bullet is about. The brief's output carries only the
 * label (the prompt asks for "the metric name as the user wrote it"), so
 * the join is by name, case- and space-insensitively. A miss is fine — the
 * card simply renders without a sparkline.
 */
export function tileForBullet(bullet: BriefBullet, tiles: PulseTile[]): PulseTile | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const want = norm(bullet.label);
  return tiles.find((t) => norm(t.label) === want)
    ?? tiles.find((t) => norm(t.label).includes(want) || want.includes(norm(t.label)))
    ?? null;
}

/**
 * Which investigation explains a bullet.
 *
 * The overnight job builds its question as `Why did <label> change?` and
 * ALSO stores the bare label in `focus`, so containment on the question is
 * an exact match in practice. (`focus` is not on the wire — the question
 * already carries it, and a second copy would be a second thing to keep in
 * step.) The index fallback covers briefs written before R2, where the job
 * always investigated the top mover.
 */
export function investigationForBullet(
  bullet: BriefBullet,
  index: number,
  investigation: BriefInvestigation | null | undefined,
): BriefInvestigation | null {
  if (!investigation || investigation.status !== 'concluded') return null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (investigation.question && norm(investigation.question).includes(norm(bullet.label))) return investigation;
  return index === 0 ? investigation : null;
}

function toneOf(bullet: BriefBullet): 'warn' | 'high' {
  return bullet.kind === 'warn' ? 'high' : 'warn';
}

export function MovementCards({
  cards, tiles, investigation, onAsk, onJump,
}: {
  cards: HomeCard[];
  tiles: PulseTile[];
  investigation: BriefInvestigation | null | undefined;
  onAsk: (question: string) => void;
  onJump: (path: string) => void;
}) {
  const [investigating, setInvestigating] = useState<
    { existingId?: number; question?: string; focus?: string | null; productId?: number; pulseEntryId?: number | null } | null
  >(null);

  if (cards.length === 0) return null;

  return (
    <>
      <div className="flex flex-col gap-2.5">
        {cards.map((card, i) => {
          if (card.source === 'alert') {
            return <AlertCard key={`alert-${card.alert.id}`} alert={card.alert} onJump={onJump} />;
          }
          const b = card.bullet;
          const tile = tileForBullet(b, tiles);
          const known = investigationForBullet(b, i, investigation);
          const sev = toneOf(b);
          // No matching pulse entry means we know the delta but not its
          // direction — so no arrow, rather than a misleading flat one.
          const dir = tile?.prior?.direction ?? null;
          const question = `Why did ${b.label} change?`;

          return (
            <article
              key={`${b.label}-${i}`}
              className={cn(
                'bg-raised border border-line rounded-[10px] shadow-1 overflow-hidden border-l-[3px]',
                sev === 'high' ? 'border-l-err' : 'border-l-warn',
              )}
            >
              <div className="px-4 py-3.5 flex gap-4 items-start">
                <div className="flex-1 min-w-0">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 mb-1 font-mono text-[9.5px] tracking-[0.12em] uppercase',
                      sev === 'high' ? 'text-err' : 'text-warn',
                    )}
                  >
                    {sev === 'high'
                      ? <AlertCircle className="w-[11px] h-[11px]" strokeWidth={2.2} aria-hidden />
                      : <Clock className="w-[11px] h-[11px]" strokeWidth={2.2} aria-hidden />}
                    {sev === 'high' ? 'Needs a decision' : 'Worth watching'}
                  </span>
                  <h3 className="text-[14.5px] font-semibold text-ink leading-snug mb-1">{b.label}</h3>
                  <p className="text-[13px] text-ink-3 leading-relaxed">{b.detail}</p>
                </div>

                <div className="shrink-0 flex flex-col items-end gap-1">
                  {b.delta && b.delta !== '—' && (
                    <span
                      className={cn(
                        'font-mono text-[11.5px] tabular-nums inline-flex items-center gap-1',
                        dir === 'up' ? 'text-err' : dir === 'down' ? 'text-err' : 'text-muted',
                      )}
                    >
                      {dir === 'up' ? <ArrowUp className="w-2.5 h-2.5" strokeWidth={2.6} aria-hidden />
                        : dir === 'down' ? <ArrowDown className="w-2.5 h-2.5" strokeWidth={2.6} aria-hidden />
                        : null}
                      {b.delta}
                    </span>
                  )}
                  {tile && (
                    <Sparkline
                      points={tile.sparkline}
                      tone={dir === 'up' || dir === 'down' ? dir : 'neutral'}
                      ariaLabel={`${b.label} over the last 30 days`}
                    />
                  )}
                </div>
              </div>

              <div className="border-t border-softer bg-surface/60 px-4 py-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setInvestigating(
                    known
                      ? { existingId: known.id }
                      : {
                          question,
                          focus: b.label,
                          productId: tile?.links.productId ?? undefined,
                          pulseEntryId: tile?.id ?? null,
                        },
                  )}
                  className={cn(
                    'text-[12px] px-2.5 py-1 rounded-[6px] border transition-colors inline-flex items-center gap-1.5',
                    known
                      ? 'bg-ocean-softer border-ocean-soft text-ocean font-medium hover:bg-ocean-soft'
                      : 'bg-raised border-line text-ink-2 hover:border-ocean hover:text-ocean',
                  )}
                >
                  <Search className="w-3 h-3" strokeWidth={2} aria-hidden />
                  {known ? 'Why? — already worked out' : 'Why?'}
                </button>
                <button
                  type="button"
                  onClick={() => onAsk(`Show me ${b.label}`)}
                  className="text-[12px] px-2.5 py-1 rounded-[6px] border border-line bg-raised text-ink-2 hover:border-ocean hover:text-ocean transition-colors"
                >
                  Show me
                </button>
                <span className="flex-1" />
                {tile?.asOf && (
                  <span className="font-mono text-[10px] text-muted-2 tracking-[0.04em]">
                    AS OF {tile.asOf}
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {investigating && (
        <InvestigationPanel
          open
          onClose={() => setInvestigating(null)}
          existingId={investigating.existingId}
          question={investigating.question}
          focus={investigating.focus ?? null}
          dataProductId={investigating.productId}
          pulseEntryId={investigating.pulseEntryId ?? null}
        />
      )}
    </>
  );
}

/**
 * A quality alert as a card.
 *
 * Renders `aiContext` — Claude's plain-English explanation — as the body,
 * because that is the entire difference between "Gross margin on SKU dropped
 * 14%" and "…likely a unit-of-measure mismatch on the supplier import". The
 * raw message becomes the title, and is the fallback body when no context
 * was written.
 *
 * Deliberately no "Why?": the alert already carries its explanation, and
 * offering to investigate a thing we have already explained would spend a
 * model call to say the same sentence again.
 */
function AlertCard({ alert, onJump }: { alert: HomeAlert; onJump: (path: string) => void }) {
  const critical = (alert.severity ?? '').toLowerCase() === 'critical';
  return (
    <article
      className={cn(
        'bg-raised border border-line rounded-[10px] shadow-1 overflow-hidden border-l-[3px]',
        critical ? 'border-l-err' : 'border-l-warn',
      )}
    >
      <div className="px-4 py-3.5">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 mb-1 font-mono text-[9.5px] tracking-[0.12em] uppercase',
            critical ? 'text-err' : 'text-warn',
          )}
        >
          <AlertCircle className="w-[11px] h-[11px]" strokeWidth={2.2} aria-hidden />
          {critical ? 'Needs a decision' : 'Data quality'}
        </span>
        <h3 className="text-[14.5px] font-semibold text-ink leading-snug mb-1">{alert.message}</h3>
        {alert.aiContext && (
          <p className="text-[13px] text-ink-3 leading-relaxed">{alert.aiContext}</p>
        )}
      </div>
      <div className="border-t border-softer bg-surface/60 px-4 py-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onJump('/health')}
          className="text-[12px] px-2.5 py-1 rounded-[6px] border border-line bg-raised text-ink-2 hover:border-ocean hover:text-ocean transition-colors"
        >
          Look at the data
        </button>
        <span className="flex-1" />
        {alert.createdAt && (
          <span className="font-mono text-[10px] text-muted-2 tracking-[0.04em]">
            {formatRelative(alert.createdAt).toUpperCase()}
          </span>
        )}
      </div>
    </article>
  );
}
