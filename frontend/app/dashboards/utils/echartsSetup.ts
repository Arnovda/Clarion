// ─── echartsSetup.ts ─────────────────────────────────────────────────────────
// Tree-shaken ECharts core for the dashboard widgets that need capabilities
// beyond Recharts (scatter/bubble, bullet). Only the charts/components used
// are registered — importing the full `echarts` package would add ~500 KB gz
// to the bundle; this subset stays ~100 KB and is only loaded through the
// code-split widget module anyway.
//
// RENDERER CHOICE — SVG, deliberately. The Vega-Lite migration failed with
// silent blank canvases that headless tests couldn't see. SVG marks are DOM
// nodes, so the Playwright widget smoke test (e2e/widgets.spec.ts) can assert
// "this chart actually drew N shapes" in a real browser. At dashboard scale
// (≤ a few hundred points per widget) SVG performance is a non-issue.

import * as echarts from 'echarts/core';
import { ScatterChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { PALETTE, SERIES_COLORS } from './chart-theme';

echarts.use([
  ScatterChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  SVGRenderer,
]);

// Observatory theme — registered once at module load. Mirrors the Recharts
// styling in chart-theme.ts so both engines render as one visual system.
echarts.registerTheme('observatory', {
  color: SERIES_COLORS,
  textStyle: {
    fontFamily:
      'var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif',
  },
  grid: { top: 12, right: 16, bottom: 24, left: 8, containLabel: true },
  categoryAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: PALETTE.axisLabel, fontSize: 10 },
    splitLine: { show: false },
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: PALETTE.axisLabel, fontSize: 10 },
    splitLine: { lineStyle: { color: PALETTE.grid } },
  },
  tooltip: {
    backgroundColor: '#ffffff',
    borderColor: 'rgba(13, 28, 47, 0.12)',
    borderWidth: 1,
    textStyle: { color: '#1f2a37', fontSize: 12 },
    extraCssText: 'box-shadow: 0 4px 16px rgba(13,28,47,0.10); border-radius: 6px;',
  },
});

export { echarts };
export type EChartsOption = Parameters<echarts.ECharts['setOption']>[0];
