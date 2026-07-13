'use client';

// ─── WidgetBody — the widget-type switch, code-split from the page ──────────
// This module owns ALL heavy chart imports (Recharts ~400 kB, ECharts core
// ~100 kB). page.tsx loads it via next/dynamic, so the dashboards route's
// first-load JS no longer carries the chart engines — they arrive in a
// separate chunk when the first widget actually renders. (The Vega branch
// measured 565 kB → 304 kB for exactly this split; reverting lost it.)

import type { MouseEvent } from 'react';
import { KpiCard } from './KpiCard';
import {
  BarChartWidget,
  VerticalBarChartWidget,
  LineChartWidget,
  StackedBarChartWidget,
  PieChartWidget,
  TopListWidget,
  DataTableWidget,
  ComboChartWidget,
  RadarChartWidget,
  TreemapWidget,
  PivotTableWidget,
} from './ChartWidgets';
import { ScatterChartWidget, BulletChartWidget } from './EChartsWidgets';
import type { WidgetSpec, WidgetData } from '../types';

export interface WidgetBodyProps {
  widget: WidgetSpec;
  data: WidgetData;
  hasCrossFilter: boolean;
  isCrossFilterSource: boolean;
  crossFilterLabel?: string;
  crossFilterValue?: string;
  onCrossFilter: (value: string | null) => void;
  onContextMenu: (e: MouseEvent, value: string, series?: string) => void;
  onDrillDetail?: () => void;
}

export default function WidgetBody({
  widget,
  data,
  hasCrossFilter,
  isCrossFilterSource,
  crossFilterLabel,
  crossFilterValue,
  onCrossFilter,
  onContextMenu,
  onDrillDetail,
}: WidgetBodyProps) {
  const widgetProps = { spec: widget, data };
  const onCF = hasCrossFilter ? onCrossFilter : undefined;
  const onCtx = hasCrossFilter ? onContextMenu : undefined;

  switch (widget.type) {
    case 'kpi_card':
      return <KpiCard {...widgetProps} onDrillDetail={onDrillDetail} onContextMenu={onContextMenu} />;
    case 'bar_chart':
      return (
        <BarChartWidget
          {...widgetProps}
          onCrossFilter={onCF}
          isCrossFilterActive={isCrossFilterSource}
          drillLabel={isCrossFilterSource ? crossFilterLabel : undefined}
          crossFilterValue={isCrossFilterSource ? crossFilterValue : undefined}
          onContextMenu={onCtx}
        />
      );
    case 'line_chart':
      return <LineChartWidget {...widgetProps} onCrossFilter={onCF} />;
    case 'vertical_bar_chart':
      return (
        <VerticalBarChartWidget
          {...widgetProps}
          onCrossFilter={onCF}
          crossFilterValue={isCrossFilterSource ? crossFilterValue : undefined}
          onContextMenu={onCtx}
        />
      );
    case 'stacked_bar_chart':
      return <StackedBarChartWidget {...widgetProps} onCrossFilter={onCF} />;
    case 'pie_chart':
      return <PieChartWidget {...widgetProps} onCrossFilter={onCF} />;
    case 'top_list':
      return <TopListWidget {...widgetProps} onCrossFilter={onCF} />;
    case 'data_table':
      return <DataTableWidget {...widgetProps} onCrossFilter={onCF} onContextMenu={onCtx} />;
    case 'combo_chart':
      return <ComboChartWidget {...widgetProps} />;
    case 'radar_chart':
      return <RadarChartWidget {...widgetProps} />;
    case 'treemap_chart':
      return <TreemapWidget {...widgetProps} />;
    case 'pivot_table':
      return <PivotTableWidget {...widgetProps} />;
    case 'scatter_chart':
      return <ScatterChartWidget {...widgetProps} onCrossFilter={onCF} />;
    case 'bullet_chart':
      return <BulletChartWidget {...widgetProps} onCrossFilter={onCF} />;
    default:
      return null;
  }
}
