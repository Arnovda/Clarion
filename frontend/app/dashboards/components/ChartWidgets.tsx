'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { WidgetExecutionProps } from '../types';
import { formatValue, inferColumnFormat } from '../utils/format';
import { ChartSkeleton, WidgetSkeleton, WidgetError, EmptyWidget } from './WidgetSkeletons';

// Vega is ~250 kB — load it lazily, client-only (it needs the DOM), so the
// heavy viz engine is code-split out of the initial dashboards bundle and
// shows a skeleton while it streams in.
const VegaChart = dynamic(() => import('./VegaChart'), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

// ─── Vega-rendered chart widgets ─────────────────────────────────────────────
// Every chart type now flows through one themed Vega engine for a uniform,
// polished look. The widgets keep their original exported names + props so
// the page dispatcher is untouched. Bar/line/stacked/pie/combo/top-list
// render as Vega-Lite; treemap + radar use full Vega (Vega-Lite has no
// treemap transform or polar coordinates). Tables and KPI cards aren't
// charts — they stay as typographic React components below.

export function BarChartWidget(props: WidgetExecutionProps)         { return <VegaChart {...props} />; }
export function VerticalBarChartWidget(props: WidgetExecutionProps) { return <VegaChart {...props} />; }
export function LineChartWidget(props: WidgetExecutionProps)        { return <VegaChart {...props} />; }
export function StackedBarChartWidget(props: WidgetExecutionProps)  { return <VegaChart {...props} />; }
export function PieChartWidget(props: WidgetExecutionProps)         { return <VegaChart {...props} />; }
export function ComboChartWidget(props: WidgetExecutionProps)       { return <VegaChart {...props} />; }
export function TopListWidget(props: WidgetExecutionProps)          { return <VegaChart {...props} />; }
export function TreemapWidget(props: WidgetExecutionProps)          { return <VegaChart {...props} />; }
export function RadarChartWidget(props: WidgetExecutionProps)       { return <VegaChart {...props} />; }

// ─── Safe formula evaluator ──────────────────────────────────────────────────

function evalFormula(expr: string, row: Record<string, unknown>): number | null {
  try {
    // Replace column references with their numeric values
    const colNames = Object.keys(row);
    const values = colNames.map((k) => Number(row[k] ?? 0));
    // Only allow safe characters: alphanumeric, operators, parens, spaces, dots
    if (/[^a-zA-Z0-9_+\-*/().\s]/.test(expr)) return null;
    // eslint-disable-next-line no-new-func
    const fn = new Function(...colNames, `return (${expr})`);
    const result = fn(...values);
    return typeof result === 'number' && isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

// ─── DataTableWidget ─────────────────────────────────────────────────────────

export function DataTableWidget({
  spec: _spec, data, onCrossFilter, onContextMenu,
}: WidgetExecutionProps) {
  const [calcCols, setCalcCols] = useState<Array<{ name: string; expr: string }>>([]);
  const [showFormulaForm, setShowFormulaForm] = useState(false);
  const [formulaName, setFormulaName] = useState('');
  const [formulaExpr, setFormulaExpr] = useState('');
  const [formulaError, setFormulaError] = useState('');

  if (data.loading) return <WidgetSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const baseKeys = Object.keys(data.rows[0]);
  const allKeys = [...baseKeys, ...calcCols.map((c) => c.name)];
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const headerLabel = (k: string) => capitalize(k.replace(/_/g, ' '));
  const isNumeric = (v: unknown) =>
    typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)));
  const firstTextKey = baseKeys.find((k) => !isNumeric(data.rows[0][k]));

  function addFormula() {
    const name = formulaName.trim();
    const expr = formulaExpr.trim();
    if (!name || !expr) { setFormulaError('Name and expression are required.'); return; }
    if (allKeys.includes(name)) { setFormulaError('Column name already exists.'); return; }
    // Test evaluation on first row
    const test = evalFormula(expr, data.rows[0]);
    if (test === null) { setFormulaError('Invalid expression. Use column names and +  -  *  /  ( ).'); return; }
    setCalcCols((c) => [...c, { name, expr }]);
    setFormulaName('');
    setFormulaExpr('');
    setFormulaError('');
    setShowFormulaForm(false);
  }

  return (
    <div>
      {/* Formula bar */}
      <div className="mb-2 flex items-center justify-end gap-2">
        {calcCols.map((c) => (
          <span key={c.name} className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border border-line bg-softer text-muted">
            {c.name} = {c.expr}
            <button onClick={() => setCalcCols((cols) => cols.filter((x) => x.name !== c.name))} className="text-muted-2 hover:text-err ml-0.5">×</button>
          </span>
        ))}
        <button
          onClick={() => setShowFormulaForm((v) => !v)}
          className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted hover:text-ocean transition-colors"
          title="Add calculated column"
        >
          + formula
        </button>
      </div>

      {showFormulaForm && (
        <div className="mb-3 p-3 rounded-lg border border-line bg-surface space-y-2">
          <div className="flex gap-2">
            <input
              value={formulaName}
              onChange={(e) => setFormulaName(e.target.value)}
              placeholder="Column name"
              className="w-28 px-2 py-1 text-[11px] rounded border border-line bg-base text-ink placeholder-ink-4 focus:outline-none focus:border-ocean"
            />
            <span className="text-[11px] text-muted self-center">=</span>
            <input
              value={formulaExpr}
              onChange={(e) => setFormulaExpr(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addFormula(); }}
              placeholder={`e.g. revenue / orders`}
              className="flex-1 px-2 py-1 text-[11px] font-mono rounded border border-line bg-base text-ink placeholder-ink-4 focus:outline-none focus:border-ocean"
            />
            <button onClick={addFormula} className="px-2.5 py-1 text-[11px] rounded bg-ocean text-white hover:bg-ocean-hover transition-colors">Add</button>
            <button onClick={() => { setShowFormulaForm(false); setFormulaError(''); }} className="text-[11px] text-muted hover:text-ink-2 transition-colors">Cancel</button>
          </div>
          {formulaError && <p className="text-[10px] text-err">{formulaError}</p>}
          <p className="text-[10px] text-muted">Available columns: {baseKeys.join(', ')}</p>
        </div>
      )}

    <div className="overflow-y-auto rounded-md border border-line" style={{ maxHeight: 300 }}>
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr className="sticky top-0 bg-softer z-10">
            {allKeys.map((k) => {
              const isCalc = calcCols.some((c) => c.name === k);
              return (
                <th
                  key={k}
                  className={`px-3 py-2 font-mono font-medium text-muted text-[10px] uppercase tracking-[0.08em] border-b border-line whitespace-nowrap ${
                    isNumeric(data.rows[0]?.[k]) || isCalc ? 'text-right' : 'text-left'
                  } ${isCalc ? 'text-ocean' : ''}`}
                >
                  {headerLabel(k)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr
              key={i}
              onClick={
                onCrossFilter && firstTextKey
                  ? () => onCrossFilter(String(row[firstTextKey] ?? ''))
                  : undefined
              }
              onContextMenu={onContextMenu && firstTextKey ? (e) => {
                const label = String(row[firstTextKey] ?? '');
                if (!label) return;
                e.preventDefault();
                onContextMenu(e, label);
              } : undefined}
              className={`border-b border-line last:border-b-0 transition-colors ${
                onCrossFilter || onContextMenu ? 'cursor-pointer hover:bg-softer' : ''
              }`}
            >
              {allKeys.map((k) => {
                const calcDef = calcCols.find((c) => c.name === k);
                const rawVal = calcDef ? evalFormula(calcDef.expr, row) : row[k];
                // Column-aware formatting: detect %, €, ids, counts from header name
                const colFormat = calcDef ? 'number' : inferColumnFormat(k);
                const display =
                  rawVal == null
                    ? '—'
                    : isNumeric(rawVal) || calcDef
                      ? formatValue(rawVal, colFormat)
                      : String(rawVal);
                return (
                  <td
                    key={k}
                    className={`px-3 py-2 text-ink-2 whitespace-nowrap ${
                      (isNumeric(rawVal) || calcDef) && colFormat !== 'id' ? 'text-right font-mono tabular-nums' : ''
                    } ${calcDef ? 'text-ocean' : ''}`}
                  >
                    {display}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}

// ─── PivotTableWidget ────────────────────────────────────────────────────────
// SQL must return: row_label, col_label, value
// e.g. SELECT month AS row_label, category AS col_label, SUM(amount) AS value ...

export function PivotTableWidget({ spec, data }: WidgetExecutionProps) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  // Build cross-tab structure
  const rowLabels: string[] = [];
  const colLabels: string[] = [];
  const cellMap: Record<string, Record<string, number>> = {};

  for (const r of data.rows) {
    const row = String(r.row_label ?? '');
    const col = String(r.col_label ?? '');
    const val = Number(r.value ?? 0);
    if (!rowLabels.includes(row)) rowLabels.push(row);
    if (!colLabels.includes(col)) colLabels.push(col);
    if (!cellMap[row]) cellMap[row] = {};
    cellMap[row][col] = (cellMap[row][col] ?? 0) + val;
  }

  // Row totals for heat-map intensity
  const rowTotals = rowLabels.map((row) =>
    colLabels.reduce((s, col) => s + (cellMap[row]?.[col] ?? 0), 0),
  );
  const grandTotal = rowTotals.reduce((s, v) => s + v, 0);
  const maxCell = Math.max(
    ...rowLabels.flatMap((row) => colLabels.map((col) => cellMap[row]?.[col] ?? 0)),
    1,
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="text-left px-3 py-1.5 font-medium text-muted border-b border-line sticky left-0 bg-raised min-w-[120px]" />
            {colLabels.map((col) => (
              <th key={col} className="px-3 py-1.5 font-medium text-muted border-b border-line text-right whitespace-nowrap">
                {col}
              </th>
            ))}
            <th className="px-3 py-1.5 font-medium text-muted border-b border-line text-right whitespace-nowrap">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rowLabels.map((row, ri) => {
            const rowTotal = rowTotals[ri];
            return (
              <tr key={row} className="hover:bg-softer transition-colors">
                <td className="px-3 py-1.5 font-medium text-ink-2 border-b border-line sticky left-0 bg-raised truncate max-w-[160px]">
                  {row}
                </td>
                {colLabels.map((col) => {
                  const val = cellMap[row]?.[col] ?? 0;
                  const intensity = Math.round((val / maxCell) * 12);
                  return (
                    <td
                      key={col}
                      className="px-3 py-1.5 text-right border-b border-line font-mono tabular-nums transition-colors"
                      style={{ background: val > 0 ? `rgba(var(--color-ocean-rgb, 37 99 235) / ${intensity * 0.05})` : undefined }}
                    >
                      {val > 0 ? formatValue(val, spec.format) : <span className="text-muted-2">—</span>}
                    </td>
                  );
                })}
                <td className="px-3 py-1.5 text-right border-b border-line font-medium font-mono tabular-nums text-ink-2">
                  {formatValue(rowTotal, spec.format)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-softer">
            <td className="px-3 py-1.5 font-medium text-ink-2 sticky left-0 bg-softer">Total</td>
            {colLabels.map((col) => {
              const colTotal = rowLabels.reduce((s, row) => s + (cellMap[row]?.[col] ?? 0), 0);
              return (
                <td key={col} className="px-3 py-1.5 text-right font-medium font-mono tabular-nums text-ink-2">
                  {formatValue(colTotal, spec.format)}
                </td>
              );
            })}
            <td className="px-3 py-1.5 text-right font-bold font-mono tabular-nums text-ink">
              {formatValue(grandTotal, spec.format)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
