'use client';

/**
 * <VegaChart> — the single rendering surface for every charted widget in
 * Clarion. Builds a themed Vega-Lite spec from the widget + its rows and
 * renders it with react-vega (a thin wrapper over vega-embed). One engine,
 * one look, everywhere.
 *
 * Owns: responsive sizing (ResizeObserver → explicit width so charts reflow
 * on layout changes), click-to-cross-filter, right-click context menu, and
 * the loading / error / empty states shared with the legacy widgets.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { VegaEmbed } from 'react-vega';
import type { Result } from 'vega-embed';
import type { View } from 'vega';
import type { WidgetExecutionProps } from '../types';
import { buildVegaSpec } from '../utils/vegaSpecBuilder';
import { ChartSkeleton, WidgetError, EmptyWidget } from './WidgetSkeletons';

// One-time CSS override so vega-embed's built-in tooltip matches the app
// rather than the library default.
let tooltipStyled = false;
function ensureTooltipStyle() {
  if (tooltipStyled || typeof document === 'undefined') return;
  tooltipStyled = true;
  const style = document.createElement('style');
  style.textContent = `
    #vg-tooltip-element.vg-tooltip {
      font-family: 'Geist', ui-sans-serif, system-ui, sans-serif !important;
      font-size: 11.5px !important;
      background: rgba(255,255,255,0.98) !important;
      border: 1px solid rgba(13,28,47,0.10) !important;
      border-radius: 8px !important;
      box-shadow: 0 6px 24px -8px rgba(13,28,47,0.22) !important;
      color: #3a4654 !important;
      padding: 7px 10px !important;
    }
    #vg-tooltip-element.vg-tooltip td.key { color: #6b7680 !important; font-weight: 500 !important; padding-right: 10px !important; }
    #vg-tooltip-element.vg-tooltip td.value { color: #1f2933 !important; font-variant-numeric: tabular-nums !important; }
    #vg-tooltip-element.vg-tooltip h2 { font-size: 12px !important; color: #1f2933 !important; margin: 0 0 4px !important; }
  `;
  document.head.appendChild(style);
}

const EMBED_OPTIONS = {
  actions: false as const,
  renderer: 'canvas' as const,
  // Omit `mode` so vega-embed auto-detects vega-lite vs full vega from the
  // spec's $schema — lets us use full Vega for treemap / radar (which
  // Vega-Lite can't express) and keep Vega-Lite for everything else.
  tooltip: { theme: 'light' as const, offsetX: 8, offsetY: 8 },
};

export default function VegaChart({
  spec, data, onCrossFilter, isCrossFilterActive, drillLabel,
  crossFilterValue, onContextMenu,
}: WidgetExecutionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // A render failure must never be silent (the old "axes but no marks" bug).
  // vega-embed's onError surfaces it; we show a clear state instead of a
  // blank chart, and log it so it's diagnosable.
  const [renderError, setRenderError] = useState<string | null>(null);

  // Keep the latest callbacks in refs so the Vega view's event listeners
  // (attached once per embed) never call a stale closure.
  const cfRef = useRef(onCrossFilter);
  const cmRef = useRef(onContextMenu);
  cfRef.current = onCrossFilter;
  cmRef.current = onContextMenu;

  useEffect(() => {
    ensureTooltipStyle();
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vlSpec = useMemo(() => {
    setRenderError(null);
    if (!data.rows.length) return null;
    const built = buildVegaSpec(spec, data.rows, { highlightValue: crossFilterValue });
    if (!built) return null;
    // Override the container width with the measured pixel width so charts
    // reflow precisely on grid / panel resizes.
    if (width > 0) (built as { width?: number | string }).width = width - 2;
    return built;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, data.rows, crossFilterValue, width]);

  const onError = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[VegaChart] render failed:', msg, spec?.type);
    setRenderError(msg);
  }, [spec?.type]);

  const onEmbed = useCallback((result: Result) => {
    const view = result.view as View;
    // Cross-filter on left click of a mark with a `label` datum.
    view.addEventListener('click', (_event, item) => {
      const datum = (item as { datum?: Record<string, unknown> })?.datum;
      if (datum && 'label' in datum && cfRef.current) {
        cfRef.current(String(datum.label));
      }
    });
    // Right-click → context menu (investigate / drill) on the clicked value.
    view.addEventListener('contextmenu', (event, item) => {
      const datum = (item as { datum?: Record<string, unknown> })?.datum;
      if (datum && 'label' in datum && cmRef.current) {
        (event as MouseEvent).preventDefault();
        cmRef.current(event as unknown as React.MouseEvent, String(datum.label),
          'series' in datum ? String(datum.series) : undefined);
      }
    });
  }, []);

  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (renderError) return <WidgetError msg={`Couldn't render this chart: ${renderError}`} />;
  if (!data.rows.length || !vlSpec) return <EmptyWidget />;

  return (
    <div>
      {isCrossFilterActive && drillLabel && (
        <div className="mb-2.5 flex items-center gap-2">
          <button
            onClick={() => onCrossFilter?.(null)}
            className="text-[11px] font-mono tracking-[0.08em] uppercase text-ocean hover:text-ocean-hover transition-colors"
          >
            ← Clear
          </button>
          <p className="text-[11px] text-muted truncate">{drillLabel}</p>
        </div>
      )}
      <div
        ref={containerRef}
        className="w-full"
        style={{ cursor: onCrossFilter ? 'pointer' : 'default' }}
      >
        {width > 0 && (
          <VegaEmbed
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            spec={vlSpec as any}
            options={EMBED_OPTIONS}
            onEmbed={onEmbed}
            onError={onError}
          />
        )}
      </div>
      {onCrossFilter && !isCrossFilterActive && (
        <p className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted-2 mt-2 text-center">
          Click to cross-filter{onContextMenu ? ' · right-click for more' : ''}
        </p>
      )}
    </div>
  );
}
