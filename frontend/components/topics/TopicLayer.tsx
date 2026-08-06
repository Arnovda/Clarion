'use client';

/**
 * <TopicLayer> — screen 1 of the topic-first experience.
 *
 * The business user's home for a subject area. It answers four things in
 * order: what can I ask about, what exactly can I find out, is it current,
 * can I trust it.
 *
 * HARD RULES for anything added to this file:
 *   • No SQL. Not in a tooltip, not behind a toggle, not ever.
 *   • No warehouse vocabulary — "table", "fact", "dimension", "star schema",
 *     "data product", "bus matrix" are all banned from user-visible copy.
 *   • No counts of tables or rows. A row count answers a question nobody on
 *     this screen is asking.
 * Everything technical lives one door away, in Manage mode.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight, MessageSquare, SlidersHorizontal } from 'lucide-react';
import { iconForAnalytics } from '@/components/catalog/entityIcons';
import { formatRelativeLong } from '@/lib/dates';
import { cn } from '@/lib/cn';
import type { Topic } from '@/app/topics/types';

interface Props {
  topic: Topic;
  /** Analyst+ — shows the "Manage this data" affordance. */
  canManage: boolean;
  /** Enter Manage mode, optionally straight onto a tab. */
  onManage: (tab?: 'quality') => void;
}

/** Ask AI, scoped to this topic, optionally with the question pre-filled. */
function askHref(topic: Topic, question?: string): string {
  const params = new URLSearchParams({
    productId: String(topic.id),
    productName: topic.name,
  });
  if (question) {
    params.set('q', question);
    // The topic page's whole promise is that clicking a question answers it.
    // Landing on a pre-filled box the user still has to submit breaks that.
    params.set('autoSubmit', '1');
  }
  return `/query?${params.toString()}`;
}

/**
 * A lens label as it reads mid-sentence: "Customer" → "customer", but
 * "GL account" stays "GL account". Blindly lower-casing would mangle the
 * acronyms that make up half of an accounting vocabulary.
 */
