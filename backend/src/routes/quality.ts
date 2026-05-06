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
import { isAzurePath } from '../services/warehouse';
import { resolveProductTableById } from '../services/tableCatalog';
import { tenantQuery } from '../services/tenantQuery';
import { generateQualityAlertContext } from '../ai/AIService';

const router = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Custom error returned when a quality endpoint that requires direct
 * SQLite file access is hit against a non-SQLite connection (e.g. a
 * Postgres source, or a product/DuckDB connection). The route handler
 * catches this and returns 400 instead of leaking the cryptic
 * `path.resolve` "paths[0] argument must be of type string" error to
 * the user.
 */
class UnsupportedConnectionTypeError extends Error {
  status = 400;
  constructor(msg: string) {
    super(msg);
    this.name = 'UnsupportedConnectionTypeError';
  }
}

async function getFilepath(connId: number): Promise<string> {
  const conn = await semanticDb('connections').where({ id: connId }).first();
  if (!conn) throw new Error('Connection not found');
  const cfg = typeof conn.config === 'string' ? JSON.parse(conn.config) : conn.config;
  if (!cfg || typeof cfg.filepath !== 'string' || !cfg.filepath.trim()) {
    // Most likely this is a product/DuckDB connection or a Postgres
    // source — neither has a filepath. Don't crash with a path.resolve
    // error; surface a friendly message so the frontend can hide the
    // button or show a meaningful toast.
    throw new UnsupportedConnectionTypeError(
      'Rule evaluation against this connection is not yet supported — only SQLite-backed sources can be evaluated directly.',
    );
  }
  return path.resolve(cfg.filepath);
}

function ragStatus(score: number | null): 'green' | 'amber' | 'red' | 'grey' {
  if (score == null) return 'grey';
  if (score >= 0.9) return 'green';
  if (score >= 0.75) return 'amber';
  return 'red';
}

// ─── Rule evaluation — dialect-agnostic core + per-engine adapters ──────────
//
// Rule evaluation runs SQL like "give me up to 200 rows that fail this rule"
// against the underlying engine — SQLite for source connections, DuckDB for
// product tables. The two dialects have small but real differences that we
// capture in a `RuleDialect` adapter:
//
//   • Record id: SQLite uses pkCol (or rowid); DuckDB has no rowid, so we
//     synthesise one with ROW_NUMBER() OVER ().
//   • Format match: SQLite uses GLOB patterns ('*@*.com'); DuckDB has no
//     GLOB, so we translate the glob to a regex and use regexp_matches.
//   • Custom SQL: passes through; user owns the dialect.
//
// Everything else — the rule loop, threshold logic, rule_executions /
// quality_failures inserts, dataset_profiles + quality_score_history score
// recompute — is engine-agnostic and lives in evaluateRulesCore. Adding a
// new engine (Postgres source, MySQL source, …) is one new RuleDialect, no
// touching the core.
//
// Rules are tenant/connection-scoped via quality_rules.connection_id; for
// product tables that's the consumer's connection_id, set up by the caller
// (mirrors the same dance as POST /quality/product/:id/profile).

interface FailureRow { record_id: string; field_name: string; actual_value: string; expected_description: string }

interface RuleDialect {
  /** Total row count for the target table. */
  total(): Promise<number>;
  /** Find up to 200 failure rows for a rule. Returns [] when the rule type
   *  doesn't apply or nothing fails. */
  findFailures(rule: QualityRuleRow): Promise<FailureRow[]>;
  /** Optional cleanup (close db handles, disconnect connectors). */
  close?(): Promise<void> | void;
}

interface QualityRuleRow {
  id: number;
  rule_type: string;
  field_names: string[] | string;
  rule_config: Record<string, unknown> | string | null;
  description: string | null;
  pass_threshold: number | null;
}

/** Translate a SQLite GLOB pattern to a regex for DuckDB's regexp_matches.
 *  Unknown special chars beyond * and ? are escaped to keep the user's
 *  intent intact. The regex is wrapped with ^...$ so it matches the full
 *  string (GLOB semantics). */
