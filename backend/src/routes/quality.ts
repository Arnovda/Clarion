/**
 * Quality API routes
 *
 * GET  /tables?connectionId=                  list tables with latest profile stub
 * GET  /:connId/:table/summary                latest profile + dimension scores
 * GET  /:connId/:table/fields                 field profiles for latest run
 * GET  /:connId/:table/history                score history (last 90 days)
 * POST /:connId/:table/profile                trigger profiling + rule evaluation
 * GET  /:connId/:table/rules                  rules + latest execution result
 * POST /:connId/:table/rules                  create a rule
 * PATCH /rules/:ruleId                        update a rule
 * DELETE /rules/:ruleId                       delete a rule
 * GET  /:connId/:table/failures               paginated failed records
 * PATCH /failures/:failId                     update failure status
 */

import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import Database from 'better-sqlite3';
import { requireAuth, requireRole } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { runQualityProfile, runQualityProfileWithConnector } from '../quality/QualityProfiler';
import { DuckDBConnector } from '../connectors/DuckDBConnector';
import * as graph from '../db/semanticGraph';
import { notifyTenant } from '../services/notificationService';
import { resolveOwnerProductTable, OwnerResolveError } from '../services/productOwnership';
import { productBasePath, productSlug, isAzurePath } from '../services/warehouse';
import { generateQualityAlertContext } from '../ai/AIService';

const router = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

async function getFilepath(connId: number): Promise<string> {
  const conn = await semanticDb('connections').where({ id: connId }).first();
  if (!conn) throw new Error('Connection not found');
  const cfg = typeof conn.config === 'string' ? JSON.parse(conn.config) : conn.config;
  return path.resolve(cfg.filepath as string);
}

function ragStatus(score: number | null): 'green' | 'amber' | 'red' | 'grey' {
  if (score == null) return 'grey';
  if (score >= 0.9) return 'green';
  if (score >= 0.75) return 'amber';
  return 'red';
}

// ─── evaluate rules against source SQLite ───────────────────────────────────

