'use client';

import type { ReactNode, RefObject } from 'react';
import { GridLayout, useContainerWidth, type Layout, type LayoutItem } from 'react-grid-layout';

type StopHandler = (layout: Layout, oldItem: LayoutItem | null, newItem: LayoutItem | null) => void;

/**
 * The Arrange-mode grid, as its own component so it can MEASURE itself.
 *
 * react-grid-layout needs a pixel width, and `useContainerWidth` measures the
 * element its ref is attached to — but only in an effect that runs when the
 * hook mounts. Called from the dashboards page, the hook mounted with the
 * page, long before Arrange was clicked, so its ref was still empty, it never
 * measured, and the grid stayed at the library's 1280 px default on every
 * screen: running off the right edge of a laptop, narrower than the
 * dashboard on a wide monitor. Mounting the hook together with the grid is
 * what lets it see the element it measures.
 *
 * `measureBeforeMount` keeps the grid from rendering one frame at 1280 px
 * before the real width lands. The measured element carries no padding, so
 * the width read on mount (offsetWidth) and the one the resize observer
 * reports (the content box) agree.
 */
export function ArrangeGrid({
  layout,
  rowHeight,
  onLayoutChange,
  onDragStop,
  onResizeStop,
  children,
}: {
  layout: Layout;
  rowHeight: number;
  onLayoutChange: (layout: Layout) => void;
  onDragStop: StopHandler;
  onResizeStop: StopHandler;
  children: ReactNode;
}) {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  return (
    <div ref={containerRef as RefObject<HTMLDivElement>}>
      {mounted && (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={{ cols: 12, rowHeight, margin: [16, 16], containerPadding: [0, 0] }}
          dragConfig={{ cancel: 'button, input, select, textarea, a' }}
          onLayoutChange={onLayoutChange}
          onDragStop={onDragStop}
          onResizeStop={onResizeStop}
        >
          {children}
        </GridLayout>
      )}
    </div>
  );
}
