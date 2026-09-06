'use client';

/**
 * The two ACT sections of /home, shared by the operator page and the
 * viewer page (9-3): every door in here opens for every role.
 */
import { BarChart3, ChevronRight, Library, Plus, Sparkles, Star } from 'lucide-react';
import { OBSERVATORY } from '@/lib/observatory';
import { formatRelative } from '@/lib/dates';
import type { HomeSummary } from './types';

// ─── Pinned dashboards ─────────────────────────────────────────────────────

export function DashboardsSection({
  dashboards, onJump,
}: {
  dashboards: HomeSummary['dashboards'];
  onJump: (path: string) => void;
}) {
  return (
    <div className="bg-raised border border-line rounded-lg overflow-hidden">
      <header className="px-5 py-3 border-b border-line bg-softer/40 flex items-center justify-between">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Your dashboards</p>
        <button
          onClick={() => onJump('/dashboards')}
          className="text-[11px] font-mono tracking-[0.06em] uppercase text-ocean hover:text-ocean-hover"
        >
          Open all
        </button>
      </header>
      <div className="px-5 py-4">
        {dashboards.length === 0 ? (
          <div className="text-center py-6">
            <BarChart3 className="w-6 h-6 mx-auto mb-2 text-muted-2" strokeWidth={1.5} />
            <p className="text-[13px] text-ink-2 mb-3">No dashboards yet</p>
            <button
              onClick={() => onJump('/dashboards')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
              Build a dashboard
            </button>
          </div>
        ) : (
          <ul className="space-y-1">
            {dashboards.map((d) => (
              <li key={d.id}>
                <button
                  onClick={() => onJump(`/dashboards?id=${d.id}`)}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded hover:bg-softer transition-colors group text-left"
                >
                  {d.starred ? (
                    <Star className="w-3.5 h-3.5 shrink-0" fill={OBSERVATORY.warn} stroke={OBSERVATORY.warn} />
                  ) : (
                    <BarChart3 className="w-3.5 h-3.5 shrink-0 text-muted-2" strokeWidth={1.75} />
                  )}
                  <span className="text-[13px] text-ink truncate flex-1">{d.title}</span>
                  {d.updatedAt && (
                    <span className="text-[10.5px] font-mono text-muted-2 shrink-0">
                      {formatRelative(d.updatedAt)}
                    </span>
                  )}
                  <ChevronRight className="w-3 h-3 text-muted-2 opacity-0 group-hover:opacity-100" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Recent questions ──────────────────────────────────────────────────────

export function RecentQuestionsSection({
  questions, onJump,
}: {
  questions: HomeSummary['recentQuestions'];
  onJump: (path: string) => void;
}) {
  return (
    <div className="bg-raised border border-line rounded-lg overflow-hidden">
      <header className="px-5 py-3 border-b border-line bg-softer/40 flex items-center justify-between">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Recent questions</p>
        <button
          onClick={() => onJump('/query')}
          className="text-[11px] font-mono tracking-[0.06em] uppercase text-ocean hover:text-ocean-hover inline-flex items-center gap-1"
        >
          <Sparkles className="w-3 h-3" strokeWidth={2} /> Ask a new one
        </button>
      </header>
      <div className="px-5 py-4">
        {questions.length === 0 ? (
          <div className="text-center py-6">
            <Sparkles className="w-6 h-6 mx-auto mb-2 text-muted-2" strokeWidth={1.5} />
            <p className="text-[13px] text-ink-2 mb-3">No questions yet</p>
            <button
              onClick={() => onJump('/query')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
              Ask the AI
            </button>
          </div>
        ) : (
          <ul className="space-y-1">
            {questions.map((q) => (
              <li key={q.id}>
                <button
                  onClick={() => onJump(`/query?conversationId=${q.id}`)}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded hover:bg-softer transition-colors group text-left"
                >
                  <Library className="w-3.5 h-3.5 shrink-0 text-muted-2" strokeWidth={1.75} />
                  <span className="text-[13px] text-ink truncate flex-1">
                    {q.title || 'Untitled question'}
                  </span>
                  {q.lastMessageAt && (
                    <span className="text-[10.5px] font-mono text-muted-2 shrink-0">
                      {formatRelative(q.lastMessageAt)}
                    </span>
                  )}
                  <ChevronRight className="w-3 h-3 text-muted-2 opacity-0 group-hover:opacity-100" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

