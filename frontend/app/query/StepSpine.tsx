'use client';

/**
 * StepSpine — the worksheet's left thread rail (spec §1, §4.1, §4.5–4.6, §6).
 *
 * Renders the step tree flattened depth-first: a branch's subtree sits
 * indented under its parent (indent capped at MAX_INDENT, dashed rule).
 * Steps positioned AFTER the selected one render muted so the reader can
 * see there is more ahead of them; selecting an ancestor never hides its
 * descendants.
 *
 * Above 12 steps the spine COLLAPSES everything except the first step,
 * the selection and its ancestors, the last three, and starred steps —
 * hidden runs fold to one "N earlier steps" row that expands in place
 * (steps.ts collapseSpine, pure).
 *
 * Double-clicking a label renames it inline (Enter commits, Escape
 * cancels, empty reverts to the auto label). Hovering a row surfaces the
 * star toggle — starred steps are exempt from collapsing.
 *
 * Accessibility: role="tree"/"treeitem" with aria-level/aria-selected,
 * roving tabindex, ↑/↓ move the selection, Home/End jump, Enter is the
 * button's native activation. Colour never carries meaning alone — the
 * selected step has a filled dot AND a background; warning dots carry a
 * title.
 */

import { useRef, useState } from 'react';
import { Star } from 'lucide-react';
import type { Step } from './steps';
import { MAX_INDENT, collapseSpine } from './steps';

export const PENDING_STEP_ID = -1;

function Dot({ state }: { state: 'selected' | 'idle' | 'pending' | 'warn' }) {
  if (state === 'pending') {
    return (
      <span className="relative w-2 h-2 shrink-0 motion-safe:block" aria-hidden="true">
        <span className="absolute inset-0 rounded-full bg-ocean motion-safe:animate-ping opacity-40" />
        <span className="absolute inset-0 rounded-full bg-ocean" />
      </span>
    );
  }
  if (state === 'warn') {
    return <span className="w-2 h-2 rounded-full bg-warn shrink-0" title="This step hit a problem" />;
  }
  if (state === 'selected') {
    return <span className="w-2 h-2 rounded-full bg-ocean shrink-0" aria-hidden="true" />;
  }
  return <span className="w-2 h-2 rounded-full border border-line-strong bg-transparent shrink-0" aria-hidden="true" />;
}

