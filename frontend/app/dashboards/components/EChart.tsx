'use client';

// Thin React wrapper around a tree-shaken ECharts instance — deliberately
// NOT echarts-for-react (its release cadence lags core ECharts; the wrapper
// below is ~40 lines and owns its lifecycle completely).
//
// Vega post-mortem rules applied here:
//   1. Render failures are VISIBLE — a setOption exception paints an error
//      state instead of leaving a silent blank card.
//   2. Marks are DOM-assertable — SVG renderer (see echartsSetup.ts), so the
//      Playwright smoke test can count drawn shapes in a real browser.

import { useEffect, useRef, useState } from 'react';
import { echarts, type EChartsOption } from '../utils/echartsSetup';
import { WidgetError } from './WidgetSkeletons';

interface EChartProps {
  option: EChartsOption;
  height: number;
  /** Bubble a clicked category value up (cross-filter / context menu). */
  onPointClick?: (label: string) => void;
}

export function EChart({ option, height, onPointClick }: EChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  // Keep the latest callback without re-initialising the chart
  const clickRef = useRef(onPointClick);
  clickRef.current = onPointClick;

  useEffect(() => {
    if (!hostRef.current) return;
    const chart = echarts.init(hostRef.current, 'observatory', { renderer: 'svg' });
    chartRef.current = chart;
    chart.on('click', (params) => {
      const label = (params as { name?: string }).name;
      if (label && clickRef.current) clickRef.current(label);
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(hostRef.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      chart.setOption(option, { notMerge: true });
      setRenderError(null);
    } catch (err) {
      // NEVER a silent blank — the exact failure mode the Vega migration
      // shipped repeatedly because headless checks couldn't see it.
      setRenderError(err instanceof Error ? err.message : 'Chart failed to render');
    }
  }, [option]);

  if (renderError) return <WidgetError msg={`Chart render error: ${renderError}`} />;
  return <div ref={hostRef} data-chart-engine="echarts" style={{ width: '100%', height }} />;
}
