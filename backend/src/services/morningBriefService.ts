/**
 * Morning brief service — daily pipeline:
 *
 *   1. Snapshot every pulse entry (run its KPI's formula_sql against the
 *      product warehouse, store the value with today's date).
 *   2. For each user with pulse entries, compute deltas (today vs prior
 *      observation) and ask Haiku to narrate a 3-bullet brief.
 *   3. Persist the brief; create an in-app notification.
 *
 * Idempotent: re-running on the same UTC day is a no-op via the
 * (pulse_entry_id, observation_date) and (user_id, brief_date) unique
 * constraints. Safe to manually retrigger from a route.
 *
 * Email delivery is a separate phase. Today the brief lives on Home
 * (MorningBriefCard reads /api/briefs/today) and in the notification bell.
 */

import { semanticDb } from '../db/knex';
import { tenantQuery, listActiveTenantIds } from './tenantQuery';
import { prepareUnattendedRead } from './readPolicy';
import { logger } from '../utils/logger';
import { notify } from './notificationService';
import { createProductConnector } from '../connectors/ConnectorFactory';
import { withTenantAiContext } from './aiBudget';
import {
  type MorningBriefContext,
  type MorningBriefOutput,
  type BriefEntryDelta,
} from '../ai/prompts/morningBriefPrompt';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MorningBrief {
  id: number;
  user_id: number;
  brief_date: string;
  content: MorningBriefOutput;
  opened_at: string | null;
  emailed_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export async function getTodaysBrief(
  tenantId: number,
  userId: number,
): Promise<MorningBrief | null> {
  const today = isoDate(new Date());
  const rows = await tenantQuery(tenantId, (trx) =>
    trx('morning_briefs')
      .where({ user_id: userId, brief_date: today })
      .first(),
  );
  return rows ? mapBrief(rows) : null;
}

export async function listBriefs(
  tenantId: number,
  userId: number,
  limit: number = 14,
): Promise<MorningBrief[]> {
  const rows = await tenantQuery(tenantId, (trx) =>
    trx('morning_briefs')
      .where({ user_id: userId })
      .orderBy('brief_date', 'desc')
      .limit(limit),
  );
  return rows.map(mapBrief);
}

export async function markBriefOpened(
  tenantId: number,
  userId: number,
  briefId: number,
): Promise<void> {
  await tenantQuery(tenantId, (trx) =>
    trx('morning_briefs')
      .where({ id: briefId, user_id: userId })
      .whereNull('opened_at')
      .update({ opened_at: new Date().toISOString() }),
  );
}

// ---------------------------------------------------------------------------
// The runner — called by the scheduled job + manual route
// ---------------------------------------------------------------------------

/**
 * Run the daily brief pipeline for every active tenant + user.
 * Returns counts so the caller can log/report.
 */
export async function runDailyBriefs(): Promise<{ tenantsRun: number; briefsCreated: number; observations: number }> {
  let tenantsRun = 0, briefsCreated = 0, observations = 0;

  // `tenants` has no `is_active` column — this read threw every morning at
  // 06:00 ("column is_active does not exist") and no brief was ever
  // generated on a schedule. Found 2026-09-05 while closing P0-2.
  const tenants = await listActiveTenantIds();

  for (const tenantId of tenants) {
    try {
      // Phase 1 — snapshot every pulse entry's value.
      const observed = await snapshotPulseValues(tenantId);
      observations += observed;

      // Phase 2 — for each user, generate brief.
      const userIds = await tenantQuery(tenantId, (trx) =>
        trx('user_pulse_entries').distinct('user_id').pluck<number[]>('user_id'),
      );
      for (const userId of userIds) {
        try {
          // Set the AI context per-user so the AI calls land in
          // ai_call_log attributed to this user, not "system / cron"
          // — we want to see "Sara consumed $X on briefs this month"
          // in the dashboard.
          const brief = await withTenantAiContext(
            { tenantId, userId },
            () => generateBriefForUser(tenantId, userId),
          );
          if (brief) briefsCreated++;
        } catch (err) {
          logger.error({ err, tenantId, userId }, 'morningBriefService: failed for user');
        }
      }
      tenantsRun++;
    } catch (err) {
      logger.error({ err, tenantId }, 'morningBriefService: tenant pipeline failed');
    }
  }

  return { tenantsRun, briefsCreated, observations };
}

// ---------------------------------------------------------------------------
// Phase 1 — snapshot pulse values for one tenant
// ---------------------------------------------------------------------------

async function snapshotPulseValues(tenantId: number): Promise<number> {
  const today = isoDate(new Date());

  // Skip if we've already snapshotted today (idempotence + restart safety).
  const existing = await tenantQuery(tenantId, (trx) =>
    trx('pulse_observations').where({ observation_date: today }).count<{ count: string }[]>('* as count'),
  );
  const alreadyDone = Number(existing[0]?.count ?? 0);

  // Pull every pulse entry that has an attached KPI — we can only
  // snapshot when there's a formula_sql to run. Theme entries get
  // snapshot semantics later (Phase: theme resolver).
  const pulseRows = await tenantQuery(tenantId, (trx) =>
    trx('user_pulse_entries as upe')
      .join('product_kpis as pk', 'upe.product_kpi_id', 'pk.id')
      .join('data_products as dp', 'upe.data_product_id', 'dp.id')
      .whereNotNull('upe.product_kpi_id')
      .whereNotNull('pk.formula_sql')
      .select(
        'upe.id as pulse_id',
        'upe.kind',
        'upe.dimension_table',
        'upe.dimension_column',
        'pk.formula_sql',
        'pk.name as kpi_name',
        'dp.id as data_product_id',
        'dp.connection_id',
      ),
  );

  if (pulseRows.length === 0) return 0;
  if (alreadyDone === pulseRows.length) return alreadyDone;

  // Group by connection so we open one DuckDB pool per connection per run.
  const byConnection = new Map<number, typeof pulseRows>();
  for (const row of pulseRows) {
    const cid = Number(row.connection_id);
    const list = byConnection.get(cid) ?? [];
    list.push(row);
    byConnection.set(cid, list);
  }

  let snapshotted = 0;
  for (const [connectionId, rows] of byConnection.entries()) {
    let connector;
    try {
      // The path doesn't really matter — createProductConnector hangs
      // tablePaths off the catalog. Pass a sentinel root that
      // DuckDBConnector accepts.
      connector = await createProductConnector('warehouse', connectionId, tenantId);
      await connector.connect();
    } catch (err) {
      logger.warn({ err, connectionId }, 'morningBriefService: could not open connector — skipping snapshots');
      continue;
    }

    for (const row of rows) {
      try {
        const sql = String(row.formula_sql);
        // The snapshot is shared by every user of the tenant, so it gets
        // the most restrictive view any policy describes (P0-4); the KPI
        // SQL was never guarded here either.
        const guarded = (await prepareUnattendedRead(sql, tenantId)).sql;
        const wrapped = wrapForSnapshot(guarded, row);
        const result = await connector.executeQuery(wrapped);
        const value = extractScalar(result);

        await tenantQuery(tenantId, (trx) =>
          trx('pulse_observations').insert({
            pulse_entry_id: Number(row.pulse_id),
            observation_date: today,
            value_numeric: value,
            error_message: value == null ? 'No numeric result returned' : null,
          }).onConflict(['pulse_entry_id', 'observation_date']).ignore(),
        );
        snapshotted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await tenantQuery(tenantId, (trx) =>
          trx('pulse_observations').insert({
            pulse_entry_id: Number(row.pulse_id),
            observation_date: today,
            value_numeric: null,
            error_message: msg.slice(0, 500),
          }).onConflict(['pulse_entry_id', 'observation_date']).ignore(),
        );
      }
    }

    try { await connector.disconnect(); } catch { /* ignore */ }
  }

  return snapshotted;
}

/**
 * Wrap a KPI's formula_sql into a runnable SELECT for snapshotting.
 * For metric-kind pulse entries we run the formula as-is. For slice
 * entries we don't snapshot per-dimension yet — we just snapshot the
 * total. Per-slice rollup is a Phase-2 enhancement.
 */
function wrapForSnapshot(formulaSql: string, _row: Record<string, unknown>): string {
  // formulaSql is already a SELECT in the canonical KPI shape. Nothing to do.
  return formulaSql.replace(/;\s*$/, '');
}

function extractScalar(result: { rows: unknown[] }): number | null {
  if (!result.rows || result.rows.length === 0) return null;
  const first = result.rows[0] as Record<string, unknown>;
  for (const v of Object.values(first)) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 2 — generate the brief for one user
// ---------------------------------------------------------------------------

export async function generateBriefForUser(
  tenantId: number,
  userId: number,
): Promise<MorningBrief | null> {
  const today = isoDate(new Date());

  // Skip if a brief for today already exists (idempotent).
  const existing = await tenantQuery(tenantId, (trx) =>
    trx('morning_briefs').where({ user_id: userId, brief_date: today }).first(),
  );
  if (existing) return mapBrief(existing);

  // Pull this user's pulse entries + their two most recent observations.
  const pulse = await tenantQuery(tenantId, (trx) =>
    trx('user_pulse_entries as upe')
      .leftJoin('product_kpis as pk', 'upe.product_kpi_id', 'pk.id')
      .where('upe.user_id', userId)
      .select(
        'upe.id', 'upe.kind', 'upe.sensitivity', 'upe.frequency',
        'upe.label', 'upe.theme_text',
        'pk.name as kpi_name',
      ),
  );
  if (pulse.length === 0) return null;

  const pulseIds = pulse.map((p) => Number(p.id));
  const obsRows = await tenantQuery(tenantId, (trx) =>
    trx('pulse_observations')
      .whereIn('pulse_entry_id', pulseIds)
      .orderBy(['pulse_entry_id', { column: 'observation_date', order: 'desc' }])
      .limit(pulseIds.length * 14),  // up to 2 weeks per entry
  );

  const obsByPulse = new Map<number, typeof obsRows>();
  for (const o of obsRows) {
    const list = obsByPulse.get(Number(o.pulse_entry_id)) ?? [];
    list.push(o);
    obsByPulse.set(Number(o.pulse_entry_id), list);
  }

  const deltas: BriefEntryDelta[] = pulse.map((p) => {
    const obs = obsByPulse.get(Number(p.id)) ?? [];
    const todayObs = obs.find((o) => isoDate(new Date(o.observation_date)) === today);
    const priorWindow = p.frequency === 'weekly' ? 7 : 1;
    const priorObs = obs.find((o) => {
      const d = new Date(o.observation_date);
      return Math.round((Date.now() - d.getTime()) / 86_400_000) >= priorWindow;
    });

    const cur = todayObs?.value_numeric != null ? Number(todayObs.value_numeric) : null;
    const prior = priorObs?.value_numeric != null ? Number(priorObs.value_numeric) : null;

    let deltaAbs: number | null = null;
    let deltaPct: number | null = null;
    if (cur != null && prior != null && prior !== 0) {
      deltaAbs = cur - prior;
      deltaPct = deltaAbs / prior;
    } else if (cur != null && prior === 0) {
      deltaAbs = cur;
      deltaPct = null;
    }

    const threshold = p.sensitivity === 'high' ? 0
                    : p.sensitivity === 'low'  ? 0.10
                    : 0.05;
    const triggered = deltaPct != null && Math.abs(deltaPct) >= threshold;

    const label = (p.label as string | null)
      ?? (p.kpi_name as string | null)
      ?? (p.theme_text as string | null)
      ?? 'Untitled';

    return {
      pulse_entry_id: Number(p.id),
      label,
      kind: p.kind as 'metric' | 'slice' | 'theme',
      sensitivity: p.sensitivity as 'low' | 'medium' | 'high',
      current_value: cur,
      prior_value: prior,
      prior_period_label: p.frequency === 'weekly' ? 'last week' : 'yesterday',
      delta_absolute: deltaAbs,
      delta_pct: deltaPct,
      triggered,
      error_message: todayObs?.error_message ? String(todayObs.error_message) : null,
    };
  });

  // If literally nothing has any data yet (every entry's first day),
  // skip the brief — it would just say "no comparison available."
  if (deltas.every((d) => d.prior_value == null && d.current_value == null)) {
    return null;
  }

  const user = await tenantQuery(tenantId, (trx) =>
    trx('users').where({ id: userId }).first(),
  );

  const context: MorningBriefContext = {
    userDisplayName: user ? (user.display_name as string ?? user.email as string) : null,
    briefDate: today,
    entries: deltas,
  };

  const { composeMorningBrief } = await import('../ai/AIService');
  const brief = await composeMorningBrief(context);

  // Persist + notify.
  const id = await tenantQuery(tenantId, async (trx) => {
    const [row] = await trx('morning_briefs').insert({
      user_id: userId,
      brief_date: today,
      content: JSON.stringify(brief),
    }).returning('id');
    return typeof row === 'object' ? Number((row as { id: number }).id) : Number(row);
  });

  // In-app notification — best-effort (don't fail the brief on a notify hiccup).
  try {
    await notify({
      tenantId,
      userId,
      type: 'morning_brief',
      title: 'Your morning brief is ready',
      message: brief.summary,
      link: '/home',
    });
  } catch (err) {
    logger.warn({ err, userId }, 'morningBriefService: notify failed');
  }

  return getTodaysBrief(tenantId, userId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function mapBrief(row: Record<string, unknown>): MorningBrief {
  const content = typeof row.content === 'string'
    ? JSON.parse(row.content) as MorningBriefOutput
    : row.content as MorningBriefOutput;
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    brief_date: String(row.brief_date),
    content,
    opened_at: row.opened_at ? String(row.opened_at) : null,
    emailed_at: row.emailed_at ? String(row.emailed_at) : null,
    created_at: String(row.created_at),
  };
}
