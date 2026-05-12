'use client';

/**
 * <WidgetContextMenu> — right-click action menu for any clickable
 * dashboard data point (bar, slice, table cell, KPI value).
 *
 * Items:
 *   • Show source rows   — fetches the underlying rows that produced
 *                          the clicked aggregate (Power-BI's "see
 *                          records"). Disabled when the widget has no
 *                          cross-filter key (we can't infer which
 *                          dimension to filter by).
 *   • Filter dashboard   — applies the clicked value as a cross-filter
 *                          to every other widget. Equivalent to the
 *                          existing left-click cross-filter behaviour,
 *                          but available everywhere right-click works
 *                          (which today means tables + KPIs too, not
 *                          just charts).
 *   • Copy value         — copies the clicked label to clipboard.
 *
 * Positioning: rendered at the click coordinates relative to the
 * viewport. Auto-flips left + up when too close to the right/bottom
 * edges (otherwise the menu clips off-screen).
 *
 * Dismissal: closes on Escape, click outside, or scroll. The page-level
 * key/click listeners do this — this component is dumb chrome.
 */

import { useEffect, useRef } from 'react';
import { Table, Filter, Copy } from 'lucide-react';

export interface ContextMenuState {
  /** Viewport-relative click coordinates. */
  x: number;
  y: number;
  /** The widget this menu was triggered from. */
  widgetId: string;
  /** The label / dimension value the user clicked on. */
  value: string;
  /** Optional secondary value (e.g. for stacked charts: the series name). */
  series?: string;
}

interface Props {
  state: ContextMenuState | null;
  onClose: () => void;
  /** "Show source rows" — null/undefined = item disabled. */
  onShowSourceRows: ((state: ContextMenuState) => void) | null;
  /** "Filter dashboard" — null/undefined = item disabled. */
  onCrossFilter: ((state: ContextMenuState) => void) | null;
  /** "Copy value" — always available when there's a value. */
  onCopyValue: (state: ContextMenuState) => void;
}

const MENU_WIDTH = 200;
const MENU_HEIGHT = 130;

export function WidgetContextMenu({ state, onClose, onShowSourceRows, onCrossFilter, onCopyValue }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;
    // Close on Escape, outside click, or scroll. We don't capture
    // clicks on the menu itself — onMouseDown.stopPropagation does
    // that locally.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener('keydown', onKey);
    // Use mousedown so clicks dismiss BEFORE the underlying widget's
    // click handler fires (otherwise a click on a bar would dismiss
    // the menu AND register as a left-click cross-filter).
    window.addEventListener('mousedown', onClick);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [state, onClose]);

  if (!state) return null;

  // Auto-flip when too close to the viewport edges.
  const flipLeft = state.x + MENU_WIDTH > window.innerWidth - 8;
  const flipUp   = state.y + MENU_HEIGHT > window.innerHeight - 8;
  const left = flipLeft ? state.x - MENU_WIDTH : state.x;
  const top  = flipUp   ? state.y - MENU_HEIGHT : state.y;

  return (
    <div
      ref={menuRef}
      style={{ position: 'fixed', left, top, width: MENU_WIDTH, zIndex: 60 }}
      className="bg-raised border border-line rounded-lg shadow-3 py-1 overflow-hidden"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 border-b border-line">
        <p className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2 mb-0.5">Clicked</p>
        <p className="text-[12.5px] text-ink truncate" title={state.value}>
          {state.value}
          {state.series && <span className="text-muted-2"> · {state.series}</span>}
        </p>
      </div>

      <MenuItem
        icon={Table}
        label="Show source rows"
        hint="The raw rows that produced this value"
        disabled={!onShowSourceRows}
        onClick={() => { onShowSourceRows?.(state); onClose(); }}
      />
      <MenuItem
        icon={Filter}
        label="Filter dashboard"
        hint="Apply this value as a cross-filter"
        disabled={!onCrossFilter}
        onClick={() => { onCrossFilter?.(state); onClose(); }}
      />
      <MenuItem
        icon={Copy}
        label="Copy value"
        onClick={() => { onCopyValue(state); onClose(); }}
      />
    </div>
  );
}

function MenuItem({
  icon: Icon, label, hint, onClick, disabled,
}: {
  icon: typeof Table;
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left px-3 py-2 hover:bg-softer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      <div className="flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 text-muted-2 shrink-0" strokeWidth={1.75} />
        <span className="text-[13px] text-ink-2">{label}</span>
      </div>
      {hint && (
        <p className="text-[11px] text-muted-2 ml-[22px] mt-0.5 leading-snug">{hint}</p>
      )}
    </button>
  );
}
