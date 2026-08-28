'use client';

/**
 * Thread list for /query — rendered in the page's left rail (and, on mobile,
 * inside the slide-over). Content-only layout: the parent owns width, chrome
 * and borders.
 *
 * Shape follows the nav rail's vocabulary — full-bleed rows with a left
 * accent bar marking the open thread — so the two panels read as one surface.
 * A thread title is a QUESTION, so it wraps to two lines rather than
 * truncating: the tail of "Which suppliers have the highest…" is the half
 * that tells you which thread this is.
 */

import { Plus, X, Star } from 'lucide-react';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';
import type { Conversation } from './types';

interface ChatSidebarProps {
  conversations:      Conversation[];
  activeId:           number | null;
  onSelect:           (id: number) => void;
  onNew:              () => void;
  onDelete:           (id: number) => void;
  onStar:             (id: number) => void;
  starFilter:         boolean;
  onToggleStarFilter: () => void;
}

export default function ChatSidebar({
  conversations, activeId, onSelect, onNew, onDelete, onStar, starFilter, onToggleStarFilter,
}: ChatSidebarProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Header + actions */}
      <div className="flex-shrink-0 px-4 pt-4 pb-3">
        {/* The starred filter rides the eyebrow as an icon toggle instead of
            taking a row of its own — it is a lens on the list, not an action
            of the same weight as starting a thread. */}
        <div className="flex items-center justify-between mb-2.5">
          <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted-2">Threads</p>
          <button
            onClick={onToggleStarFilter}
            aria-pressed={starFilter}
            title={starFilter ? 'Show all threads' : 'Show starred only'}
            className={cn(
              '-mr-1 p-1 rounded transition-colors',
              starFilter ? 'text-amber-500' : 'text-muted-2 hover:text-ink-2',
            )}
          >
            <Star className="w-3.5 h-3.5" strokeWidth={1.8} fill={starFilter ? 'currentColor' : 'none'} />
          </button>
        </div>

        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-md border border-line bg-raised text-ink text-[13.5px] font-medium hover:border-line-strong hover:bg-softer transition-colors"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2} />
          New thread
        </button>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin pb-2">
        {conversations.length === 0 && (
          <p className="text-center text-[11px] font-mono tracking-[0.08em] uppercase text-muted-2 mt-6 px-4 leading-relaxed">
            {starFilter ? 'No starred threads' : 'Your threads will appear here'}
          </p>
        )}
        {conversations.map((conv) => {
          const active = conv.id === activeId;
          return (
            <div
              key={conv.id}
              className={cn(
                'group relative flex items-start gap-2 border-l-2 pl-3.5 pr-2.5 py-3 cursor-pointer transition-colors',
                active ? 'border-ocean bg-ocean-softer' : 'border-transparent hover:bg-softer',
              )}
              onClick={() => onSelect(conv.id)}
            >
              <div className="flex-1 min-w-0">
                <p className={cn(
                  'text-[14px] leading-[1.35] line-clamp-2',
                  active ? 'text-ink font-medium' : 'text-ink-2',
                )}>
                  {conv.starred && (
                    <Star
                      className="inline-block w-3 h-3 mr-1 -mt-0.5 text-amber-500 align-middle"
                      fill="currentColor"
                      strokeWidth={0}
                      aria-label="Starred"
                    />
                  )}
                  {conv.title}
                </p>
                <p className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted-2 mt-1.5">
                  {formatRelative(conv.updatedAt)}
                </p>
              </div>
              {/* Row actions stay in flow (not absolutely positioned) so the
                  wrapping title never runs underneath them. */}
              <div className="flex-shrink-0 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button
                  onClick={(e) => { e.stopPropagation(); onStar(conv.id); }}
                  className="p-0.5 rounded text-muted-2 hover:text-amber-500 transition-colors"
                  title={conv.starred ? 'Unstar' : 'Star'}
                >
                  <Star className="w-3.5 h-3.5" strokeWidth={1.8} fill={conv.starred ? 'currentColor' : 'none'} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(conv.id); }}
                  className="p-0.5 rounded text-muted-2 hover:text-err transition-colors"
                  title="Delete"
                >
                  <X className="w-3.5 h-3.5" strokeWidth={2} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