async function evaluateRules(connId: number, tableName: string, filepath: string): Promise<void> {
  const rules = await semanticDb('quality_rules')
    .where({ connection_id: connId, table_name: tableName, is_active: true });
  if (!rules.length) return;

  const db = new Database(filepath, { readonly: true });
  try {
    const colDefs = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string; pk: number }>;
    const pkCol   = colDefs.find((c) => c.pk === 1)?.name ?? colDefs[0]?.name ?? 'rowid';
    const { cnt: total } = db.prepare(`SELECT COUNT(*) AS cnt FROM "${tableName}"`).get() as { cnt: number };

    for (const rule of rules) {
      const fields: string[] = Array.isArray(rule.field_names)
        ? rule.field_names
        : (rule.field_names ? JSON.parse(rule.field_names) : []);
      const field = fields[0] ?? '';
      const cfg   = rule.rule_config
        ? (typeof rule.rule_config === 'string' ? JSON.parse(rule.rule_config) : rule.rule_config)
        : {};

      type FailRow = { record_id: string; field_name: string; actual_value: string; expected_description: string };
      let failures: FailRow[] = [];

      try {
        if (rule.rule_type === 'null_check' && field) {
          const rows = db.prepare(`SELECT "${pkCol}" AS rid FROM "${tableName}" WHERE "${field}" IS NULL LIMIT 200`).all() as { rid: unknown }[];
          failures = rows.map((r) => ({ record_id: String(r.rid), field_name: field, actual_value: 'NULL', expected_description: `${field} must not be null` }));

        } else if (rule.rule_type === 'range' && field) {
          const conds: string[] = [];
          if (cfg.min != null) conds.push(`CAST("${field}" AS REAL) < ${cfg.min}`);
          if (cfg.max != null) conds.push(`CAST("${field}" AS REAL) > ${cfg.max}`);
          if (conds.length) {
            const rows = db.prepare(`SELECT "${pkCol}" AS rid, "${field}" AS val FROM "${tableName}" WHERE "${field}" IS NOT NULL AND (${conds.join(' OR ')}) LIMIT 200`).all() as { rid: unknown; val: unknown }[];
            failures = rows.map((r) => ({ record_id: String(r.rid), field_name: field, actual_value: String(r.val), expected_description: `${field} must be between ${cfg.min ?? '-∞'} and ${cfg.max ?? '+∞'}` }));
          }

        } else if (rule.rule_type === 'uniqueness' && field) {
          const rows = db.prepare(`SELECT "${pkCol}" AS rid, "${field}" AS val FROM "${tableName}" WHERE "${field}" IN (SELECT "${field}" FROM "${tableName}" GROUP BY "${field}" HAVING COUNT(*)>1) LIMIT 200`).all() as { rid: unknown; val: unknown }[];
          failures = rows.map((r) => ({ record_id: String(r.rid), field_name: field, actual_value: String(r.val), expected_description: `${field} must be unique` }));

        } else if (rule.rule_type === 'format' && field && cfg.pattern) {
          const rows = db.prepare(`SELECT "${pkCol}" AS rid, "${field}" AS val FROM "${tableName}" WHERE "${field}" IS NOT NULL AND "${field}" NOT GLOB '${cfg.pattern.replace(/'/g, "''")}' LIMIT 200`).all() as { rid: unknown; val: unknown }[];
          failures = rows.map((r) => ({ record_id: String(r.rid), field_name: field, actual_value: String(r.val), expected_description: `${field} must match pattern: ${cfg.pattern}` }));

        } else if (rule.rule_type === 'freshness' && cfg.date_field && cfg.max_age_hours != null) {
          const cutoff = new Date(Date.now() - cfg.max_age_hours * 3600 * 1000).toISOString();
          const rows = db.prepare(`SELECT "${pkCol}" AS rid, "${cfg.date_field}" AS val FROM "${tableName}" WHERE "${cfg.date_field}" < '${cutoff}' LIMIT 200`).all() as { rid: unknown; val: unknown }[];
          failures = rows.map((r) => ({ record_id: String(r.rid), field_name: cfg.date_field, actual_value: String(r.val), expected_description: `${cfg.date_field} must be within last ${cfg.max_age_hours}h` }));

        } else if (rule.rule_type === 'custom' && cfg.sql) {
          const rows = db.prepare(`SELECT "${pkCol}" AS rid FROM "${tableName}" WHERE NOT (${cfg.sql}) LIMIT 200`).all() as { rid: unknown }[];
          failures = rows.map((r) => ({ record_id: String(r.rid), field_name: field || 'multiple', actual_value: '—', expected_description: rule.description || cfg.sql }));
        }
      } catch (e) {
        console.error(`[RuleEngine] rule ${rule.id} failed:`, e);
      }

      // If a field-requiring rule has no field configured, mark as not configured
      // rather than silently passing — prevents misleading 100% pass rates.
      const needsField = ['null_check', 'range', 'format', 'uniqueness'].includes(rule.rule_type);
      const misconfigured = needsField && !field;

      const failing   = failures.length;
      const passing   = Math.max(0, total - failing);
      const passRate  = misconfigured ? null : (total > 0 ? passing / total : 1);
      const threshold = rule.pass_threshold ?? 0.95;
      const status    = misconfigured
        ? 'NOT_CONFIGURED'
        : (passRate! >= threshold ? 'PASS' : passRate! >= threshold - 0.1 ? 'WARNING' : 'FAIL');

      const [eRow] = await semanticDb('rule_executions')
        .insert({ rule_id: rule.id, pass_rate: passRate, total_records: total, passing_records: passing, failing_records: failing, status })
        .returning('id');
      const execId: number = typeof eRow === 'object' ? (eRow as { id: number }).id : eRow;

      for (const f of failures.slice(0, 200)) {
        await semanticDb('quality_failures').insert({
          rule_id: rule.id, execution_id: execId,
          record_id: f.record_id, field_name: f.field_name,
          actual_value: f.actual_value, expected_description: f.expected_description,
          first_detected: new Date().toISOString(), status: 'new',
        });
      }
    }

    // Update validity score in latest dataset_profiles row based on rule results
    const latest = await semanticDb('dataset_profiles')
      .where({ connection_id: connId, table_name: tableName })
      .orderBy('profiled_at', 'desc').first();

    if (latest) {
      const executions = await semanticDb('rule_executions as re')
        .join('quality_rules as qr', 're.rule_id', 'qr.id')
        .where({ 'qr.connection_id': connId, 'qr.table_name': tableName, 'qr.is_active': true })
        .select('re.pass_rate', 're.rule_id', 'qr.dimension')
        .orderBy('re.executed_at', 'desc');

      // Latest execution per rule (deduplicate by rule_id, ordered desc so first = latest)
      const seenRules = new Set<number>();
      const latestExecs: { pass_rate: number; dimension: string }[] = [];
      for (const ex of executions as { pass_rate: number; rule_id: number; dimension: string }[]) {
        if (!seenRules.has(ex.rule_id)) {
          seenRules.add(ex.rule_id);
          latestExecs.push(ex);
        }
      }

      // Rules pass rate = avg pass rate across ALL active rules, regardless of dimension
      const rulesPassRate = latestExecs.length
        ? latestExecs.reduce((s, e) => s + e.pass_rate, 0) / latestExecs.length
        : null;

      // Overall = simple average of the 3 table-level metrics
      // (BK completeness + BK uniqueness + rules pass rate) / count of available
      const available = [
        latest.completeness_score,
        latest.uniqueness_score,
        rulesPassRate,
      ].filter((s): s is number => s != null);
      const newOverall = available.length
        ? available.reduce((a, b) => a + b, 0) / available.length
        : 0;

      await semanticDb('dataset_profiles').where({ id: latest.id }).update({
        validity_score: rulesPassRate,
        overall_score:  newOverall,
      });

      await semanticDb('quality_score_history')
        .where({ connection_id: connId, table_name: tableName, score_date: new Date().toISOString().split('T')[0] })
        .update({ validity_score: rulesPassRate, overall_score: newOverall });
    }
  } finally {
    db.close();
  }
}

