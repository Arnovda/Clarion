/**
 * Build a compact, AI-friendly text block describing the dashboard
 * the user is currently looking at. Sent with Ask AI requests from
 * the dashboards page so the model can ground its answer in what's
 * actually on screen ("why is revenue for 2024-01 so high?") instead
 * of replying that it has no context.
 *
 * Design constraint: keep this SMALL. Every token sent multiplies
 * by every Ask AI call on a dashboard. Goal is 100-300 tokens for
 * a typical 6-12 widget dashboard. We achieve that by:
 *
 *   - Filters: single line with active values only
 *   - KPI widgets: title + value + delta on one line
 *   - Chart widgets: title + type + top 3-5 data points
 *   - Table widgets: title + column names + 2 sample rows
 *   - Widgets with errors or no data: skipped entirely
 *   - No SQL, no widget IDs, no styling info
 *
 * The output is plain text, not JSON. Plain text is ~50% fewer
 * tokens for the same information density.
 */

import type { DashboardSpec, WidgetData } from '../types';

const MAX_CHART_POINTS = 5;
const MAX_TABLE_ROWS = 2;
const MAX_TABLE_COLS = 8;
const MAX_LABEL_LEN = 60;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function formatNumber(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'object') return truncate(JSON.stringify(v), 40);
  return truncate(String(v), 40);
}

function summariseFilters(
  filters: DashboardSpec['filters'],
  values: Record<string, string>,
): string {
  if (!filters.length) return '';
  const lines: string[] = [];
  for (const f of filters) {
    if (f.type === 'date_range') {
      const from = values[`${f.id}_from`];
      const to = values[`${f.id}_to`];
      if (from || to) {
        lines.push(`  ${f.label}: ${from ?? '…'} to ${to ?? '…'}`);
      }
    } else {
      const v = values[f.id];
      if (v && v !== 'all') {
        lines.push(`  ${f.label}: ${v}`);
      }
    }
  }
  if (!lines.length) return 'Active filters: (none, all data in scope)';
  return `Active filters:\n${lines.join('\n')}`;
}

function summariseWidget(
  widget: DashboardSpec['widgets'][number],
  data: WidgetData | undefined,
): string | null {
  if (!data || data.loading || data.error || !data.rows || data.rows.length === 0) {
    return null;
  }

  const title = truncate(widget.title, MAX_LABEL_LEN);
  const rows = data.rows;
  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];

  switch (widget.type) {
    case 'kpi_card': {
      // KPI cards: one row with value/delta/label.
      const r = rows[0];
      const parts: string[] = [];
      if ('value' in r) parts.push(formatCell(r.value));
      else if (cols.length > 0) parts.push(formatCell(r[cols[0]]));
      if ('delta' in r && r.delta != null) {
        const delta = typeof r.delta === 'number'
          ? `${r.delta > 0 ? '+' : ''}${r.delta.toFixed(1)}%`
          : formatCell(r.delta);
        const label = ('delta_label' in r && r.delta_label) ? ` ${r.delta_label}` : '';
        parts.push(`(${delta}${label})`);
      }
      return `- ${title} [KPI]: ${parts.join(' ')}`;
    }

    case 'bar_chart':
    case 'vertical_bar_chart':
    case 'pie_chart':
    case 'top_list':
    case 'treemap_chart':
    case 'radar_chart': {
      // Categorical: list top N labels with values.
      const top = rows.slice(0, MAX_CHART_POINTS);
      const items = top.map((r) => {
        const label = formatCell(r.label ?? r[cols[0]] ?? '');
        const value = formatCell(r.value ?? r[cols[1]] ?? '');
        return `${label}=${value}`;
      });
      const more = rows.length > MAX_CHART_POINTS ? `, +${rows.length - MAX_CHART_POINTS} more` : '';
      return `- ${title} [${widget.type}]: ${items.join(', ')}${more}`;
    }

    case 'line_chart':
    case 'combo_chart': {
      // Time series: first, last, peak, trough.
      const first = rows[0];
      const last = rows[rows.length - 1];
      const values = rows
        .map((r) => (typeof r.value === 'number' ? r.value : null))
        .filter((v): v is number => v !== null);
      const peak = values.length ? Math.max(...values) : null;
      const trough = values.length ? Math.min(...values) : null;
      const fmtPoint = (r: Record<string, unknown>) =>
        `${formatCell(r.label ?? r[cols[0]])}=${formatCell(r.value ?? r[cols[1]])}`;
      const parts = [`first ${fmtPoint(first)}`, `last ${fmtPoint(last)}`];
      if (peak !== null && trough !== null && peak !== trough) {
        parts.push(`range ${formatNumber(trough)}-${formatNumber(peak)}`);
      }
      return `- ${title} [time series, ${rows.length} points]: ${parts.join(', ')}`;
    }

    case 'stacked_bar_chart':
    case 'pivot_table': {
      // Multi-dimensional: just shape + first row sample.
      const sample = rows[0];
      const sampleCols = Object.keys(sample).slice(0, MAX_TABLE_COLS);
      const sampleStr = sampleCols.map((c) => `${c}=${formatCell(sample[c])}`).join(', ');
      return `- ${title} [${widget.type}, ${rows.length} rows × ${cols.length} cols]: e.g. ${sampleStr}`;
    }

    case 'data_table':
    default: {
      // Tabular: column names + first MAX_TABLE_ROWS sample rows.
      const sampleCols = cols.slice(0, MAX_TABLE_COLS);
      const colLine = `cols: ${sampleCols.join(', ')}${cols.length > MAX_TABLE_COLS ? ', …' : ''}`;
      const sampleRows = rows.slice(0, MAX_TABLE_ROWS).map((r, i) => {
        const vals = sampleCols.map((c) => formatCell(r[c])).join(' | ');
        return `    row ${i + 1}: ${vals}`;
      });
      return `- ${title} [table, ${rows.length} rows]: ${colLine}\n${sampleRows.join('\n')}`;
    }
  }
}

/**
 * Build the compact context block. Returns null when there's no
 * useful information to send (no spec, no loaded widgets) so the
 * caller can skip transmitting an empty block.
 */
export function buildDashboardContext(
  spec: DashboardSpec | null,
  filterValues: Record<string, string>,
  widgetData: Record<string, WidgetData>,
): string | null {
  if (!spec) return null;

  const widgetLines = spec.widgets
    .map((w) => summariseWidget(w, widgetData[w.id]))
    .filter((s): s is string => s !== null);

  if (widgetLines.length === 0) return null;

  const filterBlock = summariseFilters(spec.filters, filterValues);
  const titleLine = `Dashboard: "${truncate(spec.title ?? 'Untitled', MAX_LABEL_LEN)}"`;

  return [
    titleLine,
    filterBlock,
    'Widgets currently visible:',
    widgetLines.join('\n'),
  ].filter(Boolean).join('\n');
}