export default function StepSpine({
  steps, selectedId, onSelect, onBranchHere, branchCount, onToggleStar, onRename,
}: {
  /** Flattened display order (deriveSteps → flattenSteps). */
  steps: Step[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Focus the ask input — the "+ branch here" affordance. */
  onBranchHere: () => void;
  branchCount: number;
  onToggleStar: (step: Step) => void;
  /** null = revert to the auto label. */
  onRename: (step: Step, label: string | null) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  // Collapsed runs the user expanded in place — session-local view state.
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');

  const rows = collapseSpine(steps, selectedId, expandedRuns);
  const selectedIndex = steps.findIndex((s) => s.id === selectedId);

  function moveSelection(nextIndex: number) {
    const clamped = Math.max(0, Math.min(steps.length - 1, nextIndex));
    const target = steps[clamped];
    if (!target) return;
    onSelect(target.id);
    const el = listRef.current?.querySelector<HTMLButtonElement>(`[data-step="${target.id}"]`);
    el?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (editingId != null) return; // don't steal keys from the rename input
    const cur = selectedIndex >= 0 ? selectedIndex : 0;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(cur + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(cur - 1); }
    else if (e.key === 'Home') { e.preventDefault(); moveSelection(0); }
    else if (e.key === 'End') { e.preventDefault(); moveSelection(steps.length - 1); }
  }

  function commitRename(step: Step) {
    const v = editValue.trim();
    setEditingId(null);
    onRename(step, v ? v : null); // empty reverts to the auto label
  }

  return (
    <nav aria-label="Steps in this thread" className="h-full flex flex-col">
      <p className="px-3 pt-4 pb-2 font-mono text-[10px] lowercase tracking-[0.1em] text-muted-2">this thread</p>
      <ul
        ref={listRef}
        role="tree"
        onKeyDown={onKeyDown}
        className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-0.5 min-h-0"
      >
        {rows.map((row) => {
          if (row.kind === 'collapsed') {
            return (
              <li key={`run-${row.key}`} role="none">
                <button
                  type="button"
                  aria-expanded={false}
                  onClick={() => setExpandedRuns((prev) => new Set(prev).add(row.key))}
                  className="w-full text-left rounded-md px-2 py-1.5 pl-[30px] font-mono text-[10.5px] lowercase tracking-[0.06em] text-muted-2 hover:text-ink-3 hover:bg-softer transition-colors"
                >
                  ⌄ {row.steps.length} earlier step{row.steps.length === 1 ? '' : 's'}
                </button>
              </li>
            );
          }
          const s = row.step;
          const i = steps.indexOf(s);
          const isSelected = s.id === selectedId;
          const isPending = s.id === PENDING_STEP_ID;
          const afterSelection = selectedIndex >= 0 && i > selectedIndex;
          const indent = Math.min(s.depth, MAX_INDENT);
          const isEditing = editingId === s.id;
          return (
            <li key={s.id} role="none" className="group/step">
              <div className="relative">
                <button
                  type="button"
                  role="treeitem"
                  aria-level={s.depth + 1}
                  aria-selected={isSelected}
                  data-step={s.id}
                  tabIndex={isSelected || (selectedIndex < 0 && i === 0) ? 0 : -1}
                  onClick={() => onSelect(s.id)}
                  onDoubleClick={() => {
                    if (isPending || !s.serverId) return;
                    setEditingId(s.id);
                    setEditValue(s.msg.label ?? s.label);
                  }}
                  className={`w-full flex items-start gap-2 text-left rounded-md px-2 py-1.5 pr-7 transition-colors ${
                    isSelected ? 'bg-ocean-softer' : 'hover:bg-softer'
                  }`}
                  style={{ paddingLeft: 8 + indent * 14 }}
                >
                  {indent > 0 && (
                    <span
                      aria-hidden="true"
                      className="self-stretch border-l border-dashed border-line-strong -my-1.5 mr-0.5"
                    />
                  )}
                  <span className="mt-[5px]">
                    <Dot state={isPending ? 'pending' : s.warn ? 'warn' : isSelected ? 'selected' : 'idle'} />
                  </span>
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') commitRename(s);
                        else if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => commitRename(s)}
                      className="flex-1 min-w-0 text-[12.5px] leading-snug bg-raised border border-ocean/50 rounded px-1 py-0 outline-none text-ink"
                    />
                  ) : (
                    <span
                      className={`text-[12.5px] leading-snug min-w-0 break-words ${
                        isSelected ? 'text-ink font-medium' : afterSelection ? 'text-muted-2' : 'text-ink-3'
                      }`}
                      title="Double-click to rename"
                    >
                      {s.label}
                    </span>
                  )}
                </button>
                {/* Star — always visible when starred, on hover otherwise.
                    Starred steps are exempt from collapsing. */}
                {!isPending && s.serverId != null && !isEditing && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onToggleStar(s); }}
                    title={s.msg.starred ? 'Unstar' : 'Star — keeps this step visible when the thread collapses'}
                    aria-label={s.msg.starred ? 'Unstar step' : 'Star step'}
                    className={`absolute right-1 top-1.5 p-0.5 rounded transition-opacity ${
                      s.msg.starred ? 'opacity-100 text-warn' : 'opacity-0 group-hover/step:opacity-100 text-muted-2 hover:text-warn'
                    }`}
                  >
                    <Star className="w-3 h-3" strokeWidth={2} fill={s.msg.starred ? 'currentColor' : 'none'} />
                  </button>
                )}
              </div>
              {/* The branch affordance sits under the SELECTED step — it only
                  focuses the ask input; the input's placeholder explains what
                  asking from here does. */}
              {isSelected && !isPending && (
                <button
                  type="button"
                  onClick={onBranchHere}
                  className="mt-0.5 font-mono text-[10px] lowercase tracking-[0.08em] text-ocean/70 hover:text-ocean transition-colors"
                  style={{ marginLeft: 28 + indent * 14 }}
                >
                  + branch here
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="px-3 py-2 border-t border-line font-mono text-[10px] lowercase tracking-[0.1em] text-muted-2">
        {steps.length} step{steps.length === 1 ? '' : 's'}
        {branchCount > 0 && <> · {branchCount} branch{branchCount === 1 ? '' : 'es'}</>}
      </p>
    </nav>
  );
}
