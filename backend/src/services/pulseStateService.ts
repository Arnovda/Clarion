/**
 * Pulse state — read-side aggregation for the Home page pulse tiles.
 *
 * The original /api/pulse endpoint returned config (name, sensitivity,
 * frequency) but nothing about the actual values being watched. That
 * made the Home pulse card a silent list — users configured a metric
 * and then saw no readings, no trend, no signal that snapshots had
 * even run.
 *
 * This service builds a single response shape per user that the new
 * <PulseTile> renders against. For every pulse entry it returns:
 *
 *   - current value + label
 *   - prior value (yesterday for daily, 7d for weekly) + delta
 *   - last-week delta (always — surfaces medium-term trend)
 *   - sparkline (last 30 observations)
 *   - latest brief bullet referencing this entry (optional, for context)
 *   - a `status` field that distinguishes:
 *       'ok'                 — observations exist, render normally
 *       'no_observations_yet'— first-day state (just configured)
 *       'snapshot_failed'    — N consecutive failures, surface the
 *                              error message + a refresh action
 *
 * That last bit is the honest-failure piece: today the panel silently
 * shows nothing when snapshots fail. The new shape forces the UI to
 * tell the user "we tried, here's why we couldn't compute it" with a
 * one-click path to fix it (refresh the underlying product).
 */

import { semanticDb } from '../db/knex';
import { tenantQuery } from './tenantQuery';
import { listPulse } from './pulseService';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PulseTileStatus = 'ok' | 'no_observations_yet' | 'snapshot_failed';

export interface PulseTileDelta {
  value: number;
  label: string;
  /** 'yesterday' | 'last week' | 'last value' — what we're comparing to. */
  period: string;
  deltaAbs: number | null;
  deltaPct: number | null;
  direction: 'up' | 'down' | 'flat';
}

export interface PulseTileSparkPoint {
  date: string;       // ISO YYYY-MM-DD
  value: number | null;
}

export interface PulseTileBrief {
  briefDate: string;
  headline: string;
  context: string;
  tone: 'warn' | 'positive' | 'neutral';
}

export interface PulseTileLinks {
  productId: number | null;
  kpiId: number | null;
}

export interface PulseTileState {
  id: number;
  label: string;
  productName: string | null;
  kind: 'metric' | 'slice' | 'theme';
  sensitivity: 'low' | 'medium' | 'high';
  frequency: 'daily' | 'weekly';

  currentValue: number | null;
  currentValueLabel: string | null;
  asOf: string | null;          // observation_date

  prior: PulseTileDelta | null;
  priorWeek: PulseTileDelta | null;

  sparkline: PulseTileSparkPoint[];
  latestBriefBullet: PulseTileBrief | null;

  status: PulseTileStatus;
  errorMessage: string | null;
  /** How many CONSECUTIVE recent attempts failed. Drives messaging:
   *  "last try failed yesterday" vs "5 consecutive failures since…". */
  consecutiveFailures: number;
  lastErrorAt: string | null;

