/**
 * UPGRADE KEYS — move an existing workspace's product tables onto
 * `clarion_key` in one step (2026-09-24).
 *
 * Tables built before today carry one of two older key forms (keyHealth.ts):
 * ROW_NUMBER keys that renumber per build (a lone rebuild of the lookup moves
 * fact rows to the wrong customer), or the raw source id (stable, but a GUID
 * join is twice as slow and 7.5× bigger). Neither can be switched one table
 * at a time: the moment a lookup's key changes, every table holding its keys
 * must change with it, and all of them must be rebuilt before anyone reads.
 * So this is one job:
 *
 *   1. PLAN (pure, `planKeyUpgrade`) — per lookup, the key becomes
 *      clarion_key('<Entity>', <its natural id expression>); per column that
 *      points at it, the same call on the pointing table's OWN id expression.
 *      Deterministic wherever the SQL shows that expression directly (the
 *      raw-id form: `TRY_CAST(l.Account AS VARCHAR) AS account_key` →
 *      `clarion_key('Accounts', TRY_CAST(l.Account AS VARCHAR))`). A table
 *      that got its key by JOINING the lookup (the ROW_NUMBER era) cannot be
 *      rewritten by text substitution — the id sits in a join condition — so
 *      that table goes to the model, once.
 *   2. CHECK, before anything is stored — every new SQL is guarded, compiled
 *      in a real warehouse session, must produce the SAME columns in the SAME
 *      order, must make each planned key with clarion_key on the planned
 *      entity, and the whole set must satisfy the key rule. One failure and
 *      NOTHING is written.
 *   3. STORE in one transaction (SQL, deploy cells, key column metadata on
 *      originals and their copies).
 *   4. REBUILD every subject of the source in dependency order (the pipeline
 *      runner, no source sync), then report each fact's orphan rate from the
 *      checks the build ran.
 *
 * A lookup with NO surrogate key at all (first-generation connector
 * templates, whose facts join on the raw id) is not rewritten here: adding a
 * key column changes the table's shape. Those move with a Rebuild, which uses
 * template v2.
 */
import type { Database } from 'duckdb-async';
import {
  isDateDimension,
  keyFormOf,
  keyRuleViolations,
  replaceSelectItem,
  selectItemFor,
  changedKeys,
  type KeyForm,
} from '@databridge/connectors/dist/keys';
import { tenantQuery } from './tenantQuery';
import { loadKeyGraph, tableKeyHealth, summariseKeyHealth, type KeyGraph, type KeyTableRow } from './keyHealth';
import { parseAliasMap } from './lineageDerivation';
import {
  openDeclarationSession,
  compileDeclaredSql,
  prepareDeclaredSql,
  describeSessionSchemas,
  sanitizeSqlError,
} from './tableDeclaration';
import { syncDeployCell } from './refineService';
import { rewriteForeignKeysToClarionKey } from '../ai/AIService';
import { runPipelineWorkflow, type OrchestratorEvent } from './busMatrixOrchestrator';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ module: 'key-upgrade' });

// ─── Plan ─────────────────────────────────────────────────────────────────

export interface KeyUpgradeChange {
  column: string;
  entity: string;
  /** How the new expression is obtained. */
  how: 'lookup-key' | 'wrapped' | 'model';
}

export interface KeyUpgradeStep {
  tableId: number;
  tableName: string;
  tableRole: string | null;
  productId: number;
  productName: string;
  oldSql: string;
  /** SQL after the deterministic changes; the model's changes come on top. */
  sql: string;
  changes: KeyUpgradeChange[];
  /** Columns the model must rewrite (the table joined the lookup for them). */
  forModel: Array<{ column: string; entity: string; lookupTable: string; lookupNaturalColumn: string | null; lookupKeyColumn: string }>;
}

export interface KeyUpgradePlan {
  steps: KeyUpgradeStep[];
  /** Why the upgrade cannot run at all (named per table). */
  blockers: string[];
  /** Lookups with no key column: they move with a Rebuild, not here. */
  rebuildInstead: string[];
  /** Tables already on clarion_key. */
  alreadyHashed: number;
}