// ─── quality alert generation ───────────────────────────────────────────────

const ALERT_THRESHOLD = 0.75; // overall score below this triggers a critical alert
const DROP_THRESHOLD  = 0.10; // score drop of >10% triggers a warning alert

async function checkAndCreateAlerts(connId: number, tableName: string, tenantId?: number): Promise<void> {
  // Get the two most recent profiles
  const profiles = await semanticDb('dataset_profiles')
    .where({ connection_id: connId, table_name: tableName })
    .orderBy('profiled_at', 'desc')
    .limit(2);

  if (profiles.length === 0) return;
  const current = profiles[0];
  const previous = profiles.length > 1 ? profiles[1] : null;

  const currentScore = current.overall_score as number | null;
  if (currentScore == null) return;

  // Alert 1: Score below absolute threshold
  if (currentScore < ALERT_THRESHOLD) {
    const existing = await semanticDb('quality_alerts')
      .where({ connection_id: connId, table_name: tableName, alert_type: 'score_drop', dismissed: false })
      .where('current_score', '<', ALERT_THRESHOLD)
      .first();
    if (!existing) {
      const [alertRow] = await semanticDb('quality_alerts').insert({
        tenant_id: semanticDb.raw("current_setting('app.current_tenant')::integer"),
        connection_id: connId,
        table_name: tableName,
        alert_type: 'score_drop',
        severity: 'critical',
        message: `Quality score for "${tableName}" is ${(currentScore * 100).toFixed(0)}%, below the ${(ALERT_THRESHOLD * 100).toFixed(0)}% threshold.`,
        previous_score: previous?.overall_score ?? null,
        current_score: currentScore,
        threshold: ALERT_THRESHOLD,
      }).returning('id');
      const alertId: number = typeof alertRow === 'object' ? (alertRow as { id: number }).id : alertRow;

      // Fire-and-forget: enrich with Claude context
      generateQualityAlertContext({
        alertType: 'score_drop',
        tableName,
        currentScore,
        previousScore: previous?.overall_score ?? undefined,
      }).then((ctx) =>
        semanticDb('quality_alerts').where({ id: alertId }).update({ ai_context: ctx }),
      ).catch(() => {});

      if (tenantId) {
        notifyTenant(tenantId, 'quality_alert', `Quality alert: ${tableName}`, {
          message: `Score is ${(currentScore * 100).toFixed(0)}%, below ${(ALERT_THRESHOLD * 100).toFixed(0)}% threshold`,
          link: `/health`,
        }).catch(() => {});
      }
    }
  }

  // Alert 2: Significant score drop
  if (previous?.overall_score != null) {
    const prevScore = previous.overall_score as number;
    const drop = prevScore - currentScore;
    if (drop >= DROP_THRESHOLD) {
      const severity = drop >= 0.20 ? 'critical' : 'warning';
      const [dropRow] = await semanticDb('quality_alerts').insert({
        tenant_id: semanticDb.raw("current_setting('app.current_tenant')::integer"),
        connection_id: connId,
        table_name: tableName,
        alert_type: 'score_drop',
        severity,
        message: `Quality score for "${tableName}" dropped ${(drop * 100).toFixed(0)}% (from ${(prevScore * 100).toFixed(0)}% to ${(currentScore * 100).toFixed(0)}%).`,
        previous_score: prevScore,
        current_score: currentScore,
        threshold: DROP_THRESHOLD,
      }).returning('id');
      const dropAlertId: number = typeof dropRow === 'object' ? (dropRow as { id: number }).id : dropRow;

      generateQualityAlertContext({
        alertType: 'score_drop',
        tableName,
        currentScore,
        previousScore: prevScore,
        drop,
      }).then((ctx) =>
        semanticDb('quality_alerts').where({ id: dropAlertId }).update({ ai_context: ctx }),
      ).catch(() => {});

      if (tenantId && severity === 'critical') {
        notifyTenant(tenantId, 'quality_alert', `Quality dropped: ${tableName}`, {
          message: `Score fell ${(drop * 100).toFixed(0)}% to ${(currentScore * 100).toFixed(0)}%`,
          link: `/health`,
        }).catch(() => {});
      }
    }
  }

  // Alert 3: Rule failures — check latest rule executions
  const failedRules = await semanticDb('rule_executions as re')
    .join('quality_rules as qr', 're.rule_id', 'qr.id')
    .where({ 'qr.connection_id': connId, 'qr.table_name': tableName, 'qr.is_active': true })
    .where('re.status', 'FAIL')
    .orderBy('re.executed_at', 'desc')
    .select('qr.rule_name', 'qr.id as rule_id', 're.pass_rate', 're.status');

  // Deduplicate by rule_id (latest execution only)
  const seenAlertRules = new Set<number>();
  for (const fr of failedRules as { rule_name: string; rule_id: number; pass_rate: number }[]) {
    if (seenAlertRules.has(fr.rule_id)) continue;
    seenAlertRules.add(fr.rule_id);

    // Only create if there isn't already an active alert for this rule
    const existing = await semanticDb('quality_alerts')
      .where({ connection_id: connId, table_name: tableName, alert_type: 'rule_fail', dismissed: false })
      .whereRaw(`details->>'rule_id' = ?`, [String(fr.rule_id)])
      .first();
    if (!existing) {
      // Load rule type for the Claude prompt
      const ruleRow = await semanticDb('quality_rules').where({ id: fr.rule_id }).first();
      const [ruleAlertRow] = await semanticDb('quality_alerts').insert({
        tenant_id: semanticDb.raw("current_setting('app.current_tenant')::integer"),
        connection_id: connId,
        table_name: tableName,
        alert_type: 'rule_fail',
        severity: 'warning',
        message: `Rule "${fr.rule_name}" failed with ${(fr.pass_rate * 100).toFixed(1)}% pass rate.`,
        current_score: fr.pass_rate,
        details: JSON.stringify({ rule_id: fr.rule_id, rule_name: fr.rule_name }),
      }).returning('id');
      const ruleAlertId: number = typeof ruleAlertRow === 'object' ? (ruleAlertRow as { id: number }).id : ruleAlertRow;

      generateQualityAlertContext({
        alertType: 'rule_fail',
        tableName,
        currentScore: fr.pass_rate,
        ruleName: fr.rule_name,
        ruleType: ruleRow?.rule_type ?? undefined,
      }).then((ctx) =>
        semanticDb('quality_alerts').where({ id: ruleAlertId }).update({ ai_context: ctx }),
      ).catch(() => {});
    }
  }
}