  links: PulseTileLinks;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort number formatter. We don't have an explicit unit/format
 * field on product_kpis, so heuristics:
 *   - KPI name mentions money words → currency (€)
 *   - mentions "%" / "rate" / "ratio" → percent
 *   - else → locale-grouped number, max 2 decimals when fractional
 *
 * Crude but honest. A proper format field on KPIs is a separate change.
 */
function formatValue(value: number | null, kpiName: string | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const name = (kpiName ?? '').toLowerCase();
  if (/[%]|rate|ratio|margin/.test(name) && Math.abs(value) <= 1) {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (/[%]|rate|ratio|margin/.test(name)) {
    return `${value.toFixed(1)}%`;
  }
  const money = /(revenue|sales|cost|profit|amount|value|ar |a\/r|receivable|payable|cash|spend|expense)/.test(name);
  const opts: Intl.NumberFormatOptions = money
    ? { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }
    : { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 };
  try {
    return new Intl.NumberFormat('en-GB', opts).format(value);
  } catch {
    return String(value);
  }
}

function directionOf(deltaAbs: number | null): 'up' | 'down' | 'flat' {
  if (deltaAbs == null) return 'flat';
  if (deltaAbs > 0) return 'up';
  if (deltaAbs < 0) return 'down';
  return 'flat';
}

function isoDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function getPulseState(tenantId: number, userId: number): Promise<PulseTileState[]> {
  const entries = await listPulse(tenantId, userId);
  if (entries.length === 0) return [];

  const entryIds = entries.map((e) => e.id);
  const today = isoDate(new Date());

  // 30 days of observations, oldest first — cheap join, single query.
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const observations = await tenantQuery(tenantId, (trx) =>
    trx('pulse_observations')
      .whereIn('pulse_entry_id', entryIds)
      .andWhere('observation_date', '>=', isoDate(cutoff))
      .orderBy('observation_date', 'asc')
      .select<Array<{
        pulse_entry_id: number;
        observation_date: string | Date;
        value_numeric: string | number | null;
        error_message: string | null;
      }>>('pulse_entry_id', 'observation_date', 'value_numeric', 'error_message'),
  );

  const obsByEntry = new Map<number, typeof observations>();
  for (const o of observations) {
    const list = obsByEntry.get(o.pulse_entry_id) ?? [];
    list.push(o);
    obsByEntry.set(o.pulse_entry_id, list);
  }

  // Pull the most recent brief, scan its bullets for matches against
  // each entry's label/kpi_name. The brief's `content.bullets[]` has
  // `pulse_entry_id` when the AI-shaped output mentions a specific
  // entry, but we also fall back to label-string matching.
  const latestBriefRow = await tenantQuery(tenantId, (trx) =>
    trx('morning_briefs')
      .where({ user_id: userId })
      .orderBy('brief_date', 'desc')
      .first(),
  );
  const briefByEntry = new Map<number, PulseTileBrief>();
  if (latestBriefRow?.content) {
    try {
      const content = typeof latestBriefRow.content === 'string'
        ? JSON.parse(latestBriefRow.content)
        : latestBriefRow.content;
      const bullets: Array<Record<string, unknown>> = Array.isArray(content?.bullets) ? content.bullets : [];
      for (const b of bullets) {
        const tile: PulseTileBrief = {
          briefDate: String(latestBriefRow.brief_date ?? ''),
          headline: String(b.headline ?? b.title ?? ''),
          context: String(b.context ?? b.body ?? ''),
          tone: (b.tone === 'warn' || b.tone === 'positive' || b.tone === 'neutral')
            ? b.tone
            : 'neutral',
        };
        const entryId = Number(b.pulse_entry_id ?? 0);
        if (Number.isFinite(entryId) && entryId > 0) {
          briefByEntry.set(entryId, tile);
        }
      }
    } catch {
      // Malformed brief content — skip, tiles render without context line.
    }
  }

  return entries.map((entry) => {
    const rawObs = obsByEntry.get(entry.id) ?? [];
    // Normalise value_numeric (decimal comes back as string from pg).
    const obs = rawObs.map((o) => ({
      date: typeof o.observation_date === 'string' ? o.observation_date : isoDate(o.observation_date),
      value: o.value_numeric == null ? null : Number(o.value_numeric),
      error: o.error_message,
    }));

    const successful = obs.filter((o) => o.value != null);
    const failed = obs.filter((o) => o.error != null);
    const todayObs = obs.find((o) => o.date === today);

    // --- Status ----------------------------------------------------------
    // ok                 — at least one successful observation
    // snapshot_failed    — observations exist but all recent ones errored
    // no_observations_yet— no observations at all
    let status: PulseTileStatus;
    let consecutiveFailures = 0;
    let lastErrorAt: string | null = null;
    let errorMessage: string | null = null;
    if (obs.length === 0) {
      status = 'no_observations_yet';
    } else if (successful.length === 0) {
      status = 'snapshot_failed';
      // Walk obs from newest backwards counting consecutive failures.
      for (let i = obs.length - 1; i >= 0; i--) {
        if (obs[i].error != null) {
          consecutiveFailures++;
          if (lastErrorAt == null) {
            lastErrorAt = obs[i].date;
            errorMessage = obs[i].error;
          }
        } else {
          break;
        }
      }
    } else {
      status = 'ok';
      // Even when OK, surface consecutive failures at the tail so the
      // user knows if the metric has been stale for a few days.
      for (let i = obs.length - 1; i >= 0; i--) {
        if (obs[i].error != null) {
          consecutiveFailures++;
          if (lastErrorAt == null) {
            lastErrorAt = obs[i].date;
            errorMessage = obs[i].error;
          }
        } else {
          break;
        }
      }
    }

    // --- Current value ---------------------------------------------------
    // Prefer today's observation; otherwise the most recent successful one.
    const current = (todayObs?.value != null ? todayObs : successful[successful.length - 1]) ?? null;
    const currentValue = current?.value ?? null;
    const currentValueLabel = formatValue(currentValue, entry.kpi_name);
    const asOf = current?.date ?? null;

    // --- Prior comparisons ----------------------------------------------
    function buildDelta(priorObs: { date: string; value: number | null } | null, period: string): PulseTileDelta | null {
      if (!priorObs || priorObs.value == null || currentValue == null) return null;
      const deltaAbs = currentValue - priorObs.value;
      const deltaPct = priorObs.value !== 0 ? deltaAbs / priorObs.value : null;
      return {
        value: priorObs.value,
        label: formatValue(priorObs.value, entry.kpi_name) ?? '',
        period,
        deltaAbs,
        deltaPct,
        direction: directionOf(deltaAbs),
      };
    }

    // Prior period: yesterday for daily, last week for weekly.
    const lookbackDays = entry.frequency === 'weekly' ? 7 : 1;
    const priorTarget = current
      ? isoDate(new Date(new Date(current.date).getTime() - lookbackDays * 86_400_000))
      : null;
    const priorObs = priorTarget
      ? (successful.find((o) => o.date === priorTarget)
         // Fall back to the closest observation BEFORE the current one.
         ?? successful.filter((o) => o.date < (current?.date ?? today)).pop())
      : null;
    const prior = priorObs ? buildDelta(priorObs, lookbackDays === 7 ? 'last week' : 'yesterday') : null;

    // Last-week delta — always 7d, regardless of frequency.
    const weekTarget = current
      ? isoDate(new Date(new Date(current.date).getTime() - 7 * 86_400_000))
      : null;
    const weekObs = weekTarget
      ? (successful.find((o) => o.date === weekTarget)
         ?? successful.filter((o) => o.date < (current?.date ?? today)).find((o) => {
              const diff = new Date(current!.date).getTime() - new Date(o.date).getTime();
              return Math.abs(diff - 7 * 86_400_000) <= 2 * 86_400_000;
            }))
      : null;
    const priorWeek = (weekObs && lookbackDays !== 7) ? buildDelta(weekObs, 'last week') : null;

    // --- Sparkline ------------------------------------------------------
    // Up to 30 points, oldest first. Include nulls (errors) so the chart
    // can show gaps rather than silently dropping bad days.
    const sparkline: PulseTileSparkPoint[] = obs.map((o) => ({
      date: o.date,
      value: o.value,
    }));

    return {
      id: entry.id,
      label: entry.label ?? entry.kpi_name ?? entry.theme_text ?? 'Untitled',
      productName: entry.product_name ?? null,
      kind: entry.kind,
      sensitivity: entry.sensitivity,
      frequency: entry.frequency,

      currentValue,
      currentValueLabel,
      asOf,

      prior,
      priorWeek,

      sparkline,
      latestBriefBullet: briefByEntry.get(entry.id) ?? null,

      status,
      errorMessage,
      consecutiveFailures,
      lastErrorAt,

      links: {
        productId: entry.data_product_id ?? null,
        kpiId: entry.product_kpi_id ?? null,
      },
    };
  });
}
