'use client';

// ─── /dev/widgets — widget render gallery ────────────────────────────────────
// Renders EVERY widget type in the dashboard DSL against fixture rows, with
// no auth and no backend. This page exists for one reason: the Vega-Lite
// migration shipped silent blank charts because nothing verified rendering
// in a REAL browser. e2e/widgets.spec.ts loads this page in Chromium and
// asserts each card actually drew marks. Every new widget type MUST be added
// here (the spec fails if a REQUIRED_WIDGET_COLUMNS type is missing).
//
// Internal playground route — like /dev/ui, not linked from navigation.

import { KpiCard } from '../../dashboards/components/KpiCard';
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
} from '../../dashboards/components/ChartWidgets';
import { ScatterChartWidget, BulletChartWidget } from '../../dashboards/components/EChartsWidgets';
import type { WidgetSpec, WidgetData } from '../../dashboards/types';

// ─── Fixtures — one realistic result set per widget contract ────────────────

const MONTHS = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'];
const CATS = ['Hardware', 'Software', 'Services'];

const FIXTURES: Record<string, Record<string, unknown>[]> = {
  kpi_card: [{ value: 1284650.75, delta: 12.4, delta_label: 'vs prior year' }],
  bar_chart: [
    { label: 'Acme Corp', value: 342000 },
    { label: 'Globex', value: 287500 },
    { label: 'Initech', value: 191200 },
    { label: 'Umbrella', value: 143800 },
    { label: 'Stark Industries', value: 98100 },
  ],
  vertical_bar_chart: MONTHS.map((m, i) => ({ label: m, value: 80000 + i * 12500 })),
  stacked_bar_chart: MONTHS.flatMap((m, i) =>
    CATS.map((c, j) => ({ label: m, series: c, value: 20000 + i * 3000 + j * 8000 })),
  ),
  line_chart: MONTHS.map((m, i) => ({ label: m, value: 410 + i * 22 })),
  pie_chart: [
    { label: 'Fulfilled', value: 612 },
    { label: 'Active', value: 233 },
    { label: 'Cancelled', value: 41 },
  ],
  top_list: [
    { label: 'Espresso Machine X1', value: 1240 },
    { label: 'Grinder Pro', value: 1015 },
    { label: 'Milk Frother', value: 830 },
    { label: 'Barista Kit', value: 655 },
    { label: 'Filter Pack', value: 512 },
  ],
  data_table: [
    { order_id: 1001, customer: 'Acme Corp', amount: 12400.5, order_date: '2025-12-04' },
    { order_id: 1002, customer: 'Globex', amount: 8100.0, order_date: '2025-12-03' },
    { order_id: 1003, customer: 'Initech', amount: 5320.25, order_date: '2025-12-02' },
  ],
  combo_chart: MONTHS.map((m, i) => ({ label: m, value: 80000 + i * 9000, line: 34 + i * 1.5 })),
  radar_chart: [
    { label: 'Completeness', value: 87 },
    { label: 'Accuracy', value: 92 },
    { label: 'Timeliness', value: 74 },
    { label: 'Consistency', value: 81 },
    { label: 'Validity', value: 95 },
  ],
  treemap_chart: [
    { label: 'Raw materials', value: 412000 },
    { label: 'Logistics', value: 268000 },
    { label: 'Packaging', value: 187000 },
    { label: 'Utilities', value: 96000 },
    { label: 'Maintenance', value: 71000 },
    { label: 'Other', value: 42000 },
  ],
  pivot_table: MONTHS.slice(0, 4).flatMap((m, i) =>
    CATS.map((c, j) => ({ row_label: m, col_label: c, value: 15000 + i * 2000 + j * 5000 })),
  ),
  scatter_chart: [
    { label: 'Espresso Machine X1', x: 1240, y: 372000, size: 48 },
    { label: 'Grinder Pro', x: 1015, y: 203000, size: 35 },
    { label: 'Milk Frother', x: 830, y: 66400, size: 22 },
    { label: 'Barista Kit', x: 655, y: 131000, size: 28 },
    { label: 'Filter Pack', x: 512, y: 15360, size: 12 },
    { label: 'Descaler', x: 448, y: 8960, size: 9 },
  ],
  bullet_chart: [
    { label: 'Benelux', value: 342000, target: 320000 },
    { label: 'DACH', value: 287500, target: 350000 },
    { label: 'Nordics', value: 191200, target: 210000 },
    { label: 'France', value: 98100, target: 180000 },
  ],
};