// ─── routes ──────────────────────────────────────────────────────────────────

// GET /api/quality/tables?connectionId=
router.get('/tables', requireAuth, async (req, res, next) => {
  try {
    const connId = req.query.connectionId ? Number(req.query.connectionId) : undefined;

    // 1. Source tables
    const srcQuery = semanticDb('source_tables').where({ is_active: true });
    if (connId) srcQuery.where({ connection_id: connId });
    const srcTables = await srcQuery.select('id', 'connection_id', 'table_name', 'display_name');

    const sourceResult = await Promise.all(
      (srcTables as { id: number; connection_id: number; table_name: string; display_name: string }[]).map(async (t) => {
        const latest = await semanticDb('dataset_profiles')
          .where({ connection_id: t.connection_id, table_name: t.table_name })
          .orderBy('profiled_at', 'desc').first();
        return {
          ...t,
          layer:          'source' as const,
          product_name:   null as string | null,
          product_table_id: null as number | null,
          table_role:     null as string | null,
          profiled_at:    latest?.profiled_at ?? null,
          overall_score:  latest?.overall_score ?? null,
          row_count:      latest?.row_count ?? null,
          rag:            ragStatus(latest?.overall_score ?? null),
        };
      }),
    );

    // 2. Product tables (from star schemas)
    const ptQuery = semanticDb('product_tables as pt')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .join('data_products as dp', 'ss.data_product_id', 'dp.id')
      .whereIn('dp.status', ['approved', 'success']);
    if (connId) ptQuery.where('dp.connection_id', connId);
    const productTables = await ptQuery.select(
      'pt.id as pt_id', 'pt.table_name', 'pt.display_name as pt_display_name',
      'pt.table_role', 'pt.row_count as pt_row_count',
      'dp.id as dp_id', 'dp.name as product_name', 'dp.connection_id',
    );

    const productResult = await Promise.all(
      (productTables as {
        pt_id: number; table_name: string; pt_display_name: string | null;
        table_role: string; pt_row_count: number | null;
        dp_id: number; product_name: string; connection_id: number;
      }[]).map(async (t) => {
        const latest = await semanticDb('dataset_profiles')
          .where({ connection_id: t.connection_id, table_name: t.table_name })
          .orderBy('profiled_at', 'desc').first();
        return {
          id:               t.pt_id,
          connection_id:    t.connection_id,
          table_name:       t.table_name,
          display_name:     t.pt_display_name || t.table_name.replace(/_/g, ' '),
          layer:            'product' as const,
          product_name:     t.product_name,
          product_table_id: t.pt_id,
          table_role:       t.table_role,
          profiled_at:      latest?.profiled_at ?? null,
          overall_score:    latest?.overall_score ?? null,
          row_count:        latest?.row_count ?? t.pt_row_count ?? null,
          rag:              ragStatus(latest?.overall_score ?? null),
        };
      }),
    );

    res.json({ ok: true, data: [...sourceResult, ...productResult] });
  } catch (err) { next(err); }
});

