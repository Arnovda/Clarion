'use client';

// ─── useWindowedRows — dependency-free table row windowing ───────────────────
// data_table / pivot_table / drill-detail render real <tr> elements; before
// this hook they mounted EVERY row into the DOM, so a 5k-row drill-through
// meant 5k <tr> nodes (row-count bounding relied entirely on the SQL LIMIT).
// This windows rendering to the visible slice + overscan using fixed-height
// spacer rows — no library, works inside <table> markup, and stays inert
// (windowing off) below the threshold so small tables keep exact semantics.
//
// Aggregations must keep using the FULL row set — only rendering is windowed.

import { useState, type UIEvent } from 'react';

interface WindowedRows<T> {
  /** The slice of rows to actually render. */
  visible: T[];
  /** Absolute index of visible[0] in the input — use for React keys. */
  startIndex: number;
  /** Heights (px) for spacer rows above/below the rendered slice. */
  padTop: number;
  padBottom: number;
  /** Attach to the scroll container. Undefined when windowing is inactive. */
  onScroll?: (e: UIEvent<HTMLElement>) => void;
  active: boolean;
}

export function useWindowedRows<T>(
  rows: T[],
  rowHeight = 34,
  threshold = 150,
  overscan = 12,
): WindowedRows<T> {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(320);

  if (rows.length <= threshold) {
    return { visible: rows, startIndex: 0, padTop: 0, padBottom: 0, active: false };
  }

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);

  return {
    visible: rows.slice(start, end),
    startIndex: start,
    padTop: start * rowHeight,
    padBottom: (rows.length - end) * rowHeight,
    onScroll: (e) => {
      setScrollTop(e.currentTarget.scrollTop);
      setViewport(e.currentTarget.clientHeight);
    },
    active: true,
  };
}
