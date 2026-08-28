'use client';

/**
 * StepSpine — the worksheet's left thread rail (spec §1, §4.1, §6).
 *
 * Renders the step tree flattened depth-first: a branch's subtree sits
 * indented under its parent (indent capped at MAX_INDENT, dashed rule).
 * Steps positioned AFTER the selected one render muted so the reader can
 * see there is more ahead of them; selecting an ancestor never hides its
 * descendants.
 *
 * Accessibility: role="tree"/"treeitem" with aria-level/aria-selected,
 * roving tabindex, ↑/↓ move the selection, Home/End jump, Enter is the
 * button's native activation. Colour never carries meaning alone — the
 * selected step has a filled dot AND a background; warning dots carry a
 * title.
 */

import { useRef } from 'react';
import type { Step } from './steps';
import { MAX_INDENT } from './steps';

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
  steps, selectedId, onSelect, onBranchHere, branchCount,
}: {
  /** Flattened display order (deriveSteps → flattenSteps). */
  steps: Step[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Focus the ask input — the "+ branch here" affordance. */
  onBranchHere: () => void;
  branchCount: number;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const selectedIndex = steps.findIndex((s) => s.id === selectedId);

  function moveSelection(nextIndex: number) {
    const clamped = Math.max(0, Math.min(steps.length - 1, nextIndex));
    const target = steps[clamped];
    if (!target) return;
    onSelect(target.id);
    // Selection follows focus (standard tree behaviour).
    const el = listRef.current?.querySelector<HTMLButtonElement>(`[data-step="${target.id}"]`);
    el?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const cur = selectedIndex >= 0 ? selectedIndex : 0;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(cur + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(cur - 1); }
    else if (e.key === 'Home') { e.preventDefault(); moveSelection(0); }
    else if (e.key === 'End') { e.preventDefault(); moveSelection(steps.length - 1); }
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
        {steps.map((s, i) => {
          const isSelected = s.id === selectedId;
          const isPending = s.id === PENDING_STEP_ID;
          const afterSelection = selectedIndex >= 0 && i > selectedIndex;
          const indent = Math.min(s.depth, MAX_INDENT);
          return (
            <li key={s.id} role="none">
              <button
                type="button"
                role="treeitem"
                aria-level={s.depth + 1}
                aria-selected={isSelected}
                data-step={s.id}
                tabIndex={isSelected || (selectedIndex < 0 && i === 0) ? 0 : -1}
                onClick={() => onSelect(s.id)}
                className={`w-full flex items-start gap-2 text-left rounded-md px-2 py-1.5 transition-colors ${
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
                <span
                  className={`text-[12.5px] leading-snug min-w-0 break-words ${
                    isSelected ? 'text-ink font-medium' : afterSelection ? 'text-muted-2' : 'text-ink-3'
                  }`}
                >
                  {s.label}
                </span>
              </button>
              {/* The branch affordance sits under the SELECTED step — it only
                  focuses the ask input; the input's placeholder explains what
                  asking from here does. */}
              {isSelected && !isPending && (
                <button
                  type="button"
                  onClick={onBranchHere}
                  className="ml-7 mt-0.5 font-mono text-[10px] lowercase tracking-[0.08em] text-ocean/70 hover:text-ocean transition-colors"
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