// POST /api/quality/product/:productTableId/profile — trigger quality profiling for a product table.
// If the row is a reference to a shared dim, resolves to the owner product so we
// read the actual materialised parquet (not the consumer's empty stub directory).
router.post('/product/:productTableId/profile', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ptId = Number(req.params.productTableId);
    const tenantId = req.user?.tenantId;

    // Resolve, with a Neo4j-by-name fallback when the pgId is stale.
    // Catalog reads from Neo4j; if Postgres ids drifted (rebuild, partial sync),
    // the UI ends up with a pgId that no longer resolves. Look up the table by
    // (data_product_id, table_name) instead and retry.
    async function resolveWithFallback(): Promise<Awaited<ReturnType<typeof resolveOwnerProductTable>>> {
      try {
        return await resolveOwnerProductTable(ptId, tenantId);
      } catch (e) {
        if (!(e instanceof OwnerResolveError) || e.stage !== 'product_table') throw e;
        const hint = await graph.getProductTableByPgId(ptId);
        if (!hint || !hint.data_product_id || !hint.table_name) throw e;
        const ss = await semanticDb('star_schemas')
          .where({ data_product_id: hint.data_product_id })
          .first();
        if (!ss) throw e;
        const pt = await semanticDb('product_tables')
          .where({ star_schema_id: ss.id, table_name: hint.table_name })
          .first();
        if (!pt) throw e;
        return resolveOwnerProductTable(Number(pt.id), tenantId);
      }
    }

    let owner;
    try {
      owner = await resolveWithFallback();
    } catch (e) {
      if (e instanceof OwnerResolveError) {
        res.status(404).json({ ok: false, error: e.message, stage: e.stage });
        return;
      }
      throw e;
    }

    const pt = owner.productTable as { table_name: string };
    const dp = owner.product as { id: number; name: string };
    const conn = owner.connection as { id: number; warehouse_path?: string };

    // Resolve the product warehouse directory the same way every other
    // surface does — services/warehouse is the single source of truth.
    const warehousePath = conn.warehouse_path ?? `./warehouse/conn_${conn.id}`;
    const productDir = productBasePath(warehousePath, productSlug(dp.name));

    // Verify that warehouse data actually exists for this table before profiling.
    // Local fs check only — Azure (az://) paths can't be probed with fs, so we
    // skip the pre-flight and let DuckDB surface a clean error if the blob is missing.
    const isAzure = isAzurePath(productDir);
    if (!isAzure) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');
      const tablePath = path.join(productDir, pt.table_name);
      if (!fs.existsSync(tablePath) || !fs.readdirSync(tablePath).some((f) => f.endsWith('.parquet'))) {
        res.status(404).json({ ok: false, error: `No warehouse data found for table "${pt.table_name}". Run the transformation first.` });
        return;
      }
    }

    // Create DuckDB connector pointing at product warehouse
    const connector = new DuckDBConnector(productDir, [pt.table_name]);
    await connector.connect();

    // Profile is keyed on the *consumer's* connection_id — the row the UI is
    // asking about. That way the consumer's Quality tab shows fresh stats even
    // though the parquet lives under the owner's product slug.
    const requestedPt = await semanticDb('product_tables').where({ id: ptId }).first();
    const consumerSchema = requestedPt
      ? await semanticDb('star_schemas').where({ id: requestedPt.star_schema_id }).first()
      : null;
    const consumerProduct = consumerSchema
      ? await semanticDb('data_products').where({ id: consumerSchema.data_product_id }).first()
      : null;
    const consumerConnId = (consumerProduct?.connection_id ?? dp.id) as number;

    let result;
    try {
      result = await runQualityProfileWithConnector(
        consumerConnId,
        pt.table_name,
        connector,
      );
    } catch (err) {
      connector.disconnect();
      const msg = err instanceof Error ? err.message : String(err);
      // DuckDB raises this when the parquet/delta directory is missing — usually
      // because the transformation hasn't materialised the table yet. Surface a
      // clear, actionable message instead of the raw catalog error.
      if (/Table with name .* does not exist/i.test(msg) || /Catalog Error/i.test(msg)) {
        res.status(404).json({
          ok: false,
          error: `No warehouse data found for table "${pt.table_name}". Run the transformation first (Rebuild on the product overview).`,
        });
        return;
      }
      throw err;
    }

    connector.disconnect();

    res.json({ ok: true, data: { ...result, redirected: owner.redirected } });
  } catch (err) {
    next(err);
  }
});