/** Strip string literals so a qualifier inside a literal is never read as a column reference. */
function withoutStrings(expr: string): string {
  return expr.replace(/'(?:[^']|'')*'/g, "''");
}

function qualifiersOf(expr: string): string[] {
  const out: string[] = [];
  for (const m of withoutStrings(expr).matchAll(/("?)([A-Za-z_]\w*)\1\s*\.\s*("?)([A-Za-z_]\w*)\3/g)) out.push(m[2].toLowerCase());
  return out;
}

/**
 * The relation an id expression reads from, by alias — the entity its key
 * hashes. `a.ID` in `FROM Accounts a` → 'Accounts'. With no qualifier and a
 * single FROM relation, that relation. Otherwise null (caller falls back).
 */
export function relationOfExpression(sql: string, expr: string): string | null {
  const aliases = parseAliasMap(sql);
  for (const q of qualifiersOf(expr)) {
    const rel = aliases.get(q);
    if (rel) return rel;
  }
  const distinct = [...new Set(aliases.values())];
  return distinct.length === 1 ? distinct[0] : null;
}

/**
 * Does this expression read ONLY non-product relations (source tables)? False
 * when any qualifier resolves to a product table (it looked the key up in a
 * lookup), is unknown (a CTE alias — cannot tell), or the expression is bare
 * while the FROM list includes a product table.
 */
export function readsOnlySources(sql: string, expr: string, productTableNames: ReadonlySet<string>): boolean {
  if (/\bselect\b/i.test(withoutStrings(expr))) return false; // a subquery — not a plain column
  const aliases = parseAliasMap(sql);
  const qs = qualifiersOf(expr);
  if (qs.length === 0) {
    return ![...aliases.values()].some((r) => productTableNames.has(r.toLowerCase()));
  }
  for (const q of qs) {
    const rel = aliases.get(q);
    if (!rel) return false;
    if (productTableNames.has(rel.toLowerCase())) return false;
  }
  return true;
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The id expression a ROW_NUMBER key was ordered by, when it is one expression. */
function rowNumberOrderExpression(item: string): string | null {
  const m = /ORDER\s+BY\s+([\s\S]+?)\)\s*$/i.exec(item.trim());
  if (!m) return null;
  const expr = m[1].replace(/\s+(ASC|DESC)\s*$/i, '').trim();
  return expr && !expr.includes(',') ? expr : null;
}

