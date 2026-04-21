'use client';

/**
 * Conversation list for /query — slotted into AppShell's `contextPanel`.
 * Content-only layout (no chrome) so AppShell controls width + borders.
 */

import { Plus, X } from 'lucide-react';
import { formatRelative } from '@/lib/dates';
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
      <div className="flex-shrink-0 px-4 pt-5 pb-3">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-3">Conversations</p>

        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-ocean text-white text-[13px] font-medium rounded-md hover:bg-ocean-hover transition-colors"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2} />
          New chat
        </button>

        <button
          onClick={onToggleStarFilter}
          className={`mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] font-mono tracking-[0.08em] uppercase rounded-md transition-colors ${
            starFilter
              ? 'text-ocean bg-ocean-softer'
              : 'text-muted hover:text-ink-2 hover:bg-softer'
          }`}
        >
          <span>{starFilter ? '★' : '☆'}</span>
          {starFilter ? 'Showing starred' : 'Show starred'}
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin pt-1 pb-2">
        {conversations.length === 0 && (
          <p className="text-center text-[11px] font-mono tracking-[0.08em] uppercase text-muted-2 mt-6 px-4 leading-relaxed">
            {starFilter ? 'No starred conversations' : 'Your conversations will appear here'}
          </p>
        )}
        {conversations.map((conv) => {
          const active = conv.id === activeId;
          return (
            <div
              key={conv.id}
              className={`group relative flex items-start gap-2 px-4 py-2.5 cursor-pointer transition-colors border-l-2 ${
                active ? 'bg-ocean-softer border-ocean' : 'border-transparent hover:bg-softer'
              }`}
              onClick={() => onSelect(conv.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  {conv.starred && <span className="text-amber-500 text-[11px] flex-shrink-0">★</span>}
                  <p className={`text-[13px] truncate leading-snug ${active ? 'text-ink font-medium' : 'text-ink-2'}`}>
                    {conv.title}
                  </p>
                </div>
                <p className="text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2 mt-1">
                  {formatRelative(conv.updatedAt)}
                </p>
              </div>
              <div className="flex-shrink-0 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-all mt-0.5">
                <button
                  onClick={(e) => { e.stopPropagation(); onStar(conv.id); }}
                  className="p-0.5 rounded text-muted-2 hover:text-amber-500 transition-colors"
                  title={conv.starred ? 'Unstar' : 'Star'}
                >
                  <span className="text-[11px]">{conv.starred ? '★' : '☆'}</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(conv.id); }}
                  className="p-0.5 rounded text-muted-2 hover:text-err transition-colors"
                  title="Delete"
                >
                  <X className="w-3 h-3" strokeWidth={2} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