// GET /api/quality/:connId/:table/summary
router.get('/:connId/:table/summary', requireAuth, async (req, res, next) => {
  try {
    const { connId, table } = req.params;
    const profile = await semanticDb('dataset_profiles')
      .where({ connection_id: Number(connId), table_name: table })
      .orderBy('profiled_at', 'desc').first();
    if (!profile) { res.json({ ok: true, data: null }); return; }
    res.json({ ok: true, data: { ...profile, rag: ragStatus(profile.overall_score) } });
  } catch (err) { next(err); }
});

// GET /api/quality/:connId/:table/fields
router.get('/:connId/:table/fields', requireAuth, async (req, res, next) => {
  try {
    const { connId, table } = req.params;
    const profile = await semanticDb('dataset_profiles')
      .where({ connection_id: Number(connId), table_name: table })
      .orderBy('profiled_at', 'desc').first();
    if (!profile) { res.json({ ok: true, data: [] }); return; }
    const fields = await semanticDb('field_profiles').where({ profile_id: profile.id });
    res.json({ ok: true, data: fields });
  } catch (err) { next(err); }
});

// GET /api/quality/:connId/:table/history?days=90
router.get('/:connId/:table/history', requireAuth, async (req, res, next) => {
  try {
    const { connId, table } = req.params;
    const days = Number(req.query.days ?? 90);
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString().split('T')[0];
    const rows = await semanticDb('quality_score_history')
      .where({ connection_id: Number(connId), table_name: table })
      .where('score_date', '>=', since)
      .orderBy('score_date', 'asc');
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/quality/:connId/:table/evaluate  — run rule evaluation only (no re-profiling)
router.post('/:connId/:table/evaluate', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const connId = Number(req.params.connId);
    const table  = req.params.table;
    const fp     = await getFilepath(connId);
    await evaluateRules(connId, table, fp);
    await checkAndCreateAlerts(connId, table, req.user?.tenantId);
    const updated = await semanticDb('dataset_profiles')
      .where({ connection_id: connId, table_name: table })
      .orderBy('profiled_at', 'desc').first();
    res.json({ ok: true, data: updated });
  } catch (err) { next(err); }
});

// POST /api/quality/:connId/:table/profile  — trigger profiling + rule eval
router.post('/:connId/:table/profile', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const connId = Number(req.params.connId);
    const table  = req.params.table;
    const fp     = await getFilepath(connId);

    // Use user-configured BK column if one has been set for this table
    const stRow = await semanticDb('source_tables')
      .where({ connection_id: connId, table_name: table })
      .select('business_key_column')
      .first() as { business_key_column: string | null } | undefined;
    const bkOverride = stRow?.business_key_column ?? undefined;

    const result = await runQualityProfile(connId, table, fp, bkOverride);
    await evaluateRules(connId, table, fp);
    await checkAndCreateAlerts(connId, table, req.user?.tenantId);
    // Return updated summary
    const updated = await semanticDb('dataset_profiles').where({ id: result.profileId }).first();

    // Sync latest stats to Neo4j nodes (non-fatal if Neo4j is unavailable)
    try {
      await graph.updateTableQualityStats(connId, table, {
        rowCount:       result.rowCount ?? null,
        lastProfiledAt: new Date().toISOString(),
      });
      for (const f of result.fields) {
        await graph.updateColumnQualityStats(connId, table, f.field_name, {
          nullCount:     f.null_count    ?? null,
          nullPct:       f.null_pct      ?? null,
          distinctCount: f.distinct_count ?? null,
          distinctPct:   f.distinct_pct  ?? null,
          minValue:      f.min_value     != null ? String(f.min_value)  : null,
          maxValue:      f.max_value     != null ? String(f.max_value)  : null,
          meanValue:     f.mean_value    ?? null,
          medianValue:   f.median_value  ?? null,
          topValues:     f.top_values    ?? null,
        });
      }
    } catch (neo4jErr) {
      console.warn('[Quality] Neo4j stats sync failed (non-fatal):', neo4jErr);
    }

    res.json({ ok: true, data: updated });
  } catch (err) { next(err); }
});