export function planKeyUpgrade(graph: KeyGraph): KeyUpgradePlan {
  const plan: KeyUpgradePlan = { steps: [], blockers: [], rebuildInstead: [], alreadyHashed: 0 };
  const productNames = new Set(graph.tables.map((t) => t.table_name.toLowerCase()));
  const byId = new Map(graph.tables.map((t) => [t.id, t]));
  const steps = new Map<number, KeyUpgradeStep>();
  const stepFor = (t: KeyTableRow): KeyUpgradeStep => {
    let s = steps.get(t.id);
    if (!s) {
      s = {
        tableId: t.id, tableName: t.table_name, tableRole: t.table_role, productId: t.product_id, productName: t.product_name,
        oldSql: t.transformation_sql ?? '', sql: t.transformation_sql ?? '', changes: [], forModel: [],
      };
      steps.set(t.id, s);
    }
    return s;
  };

  // 1. Every lookup key → clarion_key on its natural id.
  //    lookupKey: table id → { column, entity, oldForm, naturalColumn }
  const lookupKey = new Map<number, { column: string; entity: string; oldForm: KeyForm; naturalColumn: string | null }>();
  for (const t of graph.tables) {
    if (isDateDimension(t.table_name) || !t.transformation_sql) continue;
    const sk = t.columns.find((c) => c.column_role === 'surrogate_key');
    if (!sk || t.table_role === 'fact') continue;
    const form = keyFormOf(t.transformation_sql, sk.column_name, sk.transformation_expression);
    const nk = t.columns.find((c) => c.column_role === 'natural_key');
    if (form.kind === 'hashed') {
      lookupKey.set(t.id, { column: sk.column_name, entity: form.entity, oldForm: form, naturalColumn: nk?.column_name ?? null });
      plan.alreadyHashed++;
      continue;
    }
    if (form.kind === 'hashed-dynamic') {
      plan.blockers.push(`${t.table_name}.${sk.column_name}: clarion_key without a literal entity — fix it on the SQL tab first`);
      continue;
    }
    let idExpr = nk ? selectItemFor(t.transformation_sql, nk.column_name) : null;
    if (!idExpr) {
      const keyItem = selectItemFor(t.transformation_sql, sk.column_name);
      if (keyItem && form.kind === 'other') idExpr = keyItem;
      else if (keyItem && form.kind === 'unstable') idExpr = rowNumberOrderExpression(keyItem);
    }
    if (!idExpr) {
      plan.blockers.push(`${t.table_name}: cannot tell which source id its key stands for (no natural-key column) — Rebuild this subject instead`);
      continue;
    }
    const entity = relationOfExpression(t.transformation_sql, idExpr) ?? t.table_name;
    const next = replaceSelectItem(stepFor(t).sql, sk.column_name, `clarion_key(${quoteLiteral(entity)}, ${idExpr.trim()})`);
    if (next === null) {
      plan.blockers.push(`${t.table_name}.${sk.column_name}: the key is not named in the SQL — Rebuild this subject instead`);
      continue;
    }
    const step = stepFor(t);
    step.sql = next;
    step.changes.push({ column: sk.column_name, entity: entity.toLowerCase(), how: 'lookup-key' });
    lookupKey.set(t.id, { column: sk.column_name, entity: entity.toLowerCase(), oldForm: form, naturalColumn: nk?.column_name ?? null });
  }

  // 2. Every column pointing at a lookup key → the same call on its own id.
  const handled = new Set<string>();
  for (const j of graph.joins) {
    const to = byId.get(j.to_table_id);
    const from = byId.get(j.from_table_id);
    if (!to || !from || !from.transformation_sql) continue;
    if (isDateDimension(to.table_name) || isDateDimension(from.table_name)) continue;
    const lk = lookupKey.get(to.id);
    if (!lk) {
      // The join does not target a keyed lookup (first-generation template:
      // facts join the raw natural id). Reported once per lookup.
      if (to.table_role !== 'fact' && !to.columns.some((c) => c.column_role === 'surrogate_key')) {
        if (!plan.rebuildInstead.includes(to.table_name)) plan.rebuildInstead.push(to.table_name);
      }
      continue;
    }
    if (j.to_column.toLowerCase() !== lk.column.toLowerCase()) continue; // joins on the natural id: not a key
    const k = `${from.id}.${j.from_column}`.toLowerCase();
    if (handled.has(k)) continue;
    handled.add(k);

    const current = keyFormOf(steps.get(from.id)?.sql ?? from.transformation_sql, j.from_column,
      from.columns.find((c) => c.column_name === j.from_column)?.transformation_expression);
    if (current.kind === 'hashed') {
      if (current.entity === lk.entity) continue;
      plan.blockers.push(`${from.table_name}.${j.from_column} hashes '${current.entity}' but ${to.table_name} uses '${lk.entity}' — fix it on the SQL tab first`);
      continue;
    }
    const expr = selectItemFor(stepFor(from).sql, j.from_column);
    const canWrap = expr !== null
      && current.kind === 'other'
      && lk.oldForm.kind !== 'unstable'
      && readsOnlySources(from.transformation_sql, expr, productNames);
    const step = stepFor(from);
    if (canWrap) {
      const next = replaceSelectItem(step.sql, j.from_column, `clarion_key(${quoteLiteral(lk.entity)}, ${expr!.trim()})`);
      if (next !== null) {
        step.sql = next;
        step.changes.push({ column: j.from_column, entity: lk.entity, how: 'wrapped' });
        continue;
      }
    }
    step.forModel.push({ column: j.from_column, entity: lk.entity, lookupTable: to.table_name, lookupNaturalColumn: lk.naturalColumn, lookupKeyColumn: lk.column });
    step.changes.push({ column: j.from_column, entity: lk.entity, how: 'model' });
  }

  plan.steps = [...steps.values()].filter((s) => s.changes.length > 0);
  return plan;
}

