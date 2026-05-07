'use client';

/**
 * <RefreshHistoryChart> — per-table change-evolution mini chart.
 *
 * Shipped with the Delta + Python sidecar work that gives us cheap row-hash
 * diffs on every refresh. Renders four series (unchanged / updated / inserted
 * / deleted) over the last N refreshes so curators can see at a glance how
 * a dimension or fact is evolving — spotting "every refresh deletes 1000s of
 * rows" before a user notices a missing dashboard line.
 *
 * Two display modes:
 *  - `compact` (~32px tall) for inline display in a table row
 *  - `full` (fixed height) for the expanded view, with axes + legend
 *
 * Reads from GET /api/products/tables/:id/refresh-history (oldest → newest).
 */

import { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts';
import api from '@/lib/api';

interface RefreshRow {
  id: number;
  refresh_started_at: string;
  refresh_completed_at: string | null;
  status: 'success' | 'failed' | string;
  rows_unchanged: number;
  rows_updated: number;
  rows_inserted: number;
  rows_deleted: number;
  rows_total: number;
  error_message: string | null;
  storage_format: string;
}

// Observatory token-aligned palette (kept inline so this file is dependency-free).
const COLOR_UNCHANGED = 'rgba(127, 138, 152, 0.5)'; // muted-2
const COLOR_UPDATED = '#0E6BA8';                    // ocean
const COLOR_INSERTED = '#16a34a';                   // ok-green
const COLOR_DELETED = '#dc2626';                    // err / rose

function formatTick(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function formatTooltipDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

interface Props {
  productTableId: number;
  /** `compact` for inline strip, `full` for expanded view. */
  variant?: 'compact' | 'full';
  /** Cap on rows fetched. */
  limit?: number;
}

export default function RefreshHistoryChart({
  productTableId,
  variant = 'full',
  limit = 30,
}: Props) {
  const [rows, setRows] = useState<RefreshRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    api
      .get<{ ok: boolean; data: RefreshRow[] }>(`/products/tables/${productTableId}/refresh-history`, { params: { limit } })
      .then((r) => {
        if (cancelled) return;
        setRows(r.data?.data ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.response?.data?.error ?? e?.message ?? 'Failed to load refresh history');
      });
    return () => { cancelled = true; };
  }, [productTableId, limit]);

  if (error) {
    return variant === 'compact'
      ? null
      : <p className="text-[12px] text-muted italic">Couldn&rsquo;t load refresh history: {error}</p>;
  }

  if (rows === null) {
    return variant === 'compact'
      ? <div className="h-[32px] w-full bg-softer/40 rounded animate-pulse" />
      : <div className="h-[180px] w-full bg-softer/40 rounded animate-pulse" />;
  }

  if (rows.length === 0) {
    return variant === 'compact'
      ? null
      : <p className="text-[12px] text-muted italic">No refresh history yet. Run a refresh to start tracking change.</p>;
  }

  // Surface the most-recent run summary alongside the chart in full mode.
  const latest = rows[rows.length - 1];

  if (variant === 'compact') {
    // Sparkline-only: no axes, no tooltip noise — just the four trends.
    return (
      <div className="h-[32px] w-full" aria-label="Refresh history sparkline">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
            <Line dataKey="rows_unchanged" stroke={COLOR_UNCHANGED} strokeWidth={1} dot={false} isAnimationActive={false} />
            <Line dataKey="rows_updated" stroke={COLOR_UPDATED} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line dataKey="rows_inserted" stroke={COLOR_INSERTED} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line dataKey="rows_deleted" stroke={COLOR_DELETED} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Most-recent summary strip — fast read for "what just happened?" */}
      <div className="flex items-center gap-3 text-[11.5px]">
        <span className="font-mono tracking-[0.14em] uppercase text-muted-2 text-[10px]">Last refresh</span>
        <span className="text-muted">{formatTooltipDate(latest.refresh_started_at)}</span>
        <span className="text-muted-2">·</span>
        <SummaryPill label="unchanged" value={latest.rows_unchanged} color={COLOR_UNCHANGED} />
        <SummaryPill label="updated" value={latest.rows_updated} color={COLOR_UPDATED} />
        <SummaryPill label="inserted" value={latest.rows_inserted} color={COLOR_INSERTED} />
        <SummaryPill label="deleted" value={latest.rows_deleted} color={COLOR_DELETED} />
        {latest.status === 'failed' && (
          <span className="text-err text-[11px]" title={latest.error_message ?? undefined}>· failed</span>
        )}
      </div>

      <div className="h-[200px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="rgba(127,138,152,0.15)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="refresh_started_at"
              tickFormatter={formatTick}
              tick={{ fontSize: 10, fill: 'currentColor', opacity: 0.6 }}
              axisLine={{ stroke: 'rgba(127,138,152,0.25)' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'currentColor', opacity: 0.6 }}
              axisLine={{ stroke: 'rgba(127,138,152,0.25)' }}
              tickLine={false}
              width={40}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--surface-raised, #fff)',
                border: '1px solid rgba(127,138,152,0.2)',
                fontSize: 11.5,
                borderRadius: 4,
              }}
              labelFormatter={(v: unknown) => formatTooltipDate(String(v))}
              formatter={(value: unknown, name: unknown) => {
                const labels: Record<string, string> = {
                  rows_unchanged: 'Unchanged',
                  rows_updated: 'Updated',
                  rows_inserted: 'Inserted',
                  rows_deleted: 'Deleted',
                };
                const n = typeof value === 'number' ? value : Number(value) || 0;
                const key = String(name);
                return [n.toLocaleString('en-GB'), labels[key] ?? key];
              }}
            />
            <Legend
              iconType="plainline"
              wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
              formatter={(value: string) => {
                const labels: Record<string, string> = {
                  rows_unchanged: 'Unchanged',
                  rows_updated: 'Updated',
                  rows_inserted: 'Inserted',
                  rows_deleted: 'Deleted',
                };
                return labels[value] ?? value;
              }}
            />
            <Line type="monotone" dataKey="rows_unchanged" stroke={COLOR_UNCHANGED} strokeWidth={1.25} dot={false} />
            <Line type="monotone" dataKey="rows_updated" stroke={COLOR_UPDATED} strokeWidth={1.75} dot={false} />
            <Line type="monotone" dataKey="rows_inserted" stroke={COLOR_INSERTED} strokeWidth={1.75} dot={false} />
            <Line type="monotone" dataKey="rows_deleted" stroke={COLOR_DELETED} strokeWidth={1.75} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function SummaryPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} aria-hidden />
      <span className="tabular-nums text-ink-2">{value.toLocaleString('en-GB')}</span>
      <span className="text-muted-2">{label}</span>
    </span>
  );
}