// GET /api/quality/:connId/:table/settings  — business key + other table-level settings
router.get('/:connId/:table/settings', requireAuth, async (req, res, next) => {
  try {
    const connId = Number(req.params.connId);
    const table  = decodeURIComponent(req.params.table);

    const stRow = await semanticDb('source_tables')
      .where({ connection_id: connId, table_name: table })
      .select('business_key_column')
      .first() as { business_key_column: string | null } | undefined;

    const latestProfile = await semanticDb('dataset_profiles')
      .where({ connection_id: connId, table_name: table })
      .orderBy('profiled_at', 'desc')
      .select('business_key_column')
      .first() as { business_key_column: string | null } | undefined;

    res.json({ ok: true, data: {
      user_bk:      stRow?.business_key_column         ?? null,
      suggested_bk: latestProfile?.business_key_column ?? null,
    }});
  } catch (err) { next(err); }
});

// PATCH /api/quality/:connId/:table/settings  — set user business key override
router.patch('/:connId/:table/settings', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const connId = Number(req.params.connId);
    const table  = decodeURIComponent(req.params.table);
    const { business_key_column } = req.body as { business_key_column: string | null };

    await semanticDb('source_tables')
      .where({ connection_id: connId, table_name: table })
      .update({ business_key_column: business_key_column || null });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/quality/:connId/:table/rules
router.get('/:connId/:table/rules', requireAuth, async (req, res, next) => {
  try {
    const { connId, table } = req.params;
    const rules = await semanticDb('quality_rules')
      .where({ connection_id: Number(connId), table_name: table })
      .orderBy('created_at', 'asc');

    // Attach latest execution per rule — flatten status/pass_rate to top level
    const result = await Promise.all(
      (rules as { id: number }[]).map(async (rule) => {
        const latestExec = await semanticDb('rule_executions')
          .where({ rule_id: rule.id })
          .orderBy('executed_at', 'desc').first() as { pass_rate: number; status: string } | undefined;
        // Last 30 days sparkline — map executed_at → score_date to match frontend type
        const sparklineRaw = await semanticDb('rule_executions')
          .where({ rule_id: rule.id })
          .where('executed_at', '>=', new Date(Date.now() - 30 * 86400000).toISOString())
          .orderBy('executed_at', 'asc')
          .select('pass_rate', 'executed_at');
        const sparkline = (sparklineRaw as { pass_rate: number; executed_at: string | Date }[])
          .map((r) => ({
            score_date: new Date(r.executed_at).toISOString().slice(0, 10),
            pass_rate: r.pass_rate,
          }));
        return {
          ...rule,
          latest_status:    latestExec?.status    ?? null,
          latest_pass_rate: latestExec?.pass_rate ?? null,
          sparkline,
        };
      }),
    );
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// POST /api/quality/:connId/:table/rules  — create a rule
router.post('/:connId/:table/rules', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const connId = Number(req.params.connId);
    const table  = req.params.table;
    const { rule_name, dimension, field_names, description, rule_type, rule_config, pass_threshold, owner_name } = req.body;
    const [row] = await semanticDb('quality_rules')
      .insert({
        connection_id:  connId,
        table_name:     table,
        rule_name, dimension,
        field_names:    JSON.stringify(field_names ?? []),
        description,
        rule_type,
        rule_config:    JSON.stringify(rule_config ?? {}),
        pass_threshold: pass_threshold ?? 0.95,
        owner_name,
      })
      .returning('*');
    res.json({ ok: true, data: row });
  } catch (err) { next(err); }
});

// PATCH /api/quality/rules/:ruleId
router.patch('/rules/:ruleId', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { rule_name, dimension, field_names, description, rule_type, rule_config, pass_threshold, owner_name, is_active } = req.body;
    const update: Record<string, unknown> = {};
    if (rule_name     !== undefined) update.rule_name     = rule_name;
    if (dimension     !== undefined) update.dimension     = dimension;
    if (field_names   !== undefined) update.field_names   = JSON.stringify(field_names);
    if (description   !== undefined) update.description   = description;
    if (rule_type     !== undefined) update.rule_type     = rule_type;
    if (rule_config   !== undefined) update.rule_config   = JSON.stringify(rule_config);
    if (pass_threshold!== undefined) update.pass_threshold= pass_threshold;
    if (owner_name    !== undefined) update.owner_name    = owner_name;
    if (is_active     !== undefined) update.is_active     = is_active;
    await semanticDb('quality_rules').where({ id: req.params.ruleId }).update(update);
    const updated = await semanticDb('quality_rules').where({ id: req.params.ruleId }).first();
    res.json({ ok: true, data: updated });
  } catch (err) { next(err); }
});