// ─── Check + store + rebuild ──────────────────────────────────────────────

export interface RunKeyUpgradeOptions {
  connectionId: number;
  tenantId: number;
  userEmail?: string;
  emit: (event: OrchestratorEvent) => void;
  abortSignal?: AbortSignal;
  isCancelled?: () => boolean | Promise<boolean>;
}

export interface RunKeyUpgradeResult {
  allOk: boolean;
  tablesChanged: number;
  rebuiltProducts: number;
}

class KeyUpgradeCancelled extends Error {
  constructor() { super('Key upgrade cancelled by user'); this.name = 'CancelledError'; }
}

async function checkCancelled(opts: RunKeyUpgradeOptions): Promise<void> {
  if (opts.abortSignal?.aborted) throw new KeyUpgradeCancelled();
  if (opts.isCancelled && (await opts.isCancelled())) throw new KeyUpgradeCancelled();
}

/** Every planned key made with clarion_key on its planned entity, and nothing else in the table moved. */
export function verifyStep(step: KeyUpgradeStep, newSql: string, oldColumns: string[], newColumns: string[]): string[] {
  const problems: string[] = [];
  if (oldColumns.join('|').toLowerCase() !== newColumns.join('|').toLowerCase()) {
    problems.push(`${step.tableName}: the columns changed (${oldColumns.length} → ${newColumns.length}, or a different order)`);
  }
  for (const c of step.changes) {
    const form = keyFormOf(newSql, c.column);
    if (form.kind !== 'hashed' || form.entity !== c.entity) {
      problems.push(`${step.tableName}.${c.column}: expected clarion_key('${c.entity}', …), found ${form.kind === 'hashed' ? `'${form.entity}'` : form.kind}`);
    }
  }
  // Keys that were already clarion_key must stay exactly as they were.
  problems.push(...changedKeys(step.oldSql, newSql).map((p) => `${step.tableName}: ${p}`));
  return problems;
}

async function rowCount(session: Database, sql: string): Promise<number> {
  const r = await session.all(`SELECT COUNT(*) AS n FROM (\n${sql}\n) AS _k`) as Array<{ n: number | bigint }>;
  return Number(r[0]?.n ?? 0);
}