function inSentence(label: string): string {
  const [first = ''] = label.split(' ');
  const isAcronym = first.length > 1 && first === first.toUpperCase();
  return isAcronym ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * The trust sentence. Three tones, and the wording changes with the tone —
 * a red dot next to "Matches Exact Online" would be a contradiction.
 */
function trustSentence(topic: Topic): string {
  const sourceName = topic.source?.name ?? 'your source system';
  const { state, lastBuiltAt, sourceSyncedAt, failedTables } = topic.freshness;
  const when = formatRelativeLong(lastBuiltAt ?? sourceSyncedAt);
  if (state === 'err') {
    return failedTables > 0
      ? `Last matched ${sourceName} ${when} — refresh pending`
      : `Could not match ${sourceName} — refresh pending`;
  }
  if (state === 'warn') {
    if (!lastBuiltAt) return `Not matched against ${sourceName} yet`;
    return `Last matched ${sourceName} ${when} — refresh pending`;
  }
  return `Matches ${sourceName} as of ${when}`;
}

export default function TopicLayer({ topic, canManage, onManage }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  // Viewers can't enter Manage mode, so "see data quality" resolves to a
  // read-only summary inline. A link that does nothing for two thirds of
  // the users is worse than no link.
  const [qualityOpen, setQualityOpen] = useState(false);
  const Glyph = iconForAnalytics(topic.name);

  const dotTone =
    topic.freshness.state === 'ok' ? 'bg-ok'
      : topic.freshness.state === 'warn' ? 'bg-warn'
        : 'bg-err';

  function submitAsk(e: React.FormEvent) {
    e.preventDefault();
    const q = draft.trim();
    router.push(q ? askHref(topic, q) : askHref(topic));
  }

  return (
    <div className="absolute inset-0 overflow-y-auto px-10 pt-[60px] pb-10">
      <div className="mx-auto flex max-w-[720px] flex-col gap-[30px]">

        {/* 1 — Identity */}
        <div className="flex flex-col items-center gap-2.5 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-[10px] bg-ocean-softer text-ocean">
            <Glyph className="h-[22px] w-[22px]" strokeWidth={1.6} aria-hidden />
          </div>
          <h1 className="font-display text-[38px] font-normal leading-[1.15] tracking-[-0.02em] text-ink">
            {topic.name}
          </h1>
          {topic.description && (
            <p className="max-w-[520px] text-[15px] leading-[1.6] text-ink-3 [text-wrap:pretty]">
              {topic.description}
            </p>
          )}
        </div>

        {/* 2 — Ask box */}
        <form
          onSubmit={submitAsk}
          className="flex items-center gap-2.5 rounded-[10px] border border-line bg-raised px-[18px] py-3.5"
        >
          <MessageSquare className="h-4 w-4 shrink-0 text-muted-2" strokeWidth={1.6} aria-hidden />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Ask anything about ${topic.name}…`}
            aria-label={`Ask anything about ${topic.name}`}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-muted-2 focus:outline-none"
          />
          <button
            type="submit"
            className="shrink-0 rounded-sm bg-ocean px-3.5 py-2 text-[13px] font-medium text-white transition-colors duration-1 ease-observatory hover:bg-ocean-hover"
          >
            Ask
          </button>
        </form>

        {/* 3 — Try asking */}
        <div className="flex flex-col gap-2.5">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">
            Try asking
          </div>
          {topic.questions.length === 0 ? (
            <p className="text-[14px] text-ink-3">No saved questions yet — ask anything above.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {topic.questions.slice(0, 4).map((q) => (
                <button
                  key={q.kpiId}
                  type="button"
                  onClick={() => router.push(askHref(topic, q.text))}
                  className={cn(
                    'group flex items-center gap-3 rounded-lg border border-line bg-raised px-[18px] py-[15px] text-left',
                    'transition-colors duration-1 ease-observatory hover:border-ocean hover:text-ocean',
                  )}
                >
                  <span className="min-w-0 flex-1 text-[15.5px] text-ink group-hover:text-ocean">
                    {q.text}
                  </span>
                  <ArrowRight
                    className="h-[15px] w-[15px] shrink-0 text-muted-2 group-hover:text-ocean"
                    strokeWidth={1.75}
                    aria-hidden
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 4 — Break-down line */}
        {topic.dimensions.length > 0 && (
          <p className="text-center text-[14px] leading-[1.6] text-ink-3">
            Break any of this down by{' '}
            {topic.dimensions.map((dim, i) => {
              const last = i === topic.dimensions.length - 1;
              const penultimate = i === topic.dimensions.length - 2;
              return (
                <span key={dim}>
                  <button
                    type="button"
                    onClick={() => router.push(askHref(topic, `${topic.name} by ${inSentence(dim)}`))}
                    className="border-b border-line text-ink-2 transition-colors duration-1 ease-observatory hover:border-ocean hover:text-ocean"
                  >
                    {inSentence(dim)}
                  </button>
                  {last ? '.' : penultimate ? ' or ' : ', '}
                </span>
              );
            })}
          </p>
        )}

        {/* 5 — Trust line */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-[18px]">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2.5 text-[12.5px] text-muted">
              <span className={cn('h-[7px] w-[7px] shrink-0 rounded-full', dotTone)} aria-hidden />
              <span>
                {trustSentence(topic)}
                {' · '}
                <button
                  type="button"
                  onClick={() => (canManage ? onManage('quality') : setQualityOpen((v) => !v))}
                  aria-expanded={canManage ? undefined : qualityOpen}
                  className="text-ocean underline-offset-2 hover:underline"
                >
                  see data quality
                </button>
              </span>
            </div>
            {!canManage && qualityOpen && (
              <p className="pl-[17px] text-[12.5px] text-muted">
                {(topic.quality?.checksTotal ?? 0) > 0
                  ? `${topic.quality.checksPassing} of ${topic.quality.checksTotal} data checks passing`
                  : 'No data checks have run yet'}
                {topic.freshness.lastBuiltAt
                  ? ` · last refreshed ${formatRelativeLong(topic.freshness.lastBuiltAt)}`
                  : ''}
              </p>
            )}
          </div>
          {canManage && (
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-2">
                Only you can see this
              </span>
              <button
                type="button"
                onClick={() => onManage()}
                className={cn(
                  'flex shrink-0 items-center gap-[7px] whitespace-nowrap rounded-sm border border-line bg-raised px-3 py-2 text-[12.5px] text-ink-2',
                  'transition-colors duration-1 ease-observatory hover:border-ocean hover:bg-ocean-softer hover:text-ocean',
                )}
              >
                <SlidersHorizontal className="h-[13px] w-[13px]" strokeWidth={1.75} aria-hidden />
                Manage this data
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