function spec(type: WidgetSpec['type']): WidgetSpec {
  return {
    id: `gallery_${type}`,
    type,
    title: `${type} fixture`,
    sql: 'SELECT 1', // never executed on this page
    format: type === 'line_chart' || type === 'radar_chart' ? 'number' : 'currency',
  };
}

function dataFor(type: string): WidgetData {
  return { rows: FIXTURES[type] ?? [], loading: false };
}

const noop = () => undefined;

export default function WidgetGalleryPage() {
  const renderers: Array<[WidgetSpec['type'], JSX.Element]> = [
    ['kpi_card', <KpiCard key="k" spec={spec('kpi_card')} data={dataFor('kpi_card')} />],
    ['bar_chart', <BarChartWidget key="b" spec={spec('bar_chart')} data={dataFor('bar_chart')} />],
    ['vertical_bar_chart', <VerticalBarChartWidget key="v" spec={spec('vertical_bar_chart')} data={dataFor('vertical_bar_chart')} />],
    ['stacked_bar_chart', <StackedBarChartWidget key="s" spec={spec('stacked_bar_chart')} data={dataFor('stacked_bar_chart')} />],
    ['line_chart', <LineChartWidget key="l" spec={spec('line_chart')} data={dataFor('line_chart')} />],
    ['pie_chart', <PieChartWidget key="p" spec={spec('pie_chart')} data={dataFor('pie_chart')} />],
    ['top_list', <TopListWidget key="t" spec={spec('top_list')} data={dataFor('top_list')} />],
    ['data_table', <DataTableWidget key="d" spec={spec('data_table')} data={dataFor('data_table')} />],
    ['combo_chart', <ComboChartWidget key="c" spec={spec('combo_chart')} data={dataFor('combo_chart')} />],
    ['radar_chart', <RadarChartWidget key="r" spec={spec('radar_chart')} data={dataFor('radar_chart')} />],
    ['treemap_chart', <TreemapWidget key="tm" spec={spec('treemap_chart')} data={dataFor('treemap_chart')} />],
    ['pivot_table', <PivotTableWidget key="pv" spec={spec('pivot_table')} data={dataFor('pivot_table')} />],
    ['scatter_chart', <ScatterChartWidget key="sc" spec={spec('scatter_chart')} data={dataFor('scatter_chart')} onCrossFilter={noop} />],
    ['bullet_chart', <BulletChartWidget key="bl" spec={spec('bullet_chart')} data={dataFor('bullet_chart')} onCrossFilter={noop} />],
  ];

  return (
    <div className="min-h-screen bg-canvas p-8">
      <h1 className="text-lg font-medium text-ink mb-1">Widget render gallery</h1>
      <p className="text-[12px] text-muted mb-6">
        Every widget type in the dashboard DSL, rendered against fixture rows.
        Verified in a real browser by e2e/widgets.spec.ts.
      </p>
      <div className="grid grid-cols-2 gap-6" data-testid="widget-gallery" data-widget-count={renderers.length}>
        {renderers.map(([type, node]) => (
          <div
            key={type}
            data-testid={`gallery-${type}`}
            className="rounded-lg border border-line bg-raised p-5"
          >
            <div className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted mb-3">{type}</div>
            {node}
          </div>
        ))}
      </div>
    </div>
  );
}