export async function runKeyUpgradeWorkflow(opts: RunKeyUpgradeOptions): Promise<RunKeyUpgradeResult> {
  const { connectionId, tenantId, emit } = opts;
  emit({ type: 'phase', text: 'Reading how every table makes its keys…', friendly: 'Checking how your tables are linked…' });

  const graph = await tenantQuery(tenantId, (db) => loadKeyGraph(db, tenantId, connectionId));
  const plan = planKeyUpgrade(graph);
  if (plan.blockers.length > 0) {
    throw new Error(`The keys cannot be upgraded automatically: ${plan.blockers.slice(0, 4).join('; ')}. Nothing was changed.`);
  }
  if (plan.steps.length === 0) {
    if (plan.rebuildInstead.length > 0) {
      throw new Error(`These lookups have no key column yet (${plan.rebuildInstead.slice(0, 5).join(', ')}) — their subjects move to stable keys with a Rebuild, not an upgrade. Nothing was changed.`);
    }
    emit({ type: 'log', text: 'Every key already uses clarion_key — nothing to upgrade.' });
    emit({ type: 'done', text: 'Your keys are already up to date.' });
    return { allOk: true, tablesChanged: 0, rebuiltProducts: 0 };
  }
  const byModel = plan.steps.filter((s) => s.forModel.length > 0);
  emit({
    type: 'log',
    text: `${plan.steps.length} table(s) change: ${plan.steps.length - byModel.length} rewritten directly, ${byModel.length} rewritten by the assistant (they looked their keys up in a lookup).`,
  });

  // ── Check everything before storing anything ──────────────────────────
  const session = await tenantQuery(tenantId, (db) => openDeclarationSession(db, tenantId, connectionId));
  const finalSql = new Map<number, string>();
  try {
    const schemas = byModel.length > 0 ? await describeSessionSchemas(session) : '';
    for (const step of plan.steps) {
      await checkCancelled(opts);
      emit({ type: 'log', text: `  ${step.productName} · ${step.tableName}: ${step.changes.map((c) => c.column).join(', ')}` });

      let oldColumns: string[];
      try {
        oldColumns = (await compileDeclaredSql(session, prepareDeclaredSql(step.oldSql))).map((c) => c.name);
      } catch (err) {
        throw new Error(`${step.tableName} does not compile today (${sanitizeSqlError(err instanceof Error ? err.message : String(err))}) — fix or rebuild it first. Nothing was changed.`);
      }

      let sql = step.sql;
      if (step.forModel.length > 0) {
        const rewrite = await rewriteForeignKeysToClarionKey({
          tableName: step.tableName,
          tableRole: step.tableRole ?? 'table',
          currentSql: sql,
          keys: step.forModel,
          availableSchemas: schemas,
        });
        sql = rewrite.sql;
        if (rewrite.notes) emit({ type: 'log', text: `    ${rewrite.notes}` });
      }
      let inner: string;
      let newColumns: string[];
      try {
        inner = prepareDeclaredSql(sql);
        newColumns = (await compileDeclaredSql(session, inner)).map((c) => c.name);
      } catch (err) {
        throw new Error(`The upgraded SQL for ${step.tableName} did not compile (${sanitizeSqlError(err instanceof Error ? err.message : String(err))}). Nothing was changed.`);
      }
      const problems = verifyStep(step, inner, oldColumns, newColumns);
      if (problems.length > 0) {
        throw new Error(`The upgrade of ${step.tableName} failed its checks: ${problems.slice(0, 3).join('; ')}. Nothing was changed.`);
      }
      // A rewrite that dropped a join must never lose rows (an INNER JOIN on
      // the lookup silently dropped rows whose account was missing — the new
      // SQL may KEEP more, never fewer).
      if (step.forModel.length > 0) {
        const [before, after] = [await rowCount(session, prepareDeclaredSql(step.oldSql)), await rowCount(session, inner)];
        if (after < before) {
          throw new Error(`The upgraded SQL for ${step.tableName} returns fewer rows (${after} vs ${before}). Nothing was changed.`);
        }
        if (after > before) emit({ type: 'log', text: `    ${step.tableName} now keeps ${after - before} row(s) the old lookup join dropped.` });
      }
      finalSql.set(step.tableId, inner);
    }
  } finally {
    try { await session.close(); } catch { /* ignore */ }
  }

  // The whole set must satisfy the key rule, strictly for what changed.
  const newGraphTables = graph.tables.map((t) => ({
    table_name: t.table_name,
    table_role: t.table_role,
    transformation_sql: finalSql.get(t.id) ?? t.transformation_sql,
    columns: t.columns.map((c) => ({ column_name: c.column_name, column_role: c.column_role, transformation_expression: c.transformation_expression })),
  }));
  const ruleProblems = keyRuleViolations(newGraphTables, graph.joins, {
    mode: 'consistent',
    onlyTables: plan.steps.map((s) => s.tableName),
  });
  if (ruleProblems.length > 0) {
    throw new Error(`The upgraded keys would not match: ${ruleProblems.slice(0, 3).join('; ')}. Nothing was changed.`);
  }

  await checkCancelled(opts);

  // ── Store, all or nothing ─────────────────────────────────────────────
  emit({ type: 'phase', text: `Saving ${finalSql.size} table(s)…`, friendly: 'Saving the new keys…' });
  const declaredBy = `${opts.userEmail ?? 'Clarion'} (key upgrade)`;
  const now = new Date().toISOString();
  // tenantQuery IS one transaction: every table or none.
  await tenantQuery(tenantId, async (trx) => {
    {
      for (const step of plan.steps) {
        const sql = finalSql.get(step.tableId)!;
        await trx('product_tables').where({ id: step.tableId, tenant_id: tenantId }).update({
          transformation_sql: sql, declared_by: declaredBy, declared_at: now, updated_at: now,
        });
        await syncDeployCell(trx, step.tableId, sql);
        // The key columns' metadata follows: an integer, made by clarion_key.
        const copies: Array<{ id: number }> = await trx('product_tables')
          .where({ source_product_table_id: step.tableId, tenant_id: tenantId })
          .select('id');
        for (const c of step.changes) {
          const expr = selectItemFor(sql, c.column);
          await trx('product_columns')
            .where({ product_table_id: step.tableId, column_name: c.column })
            .update({ data_type: 'BIGINT', ...(expr ? { transformation_expression: expr } : {}) });
          if (copies.length > 0) {
            await trx('product_columns')
              .whereIn('product_table_id', copies.map((x) => Number(x.id)))
              .andWhere({ column_name: c.column })
              .update({ data_type: 'BIGINT' });
          }
        }
      }
    }
  });
  log.info({ connectionId, tenantId, tables: finalSql.size }, 'key upgrade stored');

  // ── Rebuild every subject of the source together ─────────────────────
  const productIds = (await tenantQuery(tenantId, (db) => db('data_products')
    .where({ tenant_id: tenantId, connection_id: connectionId })
    .select('id')) as Array<{ id: number }>).map((r) => Number(r.id));
  emit({ type: 'phase', text: `Rebuilding ${productIds.length} subject(s) with the new keys…`, friendly: 'Rebuilding your subjects with the new keys…' });
  const result = await runPipelineWorkflow({
    scope: { sourceIds: [], productIds, shouldSyncSources: false },
    tenantId,
    userEmail: opts.userEmail,
    abortSignal: opts.abortSignal,
    isCancelled: opts.isCancelled,
    // The pipeline announces its own 'done'; this workflow still has a report to give.
    emit: (e) => { if (e.type !== 'done') emit(e); },
  });

  // ── Report what the build measured: does every fact key find its lookup? ─
  const changedIds = plan.steps.map((s) => s.tableId);
  const checks: Array<{ table_name: string; status: string; total_rows: number; duplicate_count: number }> = await tenantQuery(tenantId, (db) =>
    db('transformation_checks as tc')
      .join('product_tables as pt', 'pt.id', 'tc.product_table_id')
      .whereIn('tc.product_table_id', changedIds)
      .andWhere('pt.tenant_id', tenantId)
      .andWhere('tc.check_type', 'ref_integrity')
      .andWhere('tc.executed_at', '>=', now)
      .select('pt.table_name', 'tc.status', 'tc.total_rows', 'tc.duplicate_count'));
  for (const c of checks) {
    if (c.status === 'fail') {
      emit({ type: 'log', text: `  ${c.table_name}: ${c.duplicate_count} of ${c.total_rows} key(s) find no lookup row — the same values the source sent before; see the table's Quality tab.` });
    }
  }
  const after = summariseKeyHealth(await tenantQuery(tenantId, (db) => loadKeyGraph(db, tenantId, connectionId)));
  emit({
    type: 'done',
    text: result.allOk
      ? `Keys upgraded: ${finalSql.size} table(s) now join on stable integer keys${after.raw.length + after.unstable.length > 0 ? ` (${after.raw.length + after.unstable.length} still to do)` : ''}.`
      : 'Keys upgraded, but some tables failed to rebuild — see the errors above.',
  });
  return { allOk: result.allOk, tablesChanged: finalSql.size, rebuiltProducts: productIds.length };
}

/** What an upgrade would do, without doing it — the Build page's offer. */
export async function describeKeyUpgrade(graph: KeyGraph): Promise<{
  tables: number;
  byAssistant: number;
  blockers: string[];
  rebuildInstead: string[];
  unstable: string[];
}> {
  const plan = planKeyUpgrade(graph);
  return {
    tables: plan.steps.length,
    byAssistant: plan.steps.filter((s) => s.forModel.length > 0).length,
    blockers: plan.blockers,
    rebuildInstead: plan.rebuildInstead,
    unstable: graph.tables.filter((t) => tableKeyHealth(t).status === 'unstable').map((t) => t.table_name),
  };
}
