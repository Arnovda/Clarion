'use client';

/**
 * /admin/ai-usage — admin-only AI cost dashboard.
 *
 * Surface owns six pieces of information, each tied to one of the
 * backend endpoints under /api/admin/ai-usage:
 *
 *   1. Headline KPIs       today / month / vs. prior month / top user
 *   2. Daily trend         simple bar chart, last 30 days
 *   3. By category         "where the cost actually lives" — what we
 *                          discussed in the cost analysis (questions /
 *                          investigate / refine / etc.)
 *   4. By user             who's burning the most this month
 *   5. By call label       finest grain — pinpoint a single drift
 *   6. Recent calls        last 100 entries (debug a sudden spike)
 *
 * Admin-only via RequireRole.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  DollarSign, Activity, TrendingUp, TrendingDown, Users,
  Loader2,
} from 'lucide-react';
import api from '@/lib/api';
import AppShell from '@/components/layout/AppShell';
import RequireRole from '@/components/RequireRole';
import { formatRelative } from '@/lib/dates';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

interface Summary {
  today_cost_usd: number;
  today_calls: number;
  month_cost_usd: number;
  month_calls: number;
  prior_month_cost_usd: number;
  top_user: {
    user_id: number;
    display_name: string | null;
    email: string | null;
    cost_usd: number;
    calls: number;
  } | null;
}

interface DailyRow { day: string; cost_usd: number; calls: number; }
interface CategoryRow { category: string; cost_usd: number; calls: number; avg_cost_usd: number; }
interface UserRow {
  user_id: number | null; display_name: string | null; email: string | null;
  cost_usd: number; calls: number;
}
interface CallLabelRow {
  call_label: string; category: string; model: string;
  cost_usd: number; calls: number; avg_cost_usd: number;
  avg_input: number; avg_output: number;
  cache_hit_rate: number | null;
}
interface RecentRow {
  id: number;
  created_at: string;
  user_id: number | null;
  display_name: string | null;
  model: string;
  call_label: string;
  category: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  duration_ms: number;
  cache_used: boolean;
  failed: boolean;
  error_code: string | null;
}

// Visible name + colour per category. Order matters — drives the
// bar-chart legend ordering below.
const CATEGORY_LABELS: Record<string, { label: string; colour: string; description: string }> = {
  question:    { label: 'Ask AI questions',    colour: '#164e63', description: 'NL→SQL flow: extract entities, generate SQL, validate result, format answer' },
  investigate: { label: 'Investigations',      colour: '#c08a5e', description: 'Multi-step "why?" agent loops' },
  refine:      { label: 'Refine chat',          colour: '#3f7a5c', description: 'Conversational product editing — add columns, KPIs, modify SQL' },
  dashboard:   { label: 'Dashboards',           colour: '#a06a1c', description: 'AI-generated dashboard specs + refinement + validation' },
  brief:       { label: 'Morning briefs',       colour: '#7c5fa0', description: 'Daily narrative summary of pulse-watched metrics' },
  starters:    { label: 'Query starters',       colour: '#5a7d8e', description: 'Personalised "Try asking…" prompts (cached 24h per tenant)' },
  setup:       { label: 'Setup / schema',       colour: '#8b5a3c', description: 'Schema profiling, bus matrix design, relationship suggestions — one-time per tenant' },
  kpi:         { label: 'KPI drafting',         colour: '#6b8e6b', description: 'AI-assist for manual KPI formulas' },
  pulse:       { label: 'Pulse suggestions',    colour: '#9a6b8e', description: 'Watchlist seed suggestions when user opens Home for first time' },
  quality:     { label: 'Quality alerts',       colour: '#a06a1c', description: '2-sentence business context for fired quality alerts' },
  other:       { label: 'Other',                colour: '#8891a0', description: 'Forecasts, insights, narrate, etc.' },
};

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

export default function AdminAiUsagePage() {
  return (
    <AppShell>
      <RequireRole roles={['admin']}>
        <DashboardBody />
      </RequireRole>
    </AppShell>
  );
}

function DashboardBody() {
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [byCategory, setByCategory] = useState<CategoryRow[]>([]);
  const [byUser, setByUser] = useState<UserRow[]>([]);
  const [byLabel, setByLabel] = useState<CallLabelRow[]>([]);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, d, c, u, l, r] = await Promise.all([
        api.get('/admin/ai-usage/summary'),
        api.get(`/admin/ai-usage/daily?days=${days}`),
        api.get(`/admin/ai-usage/by-category?days=${days}`),
        api.get(`/admin/ai-usage/by-user?days=${days}`),
        api.get(`/admin/ai-usage/by-call-label?days=${days}`),
        api.get('/admin/ai-usage/recent?limit=100'),
      ]);
      setSummary(s.data.data);
      setDaily(d.data.data);
      setByCategory(c.data.data);
      setByUser(u.data.data);
      setByLabel(l.data.data);
      setRecent(r.data.data);
    } catch { /* TODO: surface error */ }
    finally { setLoading(false); }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      {/* Header */}
      <header className="mb-8 flex items-end justify-between gap-4">
        <div>
          <span className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ocean">
            Admin · AI usage
          </span>
          <h1 className="font-display text-[34px] font-medium tracking-[-0.02em] mt-1 mb-1">
            Cost & usage
          </h1>
          <p className="text-[13px] text-muted leading-relaxed max-w-[600px]">
            What every AI call across this workspace costs, who&rsquo;s using it,
            and which features drive the most spend.
          </p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="px-3 py-1.5 text-[12.5px] bg-bg border border-line rounded focus:outline-none focus:border-ocean"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
      </header>

      {loading && !summary ? (
        <div className="py-16 text-center text-muted text-[12.5px]">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
          Loading usage data…
        </div>
      ) : !summary ? (
        <div className="py-16 text-center text-muted text-[12.5px]">No data.</div>
      ) : (
        <>
          {/* KPIs */}
          <SummaryStrip summary={summary} />

          {/* Trend chart */}
          <section className="bg-raised border border-line rounded-md p-5 mb-8">
            <header className="mb-4 flex items-baseline justify-between">
              <h2 className="font-display text-[16px] font-medium text-ink">Daily spend</h2>
              <span className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2">
                last {days} days
              </span>
            </header>
            <DailyChart rows={daily} />
          </section>

          {/* Two-column grid: by category + by user */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            <section className="bg-raised border border-line rounded-md p-5">
              <header className="mb-4">
                <h2 className="font-display text-[16px] font-medium text-ink">By category</h2>
                <p className="text-[12px] text-muted mt-0.5">Where the cost actually lives.</p>
              </header>
              <CategoryBreakdown rows={byCategory} />
            </section>

            <section className="bg-raised border border-line rounded-md p-5">
              <header className="mb-4">
                <h2 className="font-display text-[16px] font-medium text-ink">By user</h2>
                <p className="text-[12px] text-muted mt-0.5">Top spenders this period.</p>
              </header>
              <UserBreakdown rows={byUser} />
            </section>
          </div>

          {/* Most expensive specific calls */}
          <section className="bg-raised border border-line rounded-md p-5 mb-8">
            <header className="mb-4">
              <h2 className="font-display text-[16px] font-medium text-ink">Most expensive call types</h2>
              <p className="text-[12px] text-muted mt-0.5">
                Finest grain — pinpoint the specific calls that need optimisation.
              </p>
            </header>
            <LabelBreakdown rows={byLabel} />
          </section>

          {/* Recent calls table */}
          <section className="bg-raised border border-line rounded-md p-5 mb-8">
            <header className="mb-4">
              <h2 className="font-display text-[16px] font-medium text-ink">Recent calls</h2>
              <p className="text-[12px] text-muted mt-0.5">Last 100 — useful for debugging a sudden spike.</p>
            </header>
            <RecentTable rows={recent} />
          </section>
        </>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Summary KPI strip
// ───────────────────────────────────────────────────────────────────────────

function SummaryStrip({ summary }: { summary: Summary }) {
  const monthDelta = summary.prior_month_cost_usd > 0
    ? (summary.month_cost_usd - summary.prior_month_cost_usd) / summary.prior_month_cost_usd
    : null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-8">
      <Kpi
        label="Today"
        value={formatUsd(summary.today_cost_usd)}
        sub={`${summary.today_calls} calls`}
        icon={<DollarSign className="w-3.5 h-3.5 text-ocean" strokeWidth={1.75} />}
      />
      <Kpi
        label="This month"
        value={formatUsd(summary.month_cost_usd)}
        sub={`${summary.month_calls} calls`}
        delta={monthDelta != null ? `${monthDelta >= 0 ? '+' : ''}${(monthDelta * 100).toFixed(0)}% vs. prior month` : undefined}
        deltaPositiveIsBad={true}
        deltaValue={monthDelta}
        icon={<DollarSign className="w-3.5 h-3.5 text-ocean" strokeWidth={1.75} />}
      />
      <Kpi
        label="Prior month"
        value={formatUsd(summary.prior_month_cost_usd)}
        sub="full month"
        icon={<Activity className="w-3.5 h-3.5 text-muted" strokeWidth={1.75} />}
      />
      <Kpi
        label="Top user this month"
        value={summary.top_user?.display_name ?? summary.top_user?.email ?? '—'}
        sub={summary.top_user ? `${formatUsd(summary.top_user.cost_usd)} · ${summary.top_user.calls} calls` : 'no usage yet'}
        valueIsText
        icon={<Users className="w-3.5 h-3.5 text-muted" strokeWidth={1.75} />}
      />
    </div>
  );
}

function Kpi({
  label, value, sub, delta, deltaPositiveIsBad, deltaValue, icon, valueIsText,
}: {
  label: string;
  value: string;
  sub: string;
  delta?: string;
  deltaPositiveIsBad?: boolean;
  deltaValue?: number | null;
  icon?: React.ReactNode;
  valueIsText?: boolean;
}) {
  const deltaColour = deltaValue == null ? 'text-muted-2'
    : (deltaValue >= 0) === !!deltaPositiveIsBad ? 'text-red-700' : 'text-emerald-700';
  const DeltaIcon = deltaValue == null ? null : deltaValue >= 0 ? TrendingUp : TrendingDown;

  return (
    <div className="bg-raised border border-line rounded-md px-4 py-3.5">
      <div className="flex items-center gap-2 mb-1.5">
        {icon}
        <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted-2">{label}</span>
      </div>
      <div className={valueIsText
        ? 'font-display text-[18px] font-medium text-ink truncate'
        : 'font-mono text-[24px] font-medium text-ink tabular-nums'}>
        {value}
      </div>
      <div className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-2">
        <span>{sub}</span>
        {delta && DeltaIcon && (
          <>
            <span className="text-muted-2/40">·</span>
            <span className={`inline-flex items-center gap-1 ${deltaColour}`}>
              <DeltaIcon className="w-3 h-3" strokeWidth={1.75} />
              {delta}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Daily trend — simple SVG bar chart
// ───────────────────────────────────────────────────────────────────────────

function DailyChart({ rows }: { rows: DailyRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[12.5px] text-muted py-6 text-center">No calls yet in this window.</div>;
  }
  const max = Math.max(...rows.map((r) => r.cost_usd), 0.01);
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  const calls = rows.reduce((s, r) => s + r.calls, 0);

  return (
    <div>
      <div className="flex items-end gap-1 h-40 mb-2">
        {rows.map((r) => {
          const h = Math.max(1, (r.cost_usd / max) * 100);
          return (
            <div
              key={r.day}
              className="flex-1 min-w-[4px] bg-ocean/80 hover:bg-ocean rounded-t-sm transition-colors"
              style={{ height: `${h}%` }}
              title={`${r.day} · ${formatUsd(r.cost_usd)} · ${r.calls} calls`}
            />
          );
        })}
      </div>
      <div className="flex items-baseline justify-between text-[11px] text-muted-2">
        <span>{rows[0]?.day}</span>
        <span>
          Total: <span className="font-mono text-ink">{formatUsd(total)}</span>
          <span className="mx-2 text-muted-2/40">·</span>
          {calls.toLocaleString()} calls
        </span>
        <span>{rows[rows.length - 1]?.day}</span>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Breakdown by category — stacked horizontal bars
// ───────────────────────────────────────────────────────────────────────────

function CategoryBreakdown({ rows }: { rows: CategoryRow[] }) {
  const total = useMemo(() => rows.reduce((s, r) => s + r.cost_usd, 0), [rows]);
  if (total === 0) {
    return <div className="text-[12.5px] text-muted py-6 text-center">No calls yet.</div>;
  }
  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const meta = CATEGORY_LABELS[r.category] ?? CATEGORY_LABELS.other;
        const pct = (r.cost_usd / total) * 100;
        return (
          <div key={r.category}>
            <div className="flex items-baseline justify-between text-[12px] mb-1">
              <div className="flex items-baseline gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: meta.colour }} />
                <span className="text-ink font-medium">{meta.label}</span>
                <span className="text-muted-2 text-[11px]">{r.calls.toLocaleString()} calls</span>
              </div>
              <span className="font-mono tabular-nums text-ink">{formatUsd(r.cost_usd)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-soft overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: meta.colour }} />
            </div>
            <div className="text-[10.5px] text-muted-2 mt-0.5 italic">{meta.description}</div>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Per-user table
// ───────────────────────────────────────────────────────────────────────────

function UserBreakdown({ rows }: { rows: UserRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[12.5px] text-muted py-6 text-center">No users tracked yet.</div>;
  }
  const max = rows[0]?.cost_usd ?? 0.01;
  return (
    <div className="space-y-2">
      {rows.slice(0, 10).map((r) => {
        const pct = (r.cost_usd / max) * 100;
        const name = r.display_name ?? r.email ?? (r.user_id == null ? 'System / cron' : `User #${r.user_id}`);
        return (
          <div key={`${r.user_id ?? 'sys'}`} className="flex items-baseline gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2 mb-0.5">
                <span className="text-[12.5px] text-ink truncate">{name}</span>
                <span className="text-[11px] text-muted-2 flex-shrink-0">{r.calls.toLocaleString()}</span>
              </div>
              <div className="h-1.5 rounded-full bg-soft overflow-hidden">
                <div className="h-full bg-ocean/80 rounded-full" style={{ width: `${pct}%` }} />
              </div>
            </div>
            <span className="font-mono text-[12px] tabular-nums text-ink w-16 text-right">{formatUsd(r.cost_usd)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Per-call-label table
// ───────────────────────────────────────────────────────────────────────────

function LabelBreakdown({ rows }: { rows: CallLabelRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[12.5px] text-muted py-6 text-center">No calls yet.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left border-b border-line text-muted-2">
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px]">Call</th>
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px]">Category</th>
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px]">Model</th>
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px] text-right">Cost</th>
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px] text-right">Calls</th>
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px] text-right">Avg / call</th>
            <th className="pb-2 font-mono uppercase tracking-[0.06em] text-[10px] text-right">Cache hit</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((r) => {
            const meta = CATEGORY_LABELS[r.category] ?? CATEGORY_LABELS.other;
            return (
              <tr key={r.call_label} className="border-b border-line/50 hover:bg-soft/40">
                <td className="py-2 pr-3 font-mono text-ink-2">{r.call_label}</td>
                <td className="py-2 pr-3">
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-2">
                    <span className="w-1.5 h-1.5 rounded-sm" style={{ background: meta.colour }} />
                    {meta.label}
                  </span>
                </td>
                <td className="py-2 pr-3 font-mono text-[11px] text-muted">{r.model.replace(/^claude-/, '')}</td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums text-ink">{formatUsd(r.cost_usd)}</td>
                <td className="py-2 pr-3 text-right text-muted-2">{r.calls.toLocaleString()}</td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums text-ink-2">{formatUsd(r.avg_cost_usd, 4)}</td>
                <td className="py-2 text-right text-muted-2">
                  {r.cache_hit_rate != null ? `${(r.cache_hit_rate * 100).toFixed(0)}%` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Recent calls table
// ───────────────────────────────────────────────────────────────────────────

function RecentTable({ rows }: { rows: RecentRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[12.5px] text-muted py-6 text-center">No calls logged yet.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="text-left border-b border-line text-muted-2">
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px]">When</th>
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px]">User</th>
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px]">Call</th>
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px] text-right">Cost</th>
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px] text-right">In</th>
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px] text-right">Out</th>
            <th className="pb-2 pr-3 font-mono uppercase tracking-[0.06em] text-[10px] text-right">Duration</th>
            <th className="pb-2 font-mono uppercase tracking-[0.06em] text-[10px]">Flags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line/50 hover:bg-soft/40">
              <td className="py-2 pr-3 text-muted-2">{formatRelative(new Date(r.created_at))}</td>
              <td className="py-2 pr-3 text-ink-2 truncate max-w-[140px]">
                {r.display_name ?? (r.user_id == null ? 'cron' : `#${r.user_id}`)}
              </td>
              <td className="py-2 pr-3 font-mono text-ink-2">{r.call_label}</td>
              <td className="py-2 pr-3 text-right font-mono tabular-nums text-ink">{formatUsd(r.cost_usd, 4)}</td>
              <td className="py-2 pr-3 text-right text-muted-2 tabular-nums">{r.input_tokens.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right text-muted-2 tabular-nums">{r.output_tokens.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right text-muted-2 tabular-nums">{r.duration_ms}ms</td>
              <td className="py-2 space-x-1">
                {r.cache_used && <span className="px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-[0.08em] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded">cache</span>}
                {r.failed && <span className="px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-[0.08em] bg-red-50 text-red-700 border border-red-200 rounded">failed</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────────────

function formatUsd(n: number, decimals = 2): string {
  if (n === 0) return '$0.00';
  if (n < 0.01 && decimals === 2) return '<$0.01';
  return `$${n.toFixed(decimals)}`;
}
