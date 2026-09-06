'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { ChevronRight, Layers, MessageSquare } from 'lucide-react';
import { formatRelative } from '@/lib/dates';
import type { HomeSummary } from './types';
import { DashboardsSection, RecentQuestionsSection } from './sections';

const MorningBriefCard = dynamic(() => import('@/components/briefs/MorningBriefCard'), { ssr: false });

// ─── Viewer home (9-3) ──────────────────────────────────────────────────────
//
// What a viewer sees: no scores, no counts of things they cannot curate, no
// link to a page that would answer "not authorized". Every door here opens
// for a viewer: Ask AI, dashboards, subjects, the brief.

export function ViewerHome({
  summary, userName, today, onJump,
}: {
  summary: HomeSummary;
  userName: string;
  today: string;
  onJump: (path: string) => void;
}) {
  const [question, setQuestion] = useState('');
  const ask = () => {
    const q = question.trim();
    onJump(q ? `/query?q=${encodeURIComponent(q)}&autoSubmit=1` : '/query');
  };

  // "How current is what I am looking at?" — the newest successful sync
  // across every source, in words. Nothing to click: the refresh is not
  // the viewer's to trigger, and saying so honestly beats a dead button.
  const newest = summary.freshness.allSources
    .map((s) => s.lastSyncedAt)
    .filter((d): d is string => !!d)
    .sort()
    .pop();
  const stale = summary.freshness.stale.length + summary.freshness.staleProducts.length;
  const dataLine = summary.freshness.allSources.length === 0
    ? 'Your team has not connected a source yet.'
    : newest
      ? `Data as of ${formatRelative(newest)}${stale > 0 ? ` · ${stale} item${stale === 1 ? '' : 's'} waiting on a refresh` : ''}`
      : 'No data has arrived yet.';

  return (
    <div className="flex-1 overflow-auto bg-bg" data-testid="viewer-home">
      <div className="max-w-4xl mx-auto px-6 pt-10 pb-12">
        <div className="mb-6">
          <p className="text-[11px] font-mono tracking-[0.14em] uppercase text-muted mb-1">{today}</p>
          <h1 className="font-display text-[32px] text-ink leading-tight tracking-[-0.02em]">
            {userName ? `Welcome back, ${userName}` : 'Welcome back'}
          </h1>
          <p className="text-[12.5px] text-muted mt-1.5">{dataLine}</p>
        </div>

        <div className="mb-6 flex h-[44px] items-center gap-2.5 rounded-[10px] border border-line bg-raised pl-3.5 pr-1.5 shadow-1">
          <MessageSquare className="h-[15px] w-[15px] shrink-0 text-muted-2" strokeWidth={1.7} aria-hidden />
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') ask(); }}
            placeholder="Ask a question about your business…"
            aria-label="Ask a question"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-muted-2 focus:outline-none"
          />
          <button type="button" onClick={ask} className="shrink-0 rounded-[8px] bg-ocean px-4 py-2 text-[13px] font-medium text-white hover:opacity-90">
            Ask
          </button>
        </div>

        <section className="mb-6">
          <MorningBriefCard />
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <DashboardsSection dashboards={summary.dashboards} onJump={onJump} />
          <RecentQuestionsSection questions={summary.recentQuestions} onJump={onJump} />
        </section>

        <button
          type="button"
          onClick={() => onJump('/subjects')}
          className="group w-full flex items-center gap-3 rounded-[10px] border border-line bg-raised px-4 py-3.5 text-left transition-colors hover:border-ocean"
        >
          <Layers className="h-4 w-4 shrink-0 text-muted-2" strokeWidth={1.7} aria-hidden />
          <span className="flex-1">
            <span className="block text-[13.5px] text-ink">Subjects</span>
            <span className="block text-[12px] text-muted">Everything your team can ask about, in one place.</span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-2 group-hover:text-ocean" />
        </button>
      </div>
    </div>
  );
}

