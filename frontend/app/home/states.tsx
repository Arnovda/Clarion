'use client';

/**
 * The two states that are not "something moved".
 *
 * Both are deliberately given real content rather than being rendered as
 * empty space, because they are the states most users are in most of the
 * time — and the cold start is the one that decides whether anybody comes
 * back tomorrow.
 */

import { CheckCircle2, ChevronRight, Sparkles } from 'lucide-react';
import type { BriefBullet } from './types';

// ─── Quiet ──────────────────────────────────────────────────────────────────

/**
 * "Nothing needs you this morning."
 *
 * THIS IS A SUCCESS STATE, NOT AN EMPTY ONE. A briefing that always finds
 * three things is a briefing nobody believes; being willing to say "all
 * quiet" is what makes the loud mornings credible, and it is the direct
 * mitigation for the alert fatigue that kills features like this.
 *
 * The steady bullets are shown as reassurance — small, muted, and never
 * promoted into cards, because the absence of cards is the message.
 */
export function QuietCard({ bullets }: { bullets: BriefBullet[] }) {
  const steady = bullets.filter((b) => b.kind === 'steady').slice(0, 3);

  return (
    <div className="flex gap-3.5 items-start rounded-[10px] border border-line bg-raised p-5">
      <CheckCircle2 className="w-5 h-5 shrink-0 text-ok mt-px" strokeWidth={1.8} aria-hidden />
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold text-ink mb-1">Everything is where it should be.</h3>
        <p className="text-[13px] text-ink-3 leading-relaxed">
          Nothing you watch moved outside its normal range overnight, and the
          numbers below are current.
        </p>
        {steady.length > 0 && (
          <ul className="mt-2.5 pl-4 list-disc text-[12.5px] text-muted leading-relaxed">
            {steady.map((b) => (
              <li key={b.label}>
                {b.label} — {b.detail}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Cold start ─────────────────────────────────────────────────────────────

/**
 * Day one, or the morning before the first reading.
 *
 * There is no data to show, so showing an empty dashboard would be the
 * worst option available — that is where most products lose the user. We
 * say what happens overnight instead, and make the ask box the only thing
 * to do. Every question asked today is what makes tomorrow's page good, and
 * telling the user that is what earns the second visit.
 */
export function ColdStartCard({
  tone, curator, onJump,
}: {
  tone: 'cold' | 'waiting';
  curator: boolean;
  onJump: (path: string) => void;
}) {
  const steps = tone === 'cold'
    ? [
        'I take a reading of every number you ask about, so tomorrow I can tell you what changed.',
        'I compare each one against its own history — not a threshold someone guessed, your own normal.',
        'Where something moved, I work out why before you ask, and leave the answer here.',
      ]
    : [
        'Tonight at 06:00 I take the first full set of readings.',
        'From tomorrow I can compare each number against its own history.',
        'Anything that moves gets explained here before you ask.',
      ];

  return (
    <div className="rounded-[10px] bg-ocean px-5 py-4 shadow-2">
      <p className="font-mono text-[9.5px] tracking-[0.14em] uppercase text-ocean-soft/80 mb-3">
        {tone === 'cold' ? "While you're asleep" : 'Starting tonight'}
      </p>
      <ol className="flex flex-col gap-2.5">
        {steps.map((s, i) => (
          <li key={s} className="flex gap-3 text-[13px] leading-relaxed text-[#dfeaee]">
            <span
              className="shrink-0 grid place-items-center w-[19px] h-[19px] mt-px rounded-full bg-white/[0.13] font-mono text-[9.5px] text-[#cfe0e6]"
              aria-hidden
            >
              {i + 1}
            </span>
            <span>{s}</span>
          </li>
        ))}
      </ol>

      {tone === 'cold' && curator && (
        <button
          type="button"
          onClick={() => onJump('/sources')}
          className="mt-4 inline-flex items-center gap-1.5 rounded-[6px] bg-white/[0.12] px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-white/20 transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
          Connect a source
          <ChevronRight className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
        </button>
      )}
    </div>
  );
}