// DELETE /api/quality/rules/:ruleId
router.delete('/rules/:ruleId', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    await semanticDb('quality_rules').where({ id: req.params.ruleId }).delete();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/quality/:connId/:table/failures?page=1&ruleId=&field=&status=
router.get('/:connId/:table/failures', requireAuth, async (req, res, next) => {
  try {
    const { connId, table } = req.params;
    const page    = Math.max(1, Number(req.query.page ?? 1));
    const limit   = 25;
    const offset  = (page - 1) * limit;
    const ruleId  = req.query.ruleId ? Number(req.query.ruleId) : undefined;
    const field   = req.query.field  as string | undefined;
    const status  = req.query.status as string | undefined;

    // Get rule ids for this table
    const ruleIds = (await semanticDb('quality_rules')
      .where({ connection_id: Number(connId), table_name: table })
      .select('id')) as { id: number }[];
    const ids = ruleIds.map((r) => r.id);

    if (!ids.length) { res.json({ ok: true, data: [], total: 0, page, pages: 0 }); return; }

    // Only failures from the LATEST execution per rule
    const latestExecIds: number[] = [];
    for (const rid of (ruleId ? [ruleId] : ids)) {
      const ex = await semanticDb('rule_executions').where({ rule_id: rid }).orderBy('executed_at', 'desc').first();
      if (ex) latestExecIds.push((ex as { id: number }).id);
    }
    if (!latestExecIds.length) { res.json({ ok: true, data: [], total: 0, page, pages: 0 }); return; }

    let q = semanticDb('quality_failures as qf')
      .join('quality_rules as qr', 'qf.rule_id', 'qr.id')
      .whereIn('qf.execution_id', latestExecIds);
    if (field)  q = q.where('qf.field_name', field);
    if (status) q = q.where('qf.status', status);

    const [{ count }] = await q.clone().count('qf.id as count') as { count: string }[];
    const total = Number(count);

    const rows = await q
      .select('qf.*', 'qr.rule_name', 'qr.dimension')
      .orderBy('qf.first_detected', 'desc')
      .limit(limit).offset(offset);

    res.json({ ok: true, data: { rows, total, page, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

// PATCH /api/quality/failures/:failId
router.patch('/failures/:failId', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body as { status: string };
    await semanticDb('quality_failures').where({ id: req.params.failId }).update({ status });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── quality alerts ─────────────────────────────────────────────────────────

// GET /api/quality/alerts?dismissed=false
router.get('/alerts', requireAuth, async (req, res, next) => {
  try {
    const dismissed = req.query.dismissed === 'true';
    const q = semanticDb('quality_alerts')
      .where({ dismissed })
      .orderBy('created_at', 'desc')
      .limit(50);
    const alerts = await q;
    res.json({ ok: true, data: alerts });
  } catch (err) { next(err); }
});

// PATCH /api/quality/alerts/:id/dismiss
router.patch('/alerts/:id/dismiss', requireAuth, async (req, res, next) => {
  try {
    await semanticDb('quality_alerts')
      .where({ id: req.params.id })
      .update({
        dismissed: true,
        dismissed_by: req.user!.email,
        dismissed_at: new Date().toISOString(),
      });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/quality/alerts/dismiss-all
router.post('/alerts/dismiss-all', requireAuth, async (req, res, next) => {
  try {
    await semanticDb('quality_alerts')
      .where({ dismissed: false })
      .update({
        dismissed: true,
        dismissed_by: req.user!.email,
        dismissed_at: new Date().toISOString(),
      });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