function globToRegex(glob: string): string {
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if (/[.+^${}()|[\]\\]/.test(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out + '$';
}

/**
 * Pull rule_config off a QualityRuleRow defensively — Postgres returns
 * JSONB as an object, but some test paths pass strings.
 */
function parseRuleConfig(r: QualityRuleRow): Record<string, unknown> {
  if (r.rule_config == null) return {};
  if (typeof r.rule_config === 'string') {
    try { return JSON.parse(r.rule_config) as Record<string, unknown>; }
    catch { return {}; }
  }
  return r.rule_config;
}

function parseRuleFields(r: QualityRuleRow): string[] {
  if (Array.isArray(r.field_names)) return r.field_names;
  if (typeof r.field_names === 'string' && r.field_names) {
    try { return JSON.parse(r.field_names) as string[]; }
    catch { return []; }
  }
  return [];
}

/**
 * Engine-agnostic evaluator. Iterates rules, calls the dialect to find
 * failures, inserts execution + failures rows, and recomputes scores.
 */
async function evaluateRulesCore(
  connId: number,
  tableName: string,
  dialect: RuleDialect,
): Promise<void> {
  const rules: QualityRuleRow[] = await semanticDb('quality_rules')
    .where({ connection_id: connId, table_name: tableName, is_active: true });
  if (!rules.length) return;

  try {
    const total = await dialect.total();

    for (const rule of rules) {
      let failures: FailureRow[] = [];
      try {
        failures = await dialect.findFailures(rule);
      } catch (e) {
        console.error(`[RuleEngine] rule ${rule.id} failed:`, e);
      }

      // If a field-requiring rule has no field configured, mark as not configured
      // rather than silently passing — prevents misleading 100% pass rates.
      const fields = parseRuleFields(rule);
      const field = fields[0] ?? '';
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

    // Recompute validity_score + overall_score on the latest dataset_profiles
    // row from this round of rule executions. Tenant-agnostic Postgres-only
    // logic — works the same for source and product tables since profiles are
    // keyed on (connection_id, table_name).
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

      const rulesPassRate = latestExecs.length
        ? latestExecs.reduce((s, e) => s + e.pass_rate, 0) / latestExecs.length
        : null;

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
    await dialect.close?.();
  }
}

// ─── SQLite dialect adapter ────────────────────────────────────────────────

class SqliteRuleDialect implements RuleDialect {
  private db: Database.Database;
  private tableName: string;
  private pkCol: string;
  private cachedTotal: number | null = null;

  constructor(filepath: string, tableName: string) {
    this.db = new Database(filepath, { readonly: true });
    this.tableName = tableName;
    const colDefs = this.db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string; pk: number }>;
    this.pkCol = colDefs.find((c) => c.pk === 1)?.name ?? colDefs[0]?.name ?? 'rowid';
  }

  async total(): Promise<number> {
    if (this.cachedTotal == null) {
      const { cnt } = this.db.prepare(`SELECT COUNT(*) AS cnt FROM "${this.tableName}"`).get() as { cnt: number };
      this.cachedTotal = cnt;
    }
    return this.cachedTotal;
  }

  async findFailures(rule: QualityRuleRow): Promise<FailureRow[]> {
    const fields = parseRuleFields(rule);
    const field = fields[0] ?? '';
    const cfg = parseRuleConfig(rule);
    const t = this.tableName;
    const pk = this.pkCol;

    if (rule.rule_type === 'null_check' && field) {
      const rows = this.db.prepare(`SELECT "${pk}" AS rid FROM "${t}" WHERE "${field}" IS NULL LIMIT 200`).all() as { rid: unknown }[];
      return rows.map((r) => ({ record_id: String(r.rid), field_name: field, actual_value: 'NULL', expected_description: `${field} must not be null` }));
    }

    if (rule.rule_type === 'range' && field) {
      const conds: string[] = [];
      if (cfg.min != null) conds.push(`CAST("${field}" AS REAL) < ${Number(cfg.min)}`);
      if (cfg.max != null) conds.push(`CAST("${field}" AS REAL) > ${Number(cfg.max)}`);
      if (!conds.length) return [];
      const rows = this.db.prepare(`SELECT "${pk}" AS rid, "${field}" AS val FROM "${t}" WHERE "${field}" IS NOT NULL AND (${conds.join(' OR ')}) LIMIT 200`).all() as { rid: unknown; val: unknown }[];
      return rows.map((r) => ({ record_id: String(r.rid), field_name: field, actual_value: String(r.val), expected_description: `${field} must be between ${cfg.min ?? '-∞'} and ${cfg.max ?? '+∞'}` }));
    }

    if (rule.rule_type === 'uniqueness' && field) {
      const rows = this.db.prepare(`SELECT "${pk}" AS rid, "${field}" AS val FROM "${t}" WHERE "${field}" IN (SELECT "${field}" FROM "${t}" GROUP BY "${field}" HAVING COUNT(*)>1) LIMIT 200`).all() as { rid: unknown; val: unknown }[];
      return rows.map((r) => ({ record_id: String(r.rid), field_name: field, actual_value: String(r.val), expected_description: `${field} must be unique` }));
    }

    if (rule.rule_type === 'format' && field && cfg.pattern) {
      const pattern = String(cfg.pattern).replace(/'/g, "''");
      const rows = this.db.prepare(`SELECT "${pk}" AS rid, "${field}" AS val FROM "${t}" WHERE "${field}" IS NOT NULL AND "${field}" NOT GLOB '${pattern}' LIMIT 200`).all() as { rid: unknown; val: unknown }[];
      return rows.map((r) => ({ record_id: String(r.rid), field_name: field, actual_value: String(r.val), expected_description: `${field} must match pattern: ${cfg.pattern}` }));
    }

    if (rule.rule_type === 'freshness' && cfg.date_field && cfg.max_age_hours != null) {
      const cutoff = new Date(Date.now() - Number(cfg.max_age_hours) * 3600 * 1000).toISOString();
      const dateField = String(cfg.date_field);
      const rows = this.db.prepare(`SELECT "${pk}" AS rid, "${dateField}" AS val FROM "${t}" WHERE "${dateField}" < '${cutoff}' LIMIT 200`).all() as { rid: unknown; val: unknown }[];
      return rows.map((r) => ({ record_id: String(r.rid), field_name: dateField, actual_value: String(r.val), expected_description: `${dateField} must be within last ${cfg.max_age_hours}h` }));
    }

    if (rule.rule_type === 'custom' && cfg.sql) {
      const sql = String(cfg.sql);
      const rows = this.db.prepare(`SELECT "${pk}" AS rid FROM "${t}" WHERE NOT (${sql}) LIMIT 200`).all() as { rid: unknown }[];
      return rows.map((r) => ({ record_id: String(r.rid), field_name: field || 'multiple', actual_value: '—', expected_description: rule.description || sql }));
    }

    return [];
  }

  close(): void { this.db.close(); }
}

// ─── DuckDB dialect adapter ────────────────────────────────────────────────
//
// Wraps the (already-connected) DuckDBConnector that the caller built via
// resolveProductTableById + parentDir + tablePaths. The connector owns the
// view registration (one view per product table); we just run SQL against
// it and project a synthetic ROW_NUMBER as the record id.

interface DuckDBExecutor {
  executeQuery(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

class DuckDBRuleDialect implements RuleDialect {
  private connector: DuckDBExecutor;
  private viewName: string;
  private cachedTotal: number | null = null;

  constructor(connector: DuckDBExecutor, viewName: string) {
    this.connector = connector;
    this.viewName = viewName;
  }

  async total(): Promise<number> {
    if (this.cachedTotal != null) return this.cachedTotal;
    const r = await this.connector.executeQuery(`SELECT COUNT(*) AS cnt FROM "${this.viewName}"`);
    this.cachedTotal = Number((r.rows[0]?.cnt ?? 0));
    return this.cachedTotal;
  }

  /** Wrap the target view in a CTE that synthesises a stable-within-query
   *  __rid via ROW_NUMBER() OVER (). DuckDB has no rowid, but for the
   *  purposes of "show me failing rows" any unique label per row is fine —
   *  the user uses these to spot outliers, not to JOIN back. */
  private withRowNum(): string {
    return `WITH t AS (SELECT *, ROW_NUMBER() OVER () AS __rid FROM "${this.viewName}")`;
  }

  async findFailures(rule: QualityRuleRow): Promise<FailureRow[]> {
    const fields = parseRuleFields(rule);
    const field = fields[0] ?? '';
    const cfg = parseRuleConfig(rule);
    const cte = this.withRowNum();

    if (rule.rule_type === 'null_check' && field) {
      const r = await this.connector.executeQuery(
        `${cte} SELECT __rid AS rid FROM t WHERE "${field}" IS NULL LIMIT 200`,
      );
      return r.rows.map((row) => ({
        record_id: String(row.rid), field_name: field, actual_value: 'NULL',
        expected_description: `${field} must not be null`,
      }));
    }

    if (rule.rule_type === 'range' && field) {
      const conds: string[] = [];
      if (cfg.min != null) conds.push(`CAST("${field}" AS DOUBLE) < ${Number(cfg.min)}`);
      if (cfg.max != null) conds.push(`CAST("${field}" AS DOUBLE) > ${Number(cfg.max)}`);
      if (!conds.length) return [];
      const r = await this.connector.executeQuery(
        `${cte} SELECT __rid AS rid, "${field}" AS val FROM t WHERE "${field}" IS NOT NULL AND (${conds.join(' OR ')}) LIMIT 200`,
      );
      return r.rows.map((row) => ({
        record_id: String(row.rid), field_name: field, actual_value: String(row.val),
        expected_description: `${field} must be between ${cfg.min ?? '-∞'} and ${cfg.max ?? '+∞'}`,
      }));
    }

    if (rule.rule_type === 'uniqueness' && field) {
      // Subquery references the same CTE so the GROUP BY runs against the
      // identical row set as the outer scan.
      const r = await this.connector.executeQuery(
        `${cte} SELECT __rid AS rid, "${field}" AS val FROM t WHERE "${field}" IN (SELECT "${field}" FROM t GROUP BY "${field}" HAVING COUNT(*)>1) LIMIT 200`,
      );
      return r.rows.map((row) => ({
        record_id: String(row.rid), field_name: field, actual_value: String(row.val),
        expected_description: `${field} must be unique`,
      }));
    }

    if (rule.rule_type === 'format' && field && cfg.pattern) {
      // DuckDB has no GLOB. Translate the user-stored pattern to a regex
      // and use regexp_matches. Existing rule rows store glob (e.g. *@*.com)
      // and we don't mutate them — only translate at evaluation time.
      const regex = globToRegex(String(cfg.pattern)).replace(/'/g, "''");
      const r = await this.connector.executeQuery(
        `${cte} SELECT __rid AS rid, "${field}" AS val FROM t WHERE "${field}" IS NOT NULL AND NOT regexp_matches(CAST("${field}" AS VARCHAR), '${regex}') LIMIT 200`,
      );
      return r.rows.map((row) => ({
        record_id: String(row.rid), field_name: field, actual_value: String(row.val),
        expected_description: `${field} must match pattern: ${cfg.pattern}`,
      }));
    }

    if (rule.rule_type === 'freshness' && cfg.date_field && cfg.max_age_hours != null) {
      const cutoff = new Date(Date.now() - Number(cfg.max_age_hours) * 3600 * 1000).toISOString();
      const dateField = String(cfg.date_field);
      const r = await this.connector.executeQuery(
        `${cte} SELECT __rid AS rid, "${dateField}" AS val FROM t WHERE "${dateField}" < '${cutoff}' LIMIT 200`,
      );
      return r.rows.map((row) => ({
        record_id: String(row.rid), field_name: dateField, actual_value: String(row.val),
        expected_description: `${dateField} must be within last ${cfg.max_age_hours}h`,
      }));
    }

    if (rule.rule_type === 'custom' && cfg.sql) {
      // User-authored SQL passes through. The CTE wraps it so __rid is
      // available, but the user's WHERE clause should reference column
      // names the same way as in SQLite — most predicates are dialect-
      // compatible. If a user writes SQLite-only syntax, the rule fails
      // gracefully (caught in evaluateRulesCore).
      const sql = String(cfg.sql);
      const r = await this.connector.executeQuery(
        `${cte} SELECT __rid AS rid FROM t WHERE NOT (${sql}) LIMIT 200`,
      );
      return r.rows.map((row) => ({
        record_id: String(row.rid), field_name: field || 'multiple', actual_value: '—',
        expected_description: rule.description || sql,
      }));
    }

    return [];
  }
}

// ─── Public entry points ───────────────────────────────────────────────────
//
// The two existing call sites (POST /:connId/:table/evaluate and POST
// /:connId/:table/profile) keep calling evaluateRules(connId, table, fp)
// which routes through the SQLite adapter. The new product route calls
// evaluateRulesDuckDB instead. Both ultimately funnel into evaluateRulesCore.

async function evaluateRules(connId: number, tableName: string, filepath: string): Promise<void> {
  const dialect = new SqliteRuleDialect(filepath, tableName);
  await evaluateRulesCore(connId, tableName, dialect);
}

async function evaluateRulesDuckDB(
  connId: number,
  tableName: string,
  connector: DuckDBExecutor,
): Promise<void> {
  const dialect = new DuckDBRuleDialect(connector, tableName);
  await evaluateRulesCore(connId, tableName, dialect);
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
    const conn = owner.connection as { id: number };
    // owner.productTable.id is what we feed the catalog — that's the OWNER's
    // product_table row id, which has the materialised delta_path. For stub
    // rows in downstream products, the runner mirrors the upstream owner's
    // path onto the stub via publishStubFromUpstream — but we route through
    // the owner here for symmetry with how the rest of the app is wired.
    const ownerPtId = owner.productTable as { id: number };

    // Resolve the table location through the catalog. Single source of truth:
    //   • returns null if not yet materialised (rather than us doing fs checks)
    //   • returns a host-usable URI (local path or az://) — works in either env
    //   • internally tenant-scoped via tenantQuery so RLS gives us our rows
    const resolved = await resolveProductTableById(tenantId, Number(ownerPtId.id));
    if (!resolved) {
      res.status(404).json({
        ok: false,
        error: `No warehouse data for "${pt.table_name}" yet. Run a refresh first (the table is in DRAFT state, or the upstream owner hasn't been materialised).`,
      });
      return;
    }

    // Build a connector that points at the resolved URI. Parent-dir is the
    // DuckDB "warehouse root"; tablePaths gives the explicit per-table URI
    // so it works even when the row's path doesn't sit under productDir
    // (e.g. stub rows pointing at the upstream owner's parquet directory).
    const parentDir = isAzurePath(resolved.uri)
      ? resolved.uri.substring(0, resolved.uri.lastIndexOf('/'))
      : path.dirname(resolved.uri);
    const tablePaths = new Map<string, string>([[resolved.tableName, resolved.uri]]);
    const connector = new DuckDBConnector(parentDir, [resolved.tableName], tablePaths);
    await connector.connect();

    // Profile is keyed on the *consumer's* connection_id — the row the UI is
    // asking about. The catalog query above returned the OWNER's row; for
    // stubs that's a different product than what the user clicked on, so we
    // look up the consumer separately. tenantQuery wraps in a transaction
    // with SET LOCAL app.current_tenant so RLS sees our rows reliably.
    const consumerConnId = await tenantQuery(tenantId, async (trx) => {
      const row = await trx('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .join('data_products as dp', 'ss.data_product_id', 'dp.id')
        .where('pt.id', ptId)
        .select('dp.connection_id as cid')
        .first();
      // Defensive fallback: if the consumer row can't be resolved (RLS,
      // dropped product, broken state), use the owner's connection — that's
      // a real connections.id, not a product id (was a bug in the previous
      // implementation: `dp.id` is a product id and would FK-fail).
      return row?.cid != null ? Number(row.cid) : Number(conn.id);
    });

    let result;
    try {
      result = await runQualityProfileWithConnector(
        consumerConnId,
        pt.table_name,
        connector,
        undefined,
        undefined,
        tenantId,
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

// POST /api/quality/product/:productTableId/evaluate — run rule evaluation
// against a product table via DuckDB. Mirrors the resolve+connector dance
// from /product/:productTableId/profile above, then routes through
// evaluateRulesDuckDB instead of profiling. Cheaper than profiling: skips
// per-field stats and only runs the active rules.
router.post('/product/:productTableId/evaluate', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ptId = Number(req.params.productTableId);
    const tenantId = req.user?.tenantId;

    // Same resolveOwnerProductTable + Neo4j-by-name fallback as /profile.
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
    const conn = owner.connection as { id: number };
    const ownerPtId = owner.productTable as { id: number };

    const resolved = await resolveProductTableById(tenantId, Number(ownerPtId.id));
    if (!resolved) {
      res.status(404).json({
        ok: false,
        error: `No warehouse data for "${pt.table_name}" yet. Run a refresh first.`,
      });
      return;
    }

    const parentDir = isAzurePath(resolved.uri)
      ? resolved.uri.substring(0, resolved.uri.lastIndexOf('/'))
      : path.dirname(resolved.uri);
    const tablePaths = new Map<string, string>([[resolved.tableName, resolved.uri]]);
    const connector = new DuckDBConnector(parentDir, [resolved.tableName], tablePaths);
    await connector.connect();

    // Same consumer-vs-owner connection_id resolution as /profile. Rules
    // are written against the consumer's connection_id, so evaluation
    // must score against that same id (otherwise the score-recompute join
    // in evaluateRulesCore reads different rules than were evaluated).
    const consumerConnId = await tenantQuery(tenantId, async (trx) => {
      const row = await trx('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .join('data_products as dp', 'ss.data_product_id', 'dp.id')
        .where('pt.id', ptId)
        .select('dp.connection_id as cid')
        .first();
      return row?.cid != null ? Number(row.cid) : Number(conn.id);
    });

    try {
      await evaluateRulesDuckDB(consumerConnId, pt.table_name, connector);
      await checkAndCreateAlerts(consumerConnId, pt.table_name, tenantId);
    } catch (err) {
      connector.disconnect();
      const msg = err instanceof Error ? err.message : String(err);
      if (/Table with name .* does not exist/i.test(msg) || /Catalog Error/i.test(msg)) {
        res.status(404).json({
          ok: false,
          error: `No warehouse data found for table "${pt.table_name}". Run the transformation first.`,
        });
        return;
      }
      throw err;
    }

    connector.disconnect();

    const updated = await semanticDb('dataset_profiles')
      .where({ connection_id: consumerConnId, table_name: pt.table_name })
      .orderBy('profiled_at', 'desc').first();
    res.json({ ok: true, data: updated });
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
    let fp: string;
    try {
      fp = await getFilepath(connId);
    } catch (err) {
      if (err instanceof UnsupportedConnectionTypeError) {
        res.status(400).json({ ok: false, error: err.message });
        return;
      }
      throw err;
    }
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
    let fp: string;
    try {
      fp = await getFilepath(connId);
    } catch (err) {
      if (err instanceof UnsupportedConnectionTypeError) {
        res.status(400).json({
          ok: false,
          error: 'For product tables, use the product profile endpoint (/api/quality/product/:productTableId/profile) — direct file profiling is not available.',
        });
        return;
      }
      throw err;
    }

    // Use user-configured BK column if one has been set for this table
    const stRow = await semanticDb('source_tables')
      .where({ connection_id: connId, table_name: table })
      .select('business_key_column')
      .first() as { business_key_column: string | null } | undefined;
    const bkOverride = stRow?.business_key_column ?? undefined;

    const result = await runQualityProfile(connId, table, fp, bkOverride, req.user?.tenantId);
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
