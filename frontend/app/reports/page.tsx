'use client';

import { useState, useEffect, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import api from '@/lib/api';
import { getTokenPayload } from '@/lib/auth';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

interface KpiDef {
  id: number;
  name: string;
  description: string;
  formula_sql: string;
  ai_draft: boolean;
}

interface KpiResult {
  kpi_name: string;
  value: number | string;
  unit: string;
}

const CONNECTION_ID = 1;

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444'];

function formatValue(value: number | string): string {
  if (value === 'Error') return 'Error';
  if (typeof value === 'string') return value;

  if (Number.isInteger(value) || (value === Math.round(value))) {
    if (value > 100) {
      return '€' + value.toLocaleString('nl-BE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }
    return value.toString();
  }

  if (value > 100) {
    return '€' + value.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  return value.toFixed(2);
}

export default function ReportsPage() {
  const [kpis, setKpis]               = useState<KpiDef[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [title, setTitle]             = useState('Monthly Overview');
  const [period, setPeriod]           = useState('March 2026');
  const [results, setResults]         = useState<KpiResult[] | null>(null);
  const [narrative, setNarrative]     = useState('');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');

  const loadKpis = useCallback(async () => {
    try {
      const res = await api.get(`/semantic/kpis?connectionId=${CONNECTION_ID}`);
      const confirmed = (res.data.data as KpiDef[]).filter((k) => !k.ai_draft);
      setKpis(confirmed);
    } catch {
      // silently fail — user will see empty list
    }
  }, []);

  useEffect(() => { loadKpis(); }, [loadKpis]);

  function toggleKpi(id: number) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function generate() {
    if (!selectedIds.length) {
      setError('Select at least one KPI.');
      return;
    }
    setError('');
    setLoading(true);
    setResults(null);
    setNarrative('');
    try {
      const res = await api.post('/reports/generate', {
        connectionId: CONNECTION_ID,
        title,
        period,
        kpiIds: selectedIds,
      });
      setResults(res.data.data.kpiResults);
      setNarrative(res.data.data.narrative);
    } catch {
      setError('Failed to generate report. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const numericResults = results?.filter(
    (r) => typeof r.value === 'number'
  ) ?? [];

  const showChart = numericResults.length >= 2;

  const chartData = numericResults.map((r) => ({
    name: r.kpi_name.length > 20 ? r.kpi_name.slice(0, 20) + '…' : r.kpi_name,
    fullName: r.kpi_name,
    value: r.value as number,
  }));

  const maxChartValue = chartData.reduce((max, d) => Math.max(max, d.value), 0);
  const mixedScales = (() => {
    if (chartData.length < 2) return false;
    const vals = chartData.map((d) => d.value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return max > 0 && min > 0 && max / min > 100;
  })();

  const chartHeight = Math.min(numericResults.length * 60 + 48, 300);

  return (
    <AppShell title="Reports" subtitle="KPI reports with AI-generated executive summaries">

      <div className="max-w-6xl mx-auto pt-8 px-4 pb-12">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Report builder</h1>

        <div className="flex gap-6 items-start">
          {/* ── Left sidebar — config ── */}
          <div className="w-80 flex-shrink-0 space-y-4">
            {/* Report settings */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
              <p className="text-sm font-semibold text-slate-800">Report settings</p>

              <div>
                <label className="block text-xs text-slate-500 mb-1">Title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="block w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500 mb-1">Period</label>
                <input
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  className="block w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            {/* KPI selector */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <p className="text-sm font-semibold text-slate-800 mb-3">Select KPIs</p>

              {kpis.length === 0 ? (
                <p className="text-xs text-slate-400 leading-relaxed">
                  No confirmed KPIs yet.{' '}
                  <a href="/semantic" className="text-blue-600 hover:underline">
                    Go to Definitions
                  </a>{' '}
                  to add and confirm KPIs.
                </p>
              ) : (
                <div className="space-y-3">
                  {kpis.map((k) => (
                    <label
                      key={k.id}
                      className="flex items-start gap-2.5 cursor-pointer group"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(k.id)}
                        onChange={() => toggleKpi(k.id)}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                      />
                      <span>
                        <span className="block text-sm text-slate-800 group-hover:text-slate-900">
                          {k.name}
                        </span>
                        {k.description && (
                          <span className="block text-xs text-slate-400 leading-tight mt-0.5">
                            {k.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Error */}
            {error && (
              <p className="text-sm text-red-600 px-1">{error}</p>
            )}

            {/* Generate button */}
            <button
              onClick={generate}
              disabled={loading || selectedIds.length === 0}
              className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 shadow-sm"
            >
              {loading && (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {loading ? 'Generating…' : 'Generate report'}
            </button>
          </div>

          {/* ── Right panel — results ── */}
          <div className="flex-1 min-w-0">
            {/* Empty state */}
            {!results && !loading && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm h-72 flex flex-col items-center justify-center gap-2">
                <svg className="w-10 h-10 text-slate-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 17v-2m3 2v-4m3 4v-6M3 21h18M3 10.5l9-7.5 9 7.5" />
                </svg>
                <p className="text-sm text-slate-400">Select KPIs and click Generate</p>
              </div>
            )}

            {/* Loading state */}
            {loading && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm h-72 flex flex-col items-center justify-center gap-3">
                <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-slate-500">Running queries and writing summary…</p>
              </div>
            )}

            {/* Results */}
            {results && (
              <div className="space-y-5">
                {/* Report header */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-6 py-4">
                  <div className="flex items-baseline justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">{title}</h2>
                      <p className="text-sm text-slate-400 mt-0.5">{period}</p>
                    </div>
                    <span className="text-xs text-slate-300">Generated just now</span>
                  </div>
                </div>

                {/* KPI cards grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {results.map((r, i) => (
                    <div
                      key={i}
                      className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-4"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className="inline-block w-2 h-2 rounded-full bg-blue-500 flex-shrink-0"
                        />
                        <p className="text-xs text-slate-500 uppercase tracking-wide font-medium truncate">
                          {r.kpi_name}
                        </p>
                      </div>
                      <p
                        className={`text-2xl font-bold ${
                          r.value === 'Error' ? 'text-red-500' : 'text-slate-900'
                        }`}
                      >
                        {formatValue(r.value)}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Chart */}
                {showChart && (
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 pt-5 pb-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm font-semibold text-slate-700">KPI comparison</p>
                      {mixedScales && (
                        <p className="text-xs text-slate-400 italic">
                          Chart shows relative scale — values may differ greatly
                        </p>
                      )}
                    </div>
                    <ResponsiveContainer width="100%" height={chartHeight}>
                      <BarChart
                        data={chartData}
                        layout="vertical"
                        margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                        <YAxis
                          dataKey="name"
                          type="category"
                          width={130}
                          tick={{ fontSize: 11, fill: '#64748b' }}
                        />
                        <XAxis
                          type="number"
                          tick={{ fontSize: 11, fill: '#94a3b8' }}
                          tickFormatter={(v) =>
                            maxChartValue > 1000 ? `€${(v / 1000).toFixed(0)}k` : String(v)
                          }
                        />
                        <Tooltip
                          formatter={(value: number, _name: string, props: { payload?: { fullName?: string } }) => [
                            formatValue(value),
                            props.payload?.fullName ?? '',
                          ]}
                          contentStyle={{
                            borderRadius: '8px',
                            border: '1px solid #e2e8f0',
                            fontSize: '12px',
                          }}
                        />
                        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                          {chartData.map((_entry, index) => (
                            <Cell
                              key={`cell-${index}`}
                              fill={CHART_COLORS[index % CHART_COLORS.length]}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Executive summary */}
                {narrative && (
                  <div className="bg-blue-50 border border-blue-100 rounded-xl shadow-sm px-6 py-5">
                    <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-2">
                      Executive summary
                    </p>
                    <p className="text-sm text-slate-700 leading-relaxed">{narrative}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
