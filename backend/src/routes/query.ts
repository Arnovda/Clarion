import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import Database from 'better-sqlite3';
import { requireAuth } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { notifyAdmins } from '../services/notificationService';
import { createConnector, createProductConnector } from '../connectors/ConnectorFactory';
import { buildProductSemanticContext, getProductWarehousePath } from '../services/productContext';
import { applyDataPolicies } from '../services/policyEngine';
import { buildSemanticContextForQuery, getDimensionColumns, getJoinPaths, getTableAndColumnNames, buildRelevantSubgraph } from '../db/semanticGraph';
import { generateSql, generateSqlStreaming, generateCrossSourceSql, formatAnswer, validateQueryResultIfNeeded, callClaudeMultiTurn, extractEntitiesFromQuestion, forecastQuery, SqlDialect } from '../ai/AIService';
import { isForecastQuestion } from '../ai/prompts/forecastPrompt';
import { computeForecast, TimeSeriesPoint } from '../services/forecastEngine';
import {
  REPAIR_SYSTEM,
  getRepairSystem,
  buildRepairContext,
  buildRepairQueryResult,
  buildRepairClarificationAnswer,
  RepairAction,
} from '../ai/prompts/repairPrompt';

const router = Router();

// Shared alias helper — used by both the single-source and cross-view handlers
function sanitizeAlias(name: string): string {
  return (name
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_(sqlite|db)$/, '') || 'db');
}

// Helper — derive SQL dialect from connection record
function getDialect(connection: { query_engine?: string } | undefined): SqlDialect {
  return connection?.query_engine === 'duckdb' ? 'duckdb' : 'sqlite';
}

export type DataLayer = 'product' | 'source';

/**
 * Resolve which data layer to query.
 *
 * Default is 'product' whenever a product layer exists for this connection.
 * The client can opt into 'source' explicitly (e.g. an admin debugging the raw
 * source schema). When no product layer exists, source is the only option.
 *
 * No silent fallback: once we've decided 'product', the rest of the pipeline
 * (including the repair loop) stays on the product layer. Earlier behaviour
 * was to fall back to source when product SQL failed, which yielded
 * inconsistent answers across follow-up questions.
 */
function resolveDataLayer(requested: unknown, hasProduct: boolean): DataLayer {
  if (requested === 'source') return 'source';
  return hasProduct ? 'product' : 'source';
}

// Sub-score confidence check — blocks if overall < 0.7 OR any sub-score < 0.5
import type { NlToSqlOutput } from '../ai/prompts/nlToSqlPrompt';
import { buildCacheKey, getCachedSql, putCachedSql } from '../services/queryCache';
import { trackMetric, trackEvent } from '../utils/monitoring';

function shouldBlockQuery(r: NlToSqlOutput): { blocked: boolean; reason: string } {
  if (r.confidence < 0.7)
    return { blocked: true, reason: `Low overall confidence (${r.confidence})` };
  if (r.schema_confidence < 0.5)
    return { blocked: true, reason: `Low schema confidence (${r.schema_confidence}) — unsure which tables/columns to use` };
  if (r.join_confidence < 0.5)
    return { blocked: true, reason: `Low join confidence (${r.join_confidence}) — unsure how tables connect` };
  if (r.formula_confidence < 0.5)
    return { blocked: true, reason: `Low formula confidence (${r.formula_confidence}) — unsure about the aggregation/KPI formula` };
  return { blocked: false, reason: '' };
}

function buildGapDescription(question: string, r: NlToSqlOutput): string {
  const parts = [
    `confidence=${r.confidence}`,
    `schema=${r.schema_confidence}`,
    `join=${r.join_confidence}`,
    `formula=${r.formula_confidence}`,
  ];
  const notes = r.uncertainty_notes.length ? ` | Notes: ${r.uncertainty_notes.join('; ')}` : '';
  return `Blocked (${parts.join(', ')}) for question: "${question}"${notes}`;
}

function blockedUserMessage(r: NlToSqlOutput): string {
  if (r.uncertainty_notes.length > 0) {
    return `I'm not confident enough to answer: ${r.uncertainty_notes[0]}. This question has been noted for review.`;
  }
  return "I don't have enough context to answer that confidently yet. This question has been noted for review.";
}

// Detect columns that share the same name across 2+ tables in scope.
// Returns a disambiguation warning to append to the semantic context.
function buildColumnDisambiguationWarning(
  columns: { table_name?: string; table_id: number; column_name: string; description?: string }[],
  tables: { id: number; table_name: string }[],
): string {
  const tableMap = new Map(tables.map((t) => [t.id, t.table_name]));
  const colByName = new Map<string, string[]>();
  for (const c of columns) {
    const tName = c.table_name ?? tableMap.get(c.table_id) ?? '?';
    const key = c.column_name.toLowerCase();
    if (!colByName.has(key)) colByName.set(key, []);
    colByName.get(key)!.push(`${tName}.${c.column_name}${c.description ? ` (${c.description})` : ''}`);
  }
  const ambiguous = [...colByName.entries()].filter(([, refs]) => refs.length >= 2);
  if (!ambiguous.length) return '';
  const lines = ambiguous.map(([name, refs]) =>
    `  "${name}" exists in: ${refs.join(', ')}`,
  );
  return `\n--- COLUMN DISAMBIGUATION WARNING ---\nThe following column names appear in multiple tables. Be explicit about which table you use:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Conversation history loader — fetches the last N messages for follow-up context
// ---------------------------------------------------------------------------
async function loadConversationHistory(
  conversationId: number,
  limit = 5,
): Promise<Array<{ role: string; content: string }>> {
  try {
    const rows = await semanticDb('conversation_messages')
      .where({ conversation_id: conversationId })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('role', 'content', 'sql', 'tables_used', 'rows', 'confidence');

    // Reverse to chronological order. For assistant messages, splice in the
    // executed SQL + a tiny row sample so the model can see what queries it
    // actually ran on prior turns. Without this it can't answer methodology
    // follow-ups ("how did you calculate X?") and may regenerate a different
    // SQL for the same question on the next turn.
    return rows.reverse().map((r: {
      role: string;
      content: string;
      sql: string | null;
      tables_used: string[] | null;
      rows: unknown[] | null;
      confidence: number | null;
    }) => {
      if (r.role !== 'assistant' || !r.sql) {
        return { role: r.role, content: r.content };
      }
      const tables = Array.isArray(r.tables_used) ? r.tables_used.join(', ') : '';
      const sampleRows = Array.isArray(r.rows) ? r.rows.slice(0, 3) : [];
      const totalRows = Array.isArray(r.rows) ? r.rows.length : 0;
      const conf = typeof r.confidence === 'number' ? Math.round(r.confidence * 100) : null;
      const lines: string[] = [r.content];
      lines.push(`\n[methodology — for your reference, do not repeat verbatim]`);
      if (tables) lines.push(`Tables used: ${tables}`);
      if (conf != null) lines.push(`Confidence: ${conf}%`);
      lines.push(`SQL executed:\n${r.sql}`);
      if (sampleRows.length > 0) {
        lines.push(`Returned ${totalRows} row(s). Sample: ${JSON.stringify(sampleRows)}`);
      } else if (totalRows === 0) {
        lines.push(`Returned 0 rows.`);
      }
      return { role: r.role, content: lines.join('\n') };
    });
  } catch {
    // If the conversation doesn't exist or the query fails, return empty — non-blocking
    return [];
  }
}

// Dedup-or-increment gap: if a similar unresolved gap exists (keyword overlap),
// bump its hit_count instead of creating a duplicate.
async function upsertDefinitionGap(queryLogId: number, description: string, question: string, tenantId?: number): Promise<void> {
  const words = question.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (words.length > 0) {
    const existing = await semanticDb('definition_gaps').where({ resolved: false });
    for (const gap of existing) {
      const gapWords = (gap.gap_description as string).toLowerCase();
      const overlap = words.filter((w) => gapWords.includes(w));
      if (overlap.length >= 2) {
        await semanticDb('definition_gaps').where({ id: gap.id }).update({
          hit_count: semanticDb.raw('hit_count + 1'),
          last_hit_at: new Date().toISOString(),
        });
        return;
      }
    }
  }
  // tenant_id has a Postgres default that reads from current_setting('app.current_tenant'),
  // but pooled connections sometimes route the INSERT to a connection without that GUC,
  // producing a NOT NULL violation. Pass it explicitly when the caller knows it.
  await semanticDb('definition_gaps').insert({
    ...(tenantId != null ? { tenant_id: tenantId } : {}),
    query_log_id: queryLogId,
    gap_description: description,
    hit_count: 1,
    last_hit_at: new Date().toISOString(),
  });
}

// POST /api/query
router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, question, domains, conversationId, dataLayer: requestedLayer } = req.body as {
      connectionId: number; question: string; domains?: string[]; conversationId?: number;
      dataLayer?: 'product' | 'source';
    };

    if (!question?.trim()) {
      res.status(400).json({ ok: false, error: 'question is required' });
      return;
    }

    // Load conversation history for follow-up context (if conversationId provided)
    const conversationHistory = conversationId
      ? await loadConversationHistory(conversationId)
      : undefined;

    // 0. Resolve data layer. Default = product (when one exists). Explicit
    //    'source' is honoured for users who want to query raw source data.
    const productCtx = requestedLayer === 'source'
      ? null
      : await buildProductSemanticContext(connectionId);
    const tenantId = req.user!.tenantId;
    const productWarehouse = productCtx
      ? await semanticDb.transaction(async (trx) => {
          if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
          return getProductWarehousePath(connectionId, trx);
        })
      : null;
    const layer = resolveDataLayer(requestedLayer, !!(productCtx && productWarehouse));

    if (layer === 'product' && productCtx && productWarehouse) {
      // ── PRODUCT LAYER QUERY PATH ──────────────────────────────────────
      const connection = await semanticDb('connections').where({ id: connectionId }).first();
      const dialect: SqlDialect = 'duckdb'; // product layer always uses DuckDB

      // Skip the Claude round-trip if the same question against an
      // unchanged semantic context has already been answered recently.
      // Clarifying follow-ups (conversationHistory present) bypass cache —
      // the history changes the intended SQL even when the tail question is identical.
      const productCacheKey = buildCacheKey({
        tenantId, connectionId, layer: 'product',
        domains,
        question,
        semanticContext:     productCtx.semanticContext,
        relationshipContext: productCtx.relationshipContext,
        kpiFormulas:         productCtx.kpiFormulas,
      });
      const useCache = !conversationHistory || conversationHistory.length === 0;
      const nlStart = Date.now();
      let nlResult: NlToSqlOutput | null = useCache
        ? await getCachedSql(tenantId, productCacheKey)
        : null;
      const cacheHit = !!nlResult;
      if (!nlResult) {
        nlResult = await generateSql(
          question, productCtx.semanticContext, productCtx.relationshipContext, productCtx.kpiFormulas, dialect,
          conversationHistory,
        );
        if (useCache) {
          await putCachedSql(tenantId, productCacheKey, question, nlResult);
        }
      }
      trackMetric('nl_to_sql_ms', Date.now() - nlStart, { layer: 'product', cache: cacheHit ? 'hit' : 'miss' });
      trackEvent(cacheHit ? 'query_cache_hit' : 'query_cache_miss', { layer: 'product' });

      // Meta-question short-circuit: model classified this as a follow-up
      // about methodology, not a data request. Return the explanation and
      // skip SQL execution.
      if (nlResult.intent === 'explain' && nlResult.explanation) {
        await semanticDb('query_log').insert({
          tenant_id:        tenantId,
          user_id:          req.user!.sub,
          question_text:    question,
          generated_sql:    null,
          confidence_score: nlResult.confidence,
          was_flagged:      false,
        });
        res.json({ ok: true, data: {
          answer: nlResult.explanation,
          confidence: nlResult.confidence,
          tablesUsed: nlResult.tables_used ?? [],
          rows: [], sql: '', queryLayer: 'product', intent: 'explain',
          subScores: { schema: nlResult.schema_confidence, join: nlResult.join_confidence, formula: nlResult.formula_confidence },
          uncertaintyNotes: nlResult.uncertainty_notes ?? [],
        }});
        return;
      }

      const blockCheck = shouldBlockQuery(nlResult);
      const [logRow] = await semanticDb('query_log')
        .insert({
          tenant_id:        tenantId,
          user_id:          req.user!.sub,
          question_text:    question,
          generated_sql:    nlResult.sql,
          confidence_score: nlResult.confidence,
          was_flagged:      blockCheck.blocked,
          flag_reason:      blockCheck.blocked ? blockCheck.reason : null,
        })
        .returning('id');
      const queryLogId: number = typeof logRow === 'object' ? (logRow as { id: number }).id : (logRow as number);

      if (blockCheck.blocked) {
        await upsertDefinitionGap(queryLogId, buildGapDescription(question, nlResult), question, tenantId);
        res.json({
          ok: true,
          data: {
            answer: blockedUserMessage(nlResult),
            confidence: nlResult.confidence,
            subScores: { schema: nlResult.schema_confidence, join: nlResult.join_confidence, formula: nlResult.formula_confidence },
            uncertaintyNotes: nlResult.uncertainty_notes,
            flagReason: blockCheck.reason,
            blocked: true, sql: nlResult.sql, tablesUsed: nlResult.tables_used,
            queryLayer: 'product',
            debug: { hint: blockCheck.reason, semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext, kpiFormulas: productCtx.kpiFormulas },
          },
        });
        return;
      }

      // Apply data access policies before execution
      const productPolicyResult = await applyDataPolicies(nlResult.sql, req.user!.sub, req.user!.role, req.user!.tenantId);
      const productExecSql = productPolicyResult.sql;

      // Execute against product layer DuckDB
      const connector = await createProductConnector(productWarehouse, connection.id, req.user!.tenantId);
      await connector.connect();
      let execRows: Record<string, unknown>[];
      const execStart = Date.now();
      try {
        const result = await connector.executeQuery(productExecSql);
        execRows = result.rows;
        trackMetric('duckdb_query_ms', Date.now() - execStart, { layer: 'product' });
      } finally {
        connector.disconnect();
      }

      const [answer, validation] = await Promise.all([
        formatAnswer(question, execRows),
        validateQueryResultIfNeeded(nlResult.confidence, question, productExecSql, execRows),
      ]);

      await semanticDb('query_log').where({ id: queryLogId }).update({ executed: true, result_summary: answer });

      res.json({
        ok: true,
        data: {
          answer, confidence: nlResult.confidence,
          subScores: { schema: nlResult.schema_confidence, join: nlResult.join_confidence, formula: nlResult.formula_confidence },
          uncertaintyNotes: nlResult.uncertainty_notes,
          blocked: false, tablesUsed: nlResult.tables_used,
          queryLayer: 'product',
          ...(productPolicyResult.policiesApplied > 0 ? { policyNotice: 'Results filtered by data access policies' } : {}),
          ...(validation.ok ? {} : { warning: (validation as { ok: boolean; warning?: string }).warning }),
          rows: execRows.slice(0, 200),
          sql: nlResult.sql,
          debug: { hint: `Query executed against product layer (star schema) with confidence ${Math.round(nlResult.confidence * 100)}%.`,
            semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext, kpiFormulas: productCtx.kpiFormulas },
        },
      });
      return;
    }

    // ── SOURCE LAYER QUERY PATH (fallback when no product layer exists) ──

    // 1. Build semantic context — use semantic retrieval when possible.
    //    First extract entities from the question, then fetch only the relevant
    //    2-hop subgraph from Neo4j. Falls back to full context if no entities match.
    const catalog = await getTableAndColumnNames(connectionId, domains);
    const entityMatches = extractEntitiesFromQuestion(question, catalog);

    let contextSource: 'subgraph' | 'kpi_fallback' | 'full';
    let seedTables = entityMatches;

    if (seedTables.length === 0) {
      // Fallback: extract table names referenced in KPI formulas
      const allKpis = (await buildSemanticContextForQuery(connectionId, domains)).kpis as { formula_sql?: string }[];
      const kpiTableRefs = new Set<string>();
      for (const k of allKpis) {
        if (k.formula_sql) {
          for (const entry of catalog) {
            if (k.formula_sql.toLowerCase().includes(entry.tableName.toLowerCase())) {
              kpiTableRefs.add(entry.tableName);
            }
          }
        }
      }
      seedTables = [...kpiTableRefs];
      contextSource = seedTables.length > 0 ? 'kpi_fallback' : 'full';
    } else {
      contextSource = 'subgraph';
    }

    const { tables, columns, kpis, relationships } = contextSource === 'full'
      ? await buildSemanticContextForQuery(connectionId, domains)
      : await buildRelevantSubgraph(connectionId, seedTables, domains);

    // Format semantic context — table + column definitions
    const semanticContext = (tables as { id: number; table_name: string; description: string; grain?: string }[]).map((t) => {
      const cols = (columns as { table_id: number; column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }[])
        .filter((c) => c.table_id === t.id)
        .map((c) =>
          `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`,
        )
        .join('\n');
      const grainNote = t.grain ? ` (grain: ${t.grain})` : '';
      return `Table: ${t.table_name}${grainNote} — ${t.description ?? ''}\n  Columns:\n${cols}`;
    }).join('\n\n');

    // Format relationship context — JOIN guidance
    const relationshipContext = relationships.length
      ? (relationships as { from_table: string; from_column: string | null; to_table: string; to_column: string | null; relationship_type: string; description: string | null }[])
          .map((r) => {
            const from = r.from_column ? `${r.from_table}.${r.from_column}` : r.from_table;
            const to   = r.to_column   ? `${r.to_table}.${r.to_column}`     : r.to_table;
            return `- ${from} → ${to} (${r.relationship_type})${r.description ? `: ${r.description}` : ''}`;
          }).join('\n')
      : 'No relationships defined yet — avoid JOINs unless you are certain of the key columns.';

    const kpiFormulas = kpis.length
      ? (kpis as { name: string; formula_plain_text: string | null; formula_sql: string }[])
          .map((k) => `${k.name}:\n  Business definition: ${k.formula_plain_text ?? k.name}\n  SQL formula: ${k.formula_sql ?? '(not yet defined)'}`)
          .join('\n\n')
      : 'No KPIs defined yet.';

    // 2a-join-paths. Discover multi-hop join paths (2+ hops) via Neo4j shortestPath.
    //   Direct relationships are already in relationshipContext; this adds explicit
    //   chains for 3+ table queries so Claude doesn't have to infer them.
    const tableNames = (tables as { table_name: string }[]).map((t) => t.table_name);
    const joinPaths = await getJoinPaths(connectionId, tableNames);
    let relationshipContextWithPaths = relationshipContext;
    if (joinPaths.length > 0) {
      const pathLines = joinPaths.map((p) => {
        const chain = p.steps
          .map((s) => `${s.from_table}.${s.from_column} → ${s.to_table}.${s.to_column} (${s.relationship_type})`)
          .join(' → ');
        return `  ${p.from} ↔ ${p.to}: ${chain}`;
      });
      relationshipContextWithPaths += `\n\nRecommended JOIN paths (multi-hop):\n${pathLines.join('\n')}`;
    }

    // 2a-quality. Build quality context — fetch latest profile + field stats + failing rules
    //   for every active table in scope.  Appended to semanticContext so Claude can:
    //   • add IS NOT NULL / COALESCE on high-null columns
    //   • use exact categorical values from top_values
    //   • reason about date ranges without guessing
    //   • caveat answers when known quality rules are failing
    type FieldProfile = {
      field_name: string; null_pct: number; distinct_count: number;
      min_value: string | null; max_value: string | null;
      mean_value: number | null; top_values: { value: unknown; pct: number }[] | null;
    };
    type QualityRule = { rule_name: string; rule_type: string; dimension: string; rule_config: Record<string, unknown> | null; last_status: string | null; last_pass_rate: number | null };

    // Latest profile per table (one row per table — highest id = most recent)
    const latestProfiles: { id: number; table_name: string; row_count: number | null; overall_score: number | null }[] = tableNames.length
      ? await semanticDb('dataset_profiles')
          .where({ connection_id: connectionId })
          .whereIn('table_name', tableNames)
          .orderBy('id', 'desc')
          // Keep only the latest per table_name
          .select(semanticDb.raw('DISTINCT ON (table_name) id, table_name, row_count, overall_score'))
          .catch(() => []) // gracefully skip if profiling hasn't run
      : [];

    const profileIds = latestProfiles.map((p) => p.id);

    const fieldProfiles: (FieldProfile & { profile_id: number })[] = profileIds.length
      ? await semanticDb('field_profiles').whereIn('profile_id', profileIds).catch(() => [])
      : [];

    // Active quality rules with their most recent execution result
    const qualityRules: QualityRule[] = tableNames.length
      ? await semanticDb('quality_rules as qr')
          .leftJoin(
            semanticDb('rule_executions').select('rule_id').max('id as latest_exec_id').groupBy('rule_id').as('le'),
            'le.rule_id', 'qr.id',
          )
          .leftJoin('rule_executions as re', 're.id', 'le.latest_exec_id')
          .where({ 'qr.connection_id': connectionId, 'qr.is_active': true })
          .whereIn('qr.table_name', tableNames)
          .select(
            'qr.table_name', 'qr.rule_name', 'qr.rule_type', 'qr.dimension',
            'qr.rule_config', 're.status as last_status', 're.pass_rate as last_pass_rate',
          )
          .catch(() => [])
      : [];

    // Build compact quality hints — one section per table
    const qualityHints = latestProfiles.map((prof) => {
      const fields = fieldProfiles.filter((f) => f.profile_id === prof.id);
      const rules  = qualityRules.filter((r: QualityRule & { table_name: string }) => (r as { table_name: string }).table_name === prof.table_name);

      const fieldLines = fields.map((f) => {
        const parts: string[] = [];

        // Nullability
        if (f.null_pct > 0.01)
          parts.push(`${Math.round(f.null_pct * 100)}% nulls — handle nulls in calculations`);

        // Cardinality hint (categorical vs key vs free-text)
        if (f.distinct_count <= 20 && f.top_values?.length) {
          const vals = f.top_values.slice(0, 8)
            .map((v) => `'${String(v.value)}' (${Math.round(v.pct * 100)}%)`)
            .join(', ');
          parts.push(`categorical — values: ${vals}`);
        } else if (f.distinct_count === 1) {
          parts.push('constant value — avoid filtering on this');
        }

        // Range for dates and numbers
        if (f.min_value !== null && f.max_value !== null && f.distinct_count > 20) {
          parts.push(`range ${f.min_value} to ${f.max_value}`);
          if (f.mean_value !== null)
            parts.push(`mean ${Number(f.mean_value.toFixed(2))}`);
        }

        return parts.length ? `    ${f.field_name}: ${parts.join('; ')}` : null;
      }).filter(Boolean);

      // Failing rules are the most actionable signal
      const failingRules = rules
        .filter((r) => r.last_status === 'FAIL' || r.last_status === 'WARNING')
        .map((r) => {
          const pct = r.last_pass_rate !== null ? ` (${Math.round(r.last_pass_rate * 100)}% passing)` : '';
          return `    ⚠ ${r.rule_name} [${r.dimension}]${pct} — ${r.last_status}: caveat results from this table`;
        });

      const rowInfo  = prof.row_count !== null ? `, ${prof.row_count.toLocaleString()} rows` : '';
      const scoreInfo = prof.overall_score !== null ? `, quality score ${Math.round(prof.overall_score * 100)}%` : '';
      const header = `Quality hints for ${prof.table_name}${rowInfo}${scoreInfo}:`;

      const body = [...fieldLines, ...failingRules];
      return body.length ? `${header}\n${body.join('\n')}` : null;
    }).filter(Boolean).join('\n\n');

    // Append column disambiguation warning
    const colDisambig = buildColumnDisambiguationWarning(
      columns as { table_name?: string; table_id: number; column_name: string; description?: string }[],
      tables as { id: number; table_name: string }[],
    );

    // Append quality hints to semantic context when available
    const semanticContextWithQuality = qualityHints
      ? `${semanticContext}${colDisambig}\n\n--- Data Quality Hints ---\n${qualityHints}`
      : `${semanticContext}${colDisambig}`;

    // 2b. Integration enrichment — automatically include cross-source context
    //     if any integration views involve this connection's tables.
    //     When present, the prompt is upgraded to cross-source mode and SQL
    //     execution uses ATTACH DATABASE automatically.
    type CrossRel = {
      from_table: string; from_conn_id: number; from_column: string | null;
      to_table:   string; to_conn_id:   number; to_column:   string | null;
      relationship_type: string;
    };
    type XTable = {
      table_id: number; table_name: string; display_name: string; description: string;
      connection_id: number; connection_name: string; connection_config: string | Record<string, unknown>;
    };
    type XCol = { table_id: number; column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean };

    // tableIds: pgId values for all active tables returned from Neo4j (used for cross-view lookup)
    const tableIds = (tables as { id: number }[]).map((t) => t.id);

    let crossConnAliasMap: Map<number, { alias: string; filepath: string }> | null = null;
    let enrichedSemanticContext  = semanticContextWithQuality;
    let enrichedRelationshipContext = relationshipContextWithPaths;
    let isCrossSourceQuery = false;

    if (tableIds.length) {
      // Find all cross-view relationships where at least one side belongs to this connection
      const crossRels: CrossRel[] = await semanticDb('cross_view_relationships as r')
        .leftJoin('source_columns as fc', 'r.from_column_id', 'fc.id')
        .leftJoin('source_columns as tc', 'r.to_column_id',   'tc.id')
        .leftJoin('source_tables  as ft', 'r.from_table_id',  'ft.id')
        .leftJoin('source_tables  as tt', 'r.to_table_id',    'tt.id')
        .where(function () {
          this.whereIn('r.from_table_id', tableIds).orWhereIn('r.to_table_id', tableIds);
        })
        .select(
          'ft.table_name as from_table', 'ft.connection_id as from_conn_id', 'fc.column_name as from_column',
          'tt.table_name as to_table',   'tt.connection_id as to_conn_id',   'tc.column_name as to_column',
          'r.relationship_type',
        );

      if (crossRels.length) {
        // Collect all unique table IDs referenced in these relationships
        const allRelTableIds = [...new Set([
          ...crossRels.map((r) => r.from_conn_id),  // we need table ids, not conn ids
        ])];
        void allRelTableIds; // unused — we query by relation table names below

        // Collect all connection IDs referenced (other than the primary connection)
        const relatedConnIds = [...new Set([
          ...crossRels.map((r) => r.from_conn_id),
          ...crossRels.map((r) => r.to_conn_id),
        ])];

        // Load ALL tables from related connections that appear in cross-view relationships
        const relatedTableNames = [...new Set([
          ...crossRels.map((r) => r.from_table),
          ...crossRels.map((r) => r.to_table),
        ])];

        const xTables: XTable[] = await semanticDb('source_tables as st')
          .join('connections as c', 'st.connection_id', 'c.id')
          .whereIn('st.connection_id', relatedConnIds)
          .whereIn('st.table_name',    relatedTableNames)
          .select(
            'st.id as table_id', 'st.table_name', 'st.display_name', 'st.description',
            'st.connection_id', 'c.name as connection_name', 'c.config as connection_config',
          );

        // Build alias map for every involved connection
        crossConnAliasMap = new Map();
        for (const xt of xTables) {
          if (!crossConnAliasMap.has(xt.connection_id)) {
            const cfg = typeof xt.connection_config === 'string'
              ? JSON.parse(xt.connection_config) as { filepath: string }
              : xt.connection_config as { filepath: string };
            crossConnAliasMap.set(xt.connection_id, {
              alias:    sanitizeAlias(xt.connection_name),
              filepath: path.resolve(cfg.filepath),
            });
          }
        }

        // Load columns for all cross-source tables
        const xTableIds = xTables.map((t) => t.table_id);
        const xCols: XCol[] = xTableIds.length
          ? await semanticDb('source_columns').whereIn('table_id', xTableIds)
          : [];

        // Build enriched semantic context — primary tables + cross-source tables, all aliased
        const primaryAlias = crossConnAliasMap.get(connectionId)?.alias ?? sanitizeAlias(
          (await semanticDb('connections').where({ id: connectionId }).first())?.name ?? 'primary',
        );

        // Re-build primary tables with alias prefix
        const primaryContext = tables.map((t: { id: number; table_name: string; description: string }) => {
          const cols = columns
            .filter((c: { table_id: number }) => c.table_id === t.id)
            .map((c: { column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }) =>
              `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`,
            ).join('\n');
          return `Database: ${primaryAlias}\nTable: ${primaryAlias}.${t.table_name} — ${t.description ?? ''}\n  Columns:\n${cols}`;
        }).join('\n\n');

        // Cross-source tables context
        const crossContext = xTables
          .filter((t) => t.connection_id !== connectionId)
          .map((t) => {
            const alias = crossConnAliasMap!.get(t.connection_id)?.alias ?? 'db';
            const cols = xCols
              .filter((c) => c.table_id === t.table_id)
              .map((c) =>
                `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`,
              ).join('\n');
            return `Database: ${alias}\nTable: ${alias}.${t.table_name} — ${t.description ?? ''}\n  Columns:\n${cols}`;
          }).join('\n\n');

        enrichedSemanticContext = [
          primaryContext,
          crossContext,
          qualityHints ? `--- Data Quality Hints ---\n${qualityHints}` : '',
        ].filter(Boolean).join('\n\n');

        // Build enriched relationship context — single-source + cross-source rels
        const singleSourceRels = relationships.length
          ? relationships.map((r: { from_table: string; from_column: string | null; to_table: string; to_column: string | null; relationship_type: string; description: string | null }) => {
              const from = r.from_column ? `${primaryAlias}.${r.from_table}.${r.from_column}` : `${primaryAlias}.${r.from_table}`;
              const to   = r.to_column   ? `${primaryAlias}.${r.to_table}.${r.to_column}`     : `${primaryAlias}.${r.to_table}`;
              return `- ${from} → ${to} (${r.relationship_type})${r.description ? `: ${r.description}` : ''}`;
            }).join('\n')
          : '';

        const crossSourceRels = crossRels.map((r) => {
          const fa   = crossConnAliasMap!.get(r.from_conn_id)?.alias ?? 'db';
          const ta   = crossConnAliasMap!.get(r.to_conn_id)?.alias   ?? 'db';
          const from = r.from_column ? `${fa}.${r.from_table}.${r.from_column}` : `${fa}.${r.from_table}`;
          const to   = r.to_column   ? `${ta}.${r.to_table}.${r.to_column}`     : `${ta}.${r.to_table}`;
          return `- ${from} → ${to} (${r.relationship_type}) [cross-source]`;
        }).join('\n');

        enrichedRelationshipContext = [singleSourceRels, crossSourceRels].filter(Boolean).join('\n')
          || 'No relationships defined yet.';

        isCrossSourceQuery = true;
      }
    }

    // 2. Generate SQL + confidence (Call Type 2a)
    //    Use cross-source SQL generator when integration context is present.
    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    const dialect = getDialect(connection);

    // Check the NL→SQL cache first (source-layer, same-tenant, same context).
    // Cross-source queries and clarifying follow-ups bypass cache — both produce
    // different SQL for the same question text depending on integration state /
    // conversation history.
    const srcCacheKey = buildCacheKey({
      tenantId, connectionId, layer: 'source',
      domains,
      question,
      semanticContext:     enrichedSemanticContext,
      relationshipContext: enrichedRelationshipContext,
      kpiFormulas,
    });
    const useSrcCache =
      !isCrossSourceQuery && (!conversationHistory || conversationHistory.length === 0);
    const nlStart = Date.now();
    let nlResult: NlToSqlOutput | null = useSrcCache
      ? await getCachedSql(tenantId, srcCacheKey)
      : null;
    const srcCacheHit = !!nlResult;

    if (!nlResult) {
      nlResult = isCrossSourceQuery
        ? await generateCrossSourceSql(question, enrichedSemanticContext, enrichedRelationshipContext, kpiFormulas, dialect, conversationHistory)
        : await generateSql(question, enrichedSemanticContext, enrichedRelationshipContext, kpiFormulas, dialect, conversationHistory);
      if (useSrcCache) {
        await putCachedSql(tenantId, srcCacheKey, question, nlResult);
      }
    }
    trackMetric('nl_to_sql_ms', Date.now() - nlStart, {
      layer: 'source',
      cache: srcCacheHit ? 'hit' : 'miss',
      cross: String(isCrossSourceQuery),
    });
    trackEvent(srcCacheHit ? 'query_cache_hit' : 'query_cache_miss', { layer: 'source' });

    // Meta-question short-circuit (source layer).
    if (nlResult.intent === 'explain' && nlResult.explanation) {
      await semanticDb('query_log').insert({
        tenant_id:        tenantId,
        user_id:          req.user!.sub,
        question_text:    question,
        generated_sql:    null,
        confidence_score: nlResult.confidence,
        was_flagged:      false,
      });
      res.json({ ok: true, data: {
        answer: nlResult.explanation,
        confidence: nlResult.confidence,
        tablesUsed: nlResult.tables_used ?? [],
        rows: [], sql: '', queryLayer: 'source', intent: 'explain',
        subScores: { schema: nlResult.schema_confidence, join: nlResult.join_confidence, formula: nlResult.formula_confidence },
        uncertaintyNotes: nlResult.uncertainty_notes ?? [],
      }});
      return;
    }

    // 3. Log the query regardless of outcome
    const blockCheck = shouldBlockQuery(nlResult);
    const [logRow] = await semanticDb('query_log')
      .insert({
        tenant_id:        tenantId,
        user_id:          req.user!.sub,
        question_text:    question,
        generated_sql:    nlResult.sql,
        confidence_score: nlResult.confidence,
        was_flagged:      blockCheck.blocked,
        flag_reason:      blockCheck.blocked ? blockCheck.reason : null,
      })
      .returning('id');
    const queryLogId: number = typeof logRow === 'object' ? (logRow as { id: number }).id : (logRow as number);

    // 4. Block low-confidence queries (overall < 0.7 OR any sub-score < 0.5)
    if (blockCheck.blocked) {
      await upsertDefinitionGap(queryLogId, buildGapDescription(question, nlResult), question, tenantId);
      // Notify admins about the new gap
      if (req.user?.tenantId) {
        notifyAdmins(req.user.tenantId, 'new_gap', 'New definition gap', {
          message: `Question blocked (confidence ${(nlResult.confidence * 100).toFixed(0)}%): "${question.slice(0, 80)}"`,
          link: '/gaps',
        }).catch(() => {});
      }

      res.json({
        ok: true,
        data: {
          answer: blockedUserMessage(nlResult),
          confidence: nlResult.confidence,
          subScores: {
            schema: nlResult.schema_confidence,
            join: nlResult.join_confidence,
            formula: nlResult.formula_confidence,
          },
          uncertaintyNotes: nlResult.uncertainty_notes,
          flagReason: blockCheck.reason,
          blocked: true,
          sql:        nlResult.sql,
          tablesUsed: nlResult.tables_used,
          queryLayer: 'source',
          debug: {
            confirmedTables:        tables.length,
            confirmedColumns:       columns.length,
            confirmedRelationships: relationships.length,
            confirmedKpis:          kpis.length,
            hint: tables.length === 0
              ? 'No table definitions found at all. Run the schema profiler first (Setup page).'
              : relationships.length === 0
                ? 'No relationships found. Re-suggest on the Definitions → Relationships tab.'
                : `Context has ${tables.length} tables and ${relationships.length} relationships — ${blockCheck.reason}. Try improving descriptions or rephrasing.`,
            semanticContext,
            relationshipContext,
            kpiFormulas,
          },
        },
      });
      return;
    }

    // 5. Entity pre-flight check — look for string literals in the generated SQL
    //    that don't match anything in the source data for dimension columns.
    //    If we find a mismatch we return a clarification prompt before executing.
    const config = typeof connection.config === 'string'
      ? JSON.parse(connection.config)
      : connection.config;

    const entityCheckConnector = await createConnector(connection);
    await entityCheckConnector.connect();

    // Extract every single-quoted string literal from the SQL
    const literalMatches = [...nlResult.sql.matchAll(/'([^']+)'/g)];
    const stringLiterals = [...new Set(literalMatches.map((m) => m[1]))];

    // Dimension columns (text/varchar) in the tables Claude used — fetched from Neo4j
    const allDimCols = await getDimensionColumns(connectionId);
    const textTypes = new Set(['TEXT', 'VARCHAR', 'text', 'varchar', 'NVARCHAR', 'nvarchar', 'CHAR', 'char']);
    const dimColumns = allDimCols.filter((c) =>
      nlResult.tables_used.includes(c.table_name) && textTypes.has(c.data_type),
    );

    type Mismatch   = { literal: string; alternatives: string[] };
    type Ambiguity  = { literal: string; tableName: string; columnName: string; rows: Record<string, unknown>[] };
    const mismatches:  Mismatch[]  = [];
    const ambiguities: Ambiguity[] = [];

    for (const literal of stringLiterals) {
      // Skip very short or purely numeric strings (IDs, dates, etc.)
      if (literal.length < 3 || /^\d+$/.test(literal)) continue;

      let found       = false;
      let ambiguous   = false;
      let alternatives: string[] = [];

      for (const col of dimColumns as { table_name: string; column_name: string }[]) {
        try {
          // How many rows match this literal exactly?
          const exact = await entityCheckConnector.executeQuery(
            `SELECT COUNT(*) as cnt FROM "${col.table_name}" WHERE "${col.column_name}" = '${literal.replace(/'/g, "''")}'`,
          );
          const count = Number((exact.rows[0] as { cnt: unknown })?.cnt ?? 0);

          if (count === 1) {
            // Exactly one match — unambiguous, proceed normally
            found = true;
            break;
          }

          // 2–15 rows: treat as a duplicate entity name — ask user to pick one.
          // More than 15 almost certainly means this is a category/status value
          // (e.g. status = 'active'), not a specific entity name — proceed normally.
          if (count > 1 && count <= 15) {
            const rowsResult = await entityCheckConnector.executeQuery(
              `SELECT * FROM "${col.table_name}" WHERE "${col.column_name}" = '${literal.replace(/'/g, "''")}' LIMIT 15`,
            );
            ambiguities.push({
              literal,
              tableName:  col.table_name,
              columnName: col.column_name,
              rows:       rowsResult.rows,
            });
            ambiguous = true;
            break;
          }

          if (count > 15) {
            // Category value — too many matches to be a specific entity; treat as found
            found = true;
            break;
          }

          // count === 0 — no exact match; try fuzzy using every meaningful word
          // in the literal (skip short tokens like NV, SA, BV, de, &, etc.)
          const words = literal.split(/\s+/).filter((w) => w.length >= 4);
          for (const word of words) {
            const fuzzy = await entityCheckConnector.executeQuery(
              `SELECT DISTINCT "${col.column_name}" FROM "${col.table_name}" WHERE "${col.column_name}" LIKE '%${word.replace(/'/g, "''")}%' LIMIT 5`,
            );
            const hits = fuzzy.rows.map((r) => String((r as Record<string, unknown>)[col.column_name]));
            alternatives = [...alternatives, ...hits];
            if (hits.length > 0) break; // found something — no need to try more words
          }
        } catch {
          // ignore per-column errors — best effort
        }
      }

      if (!found && !ambiguous && alternatives.length > 0) {
        mismatches.push({ literal, alternatives: [...new Set(alternatives)].slice(0, 5) });
      }
    }

    entityCheckConnector.disconnect();

    // Return clarification if we found ambiguous names OR unrecognised literals
    if (ambiguities.length > 0 || mismatches.length > 0) {
      const hint = ambiguities.length > 0
        ? `Entity pre-flight found ${ambiguities.length} ambiguous name(s): ${ambiguities.map((a) => a.literal).join(', ')}`
        : `Entity pre-flight flagged unrecognised literal(s): ${mismatches.map((m) => m.literal).join(', ')}`;

      res.json({
        ok: true,
        data: {
          needsClarification: true,
          ambiguities,
          mismatches,
          answer: ambiguities.length > 0
            ? `"${ambiguities[0].literal}" matches multiple records. Please pick which one you mean.`
            : `I couldn't find ${mismatches.map((m) => `"${m.literal}"`).join(' or ')} in your data.`,
          confidence: nlResult.confidence,
          blocked: true,
          sql: nlResult.sql,
          tablesUsed: nlResult.tables_used,
          queryLayer: 'source',
          debug: {
            confirmedTables:        tables.length,
            confirmedColumns:       columns.length,
            confirmedRelationships: relationships.length,
            confirmedKpis:          kpis.length,
            hint,
            semanticContext,
            relationshipContext,
            kpiFormulas,
          },
        },
      });
      return;
    }

    // 6. Execute SQL — cross-source via ATTACH DATABASE, or single-source normally
    let execRows: Record<string, unknown>[];

    if (isCrossSourceQuery && crossConnAliasMap && crossConnAliasMap.size > 0) {
      // Open in-memory DB, ATTACH every source involved
      const inMemDb = new Database(':memory:');
      try {
        for (const [, { alias, filepath }] of crossConnAliasMap) {
          inMemDb.exec(`ATTACH DATABASE '${filepath.replace(/'/g, "''")}' AS "${alias}"`);
        }
        execRows = inMemDb.prepare(nlResult.sql).all() as Record<string, unknown>[];
      } finally {
        inMemDb.close();
      }
    } else {
      const queryConnector = await createConnector(connection);
      await queryConnector.connect();
      const queryResult = await queryConnector.executeQuery(nlResult.sql);
      queryConnector.disconnect();
      execRows = queryResult.rows;
    }

    // 7. Run result sanity check (Call Type 2c) — parallel with answer formatting
    // Non-blocking: a failed validation adds a warning but never hides the answer
    const [answer, validation] = await Promise.all([
      formatAnswer(question, execRows),
      validateQueryResultIfNeeded(nlResult.confidence, question, nlResult.sql, execRows),
    ]);

    // 8. Update query log as executed
    await semanticDb('query_log').where({ id: queryLogId }).update({
      executed:       true,
      result_summary: answer,
    });

    res.json({
      ok: true,
      data: {
        answer,
        confidence:  nlResult.confidence,
        subScores: {
          schema: nlResult.schema_confidence,
          join: nlResult.join_confidence,
          formula: nlResult.formula_confidence,
        },
        uncertaintyNotes: nlResult.uncertainty_notes,
        blocked:     false,
        crossSource: isCrossSourceQuery,
        tablesUsed:  nlResult.tables_used,
        queryLayer:  'source',
        // Sanity-check warning — shown to all users when validation flags a concern
        ...(validation.ok ? {} : { warning: validation.warning }),
        // Raw rows — used by the frontend to render a table / chart
        rows: execRows.slice(0, 200),
        // Debug info — always sent; the frontend only renders it for admin role
        sql: nlResult.sql,
        debug: {
          confirmedTables:        tables.length,
          confirmedColumns:       columns.length,
          confirmedRelationships: relationships.length,
          confirmedKpis:          kpis.length,
          hint: `Query executed successfully with confidence ${Math.round(nlResult.confidence * 100)}%.${isCrossSourceQuery ? ' (cross-source via integration view)' : ''}`,
          semanticContext:      enrichedSemanticContext,
          relationshipContext:  enrichedRelationshipContext,
          kpiFormulas,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/query/think — same as POST / but streams Claude's thinking live
// Extended thinking tokens are forwarded as SSE events so the browser can
// render them in real time. Final result arrives as a single 'done' event.
// ---------------------------------------------------------------------------

router.post('/think', requireAuth, async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (data: object) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ }
  };

  try {
    const { connectionId, question, domains, conversationId, dataLayer: requestedLayer, productId } = req.body as {
      connectionId: number; question: string; domains?: string[]; conversationId?: number;
      dataLayer?: 'product' | 'source';
      productId?: number;
    };

    if (!question?.trim()) {
      emit({ type: 'error', message: 'question is required' });
      res.end(); return;
    }

    // Load conversation history for follow-up context (if conversationId provided)
    const conversationHistory = conversationId
      ? await loadConversationHistory(conversationId)
      : undefined;

    // ── 0. Resolve data layer (default = product when available) ───────────
    emit({ type: 'phase', text: 'Loading context…' });
    const thinkProductCtx = requestedLayer === 'source'
      ? null
      : await buildProductSemanticContext(connectionId, productId ? [productId] : undefined);
    const thinkTenantId = req.user!.tenantId;
    const thinkProductWarehouse = thinkProductCtx
      ? await semanticDb.transaction(async (trx) => {
          if (thinkTenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(thinkTenantId)}'`);
          return getProductWarehousePath(connectionId, trx);
        })
      : null;
    const thinkLayer = resolveDataLayer(requestedLayer, !!(thinkProductCtx && thinkProductWarehouse));

    if (thinkLayer === 'product' && thinkProductCtx && thinkProductWarehouse) {
      // ── PRODUCT LAYER STREAMING PATH ──────────────────────────────────
      const connection = await semanticDb('connections').where({ id: connectionId }).first();
      const dialect: SqlDialect = 'duckdb';

      emit({ type: 'phase', text: 'Reasoning about your question (star schema)…' });
      const nlResult = await generateSqlStreaming(
        question, thinkProductCtx.semanticContext, thinkProductCtx.relationshipContext, thinkProductCtx.kpiFormulas,
        (type, delta) => emit({ type, text: delta }),
        dialect,
        conversationHistory,
      );

      // Meta-question short-circuit (product layer). Skip SQL execution.
      if (nlResult.intent === 'explain' && nlResult.explanation) {
        await semanticDb('query_log').insert({
          tenant_id:        thinkTenantId,
          user_id:          req.user!.sub,
          question_text:    question,
          generated_sql:    null,
          confidence_score: nlResult.confidence,
          was_flagged:      false,
          flag_reason:      null,
        });
        emit({ type: 'done', data: {
          answer: nlResult.explanation,
          confidence: nlResult.confidence,
          subScores: { schema: nlResult.schema_confidence, join: nlResult.join_confidence, formula: nlResult.formula_confidence },
          uncertaintyNotes: nlResult.uncertainty_notes,
          blocked: false,
          tablesUsed: nlResult.tables_used,
          queryLayer: 'product',
          rows: [],
          sql: '',
          intent: 'explain',
        }});
        res.end();
        return;
      }

      emit({ type: 'sql_ready', sql: nlResult.sql, confidence: nlResult.confidence, tablesUsed: nlResult.tables_used });

      const thinkBlockCheck = shouldBlockQuery(nlResult);
      const [logRow] = await semanticDb('query_log').insert({
        tenant_id: thinkTenantId,
        user_id: req.user!.sub, question_text: question, generated_sql: nlResult.sql,
        confidence_score: nlResult.confidence, was_flagged: thinkBlockCheck.blocked,
        flag_reason: thinkBlockCheck.blocked ? thinkBlockCheck.reason : null,
      }).returning('id');
      const queryLogId: number = typeof logRow === 'object' ? (logRow as { id: number }).id : (logRow as number);

      if (thinkBlockCheck.blocked) {
        await upsertDefinitionGap(queryLogId, buildGapDescription(question, nlResult), question, thinkTenantId);
        emit({ type: 'done', data: {
          answer: blockedUserMessage(nlResult), confidence: nlResult.confidence,
          subScores: { schema: nlResult.schema_confidence, join: nlResult.join_confidence, formula: nlResult.formula_confidence },
          uncertaintyNotes: nlResult.uncertainty_notes,
          flagReason: thinkBlockCheck.reason,
          blocked: true, sql: nlResult.sql, tablesUsed: nlResult.tables_used, queryLayer: 'product',
        }});
        res.end(); return;
      }

      emit({ type: 'phase', text: 'Running query on star schema…' });
      const connector = await createProductConnector(thinkProductWarehouse, connection.id, req.user!.tenantId);
      await connector.connect();
      let queryRows: Record<string, unknown>[];
      try {
        const result = await connector.executeQuery(nlResult.sql);
        queryRows = result.rows;
      } finally {
        connector.disconnect();
      }

      emit({ type: 'phase', text: 'Formatting answer…' });
      const [answer, validation] = await Promise.all([
        formatAnswer(question, queryRows),
        validateQueryResultIfNeeded(nlResult.confidence, question, nlResult.sql, queryRows),
      ]);
      await semanticDb('query_log').where({ id: queryLogId }).update({ executed: true, result_summary: answer });

      emit({ type: 'done', data: {
        answer, confidence: nlResult.confidence,
        subScores: { schema: nlResult.schema_confidence, join: nlResult.join_confidence, formula: nlResult.formula_confidence },
        blocked: false, tablesUsed: nlResult.tables_used, queryLayer: 'product',
        ...(validation.ok ? {} : { warning: (validation as { ok: boolean; warning?: string }).warning }),
        rows: queryRows.slice(0, 200), sql: nlResult.sql,
        ...(nlResult.visualization ? { visualization: nlResult.visualization } : {}),
        debug: { hint: `Query executed against product layer with confidence ${Math.round(nlResult.confidence * 100)}%.` },
      }});
      res.end(); return;
    }

    // ── SOURCE LAYER STREAMING PATH (fallback) ──────────────────────────

    // ── 1. Semantic context — semantic retrieval with fallback ──────────────
    const thinkCatalog = await getTableAndColumnNames(connectionId, domains);
    const thinkEntityMatches = extractEntitiesFromQuestion(question, thinkCatalog);

    let thinkSeeds = thinkEntityMatches;
    if (thinkSeeds.length === 0) {
      const allKpis = (await buildSemanticContextForQuery(connectionId, domains)).kpis as { formula_sql?: string }[];
      const kpiRefs = new Set<string>();
      for (const k of allKpis) {
        if (k.formula_sql) {
          for (const entry of thinkCatalog) {
            if (k.formula_sql.toLowerCase().includes(entry.tableName.toLowerCase())) kpiRefs.add(entry.tableName);
          }
        }
      }
      thinkSeeds = [...kpiRefs];
    }

    const { tables, columns, kpis, relationships } = thinkSeeds.length > 0
      ? await buildRelevantSubgraph(connectionId, thinkSeeds, domains)
      : await buildSemanticContextForQuery(connectionId, domains);

    const semanticContext = (tables as { id: number; table_name: string; description: string; grain?: string }[]).map((t) => {
      const cols = (columns as { table_id: number; column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }[])
        .filter((c) => c.table_id === t.id)
        .map((c) =>
          `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`,
        ).join('\n');
      const grainNote = t.grain ? ` (grain: ${t.grain})` : '';
      return `Table: ${t.table_name}${grainNote} — ${t.description ?? ''}\n  Columns:\n${cols}`;
    }).join('\n\n');

    const relationshipContext = relationships.length
      ? (relationships as { from_table: string; from_column: string | null; to_table: string; to_column: string | null; relationship_type: string; description: string | null }[])
          .map((r) => {
            const from = r.from_column ? `${r.from_table}.${r.from_column}` : r.from_table;
            const to   = r.to_column   ? `${r.to_table}.${r.to_column}`     : r.to_table;
            return `- ${from} → ${to} (${r.relationship_type})${r.description ? `: ${r.description}` : ''}`;
          }).join('\n')
      : 'No relationships defined yet.';

    const kpiFormulas = kpis.length
      ? (kpis as { name: string; formula_plain_text: string | null; formula_sql: string }[])
          .map((k) => `${k.name}:\n  Business definition: ${k.formula_plain_text ?? k.name}\n  SQL formula: ${k.formula_sql ?? '(not yet defined)'}`)
          .join('\n\n')
      : 'No KPIs defined yet.';

    // ── 2a. Multi-hop join paths ─────────────────────────────────────────────
    const tableNames = (tables as { table_name: string }[]).map((t) => t.table_name);
    const thinkJoinPaths = await getJoinPaths(connectionId, tableNames);
    let thinkRelCtx = relationshipContext;
    if (thinkJoinPaths.length > 0) {
      const pathLines = thinkJoinPaths.map((p) => {
        const chain = p.steps
          .map((s) => `${s.from_table}.${s.from_column} → ${s.to_table}.${s.to_column} (${s.relationship_type})`)
          .join(' → ');
        return `  ${p.from} ↔ ${p.to}: ${chain}`;
      });
      thinkRelCtx += `\n\nRecommended JOIN paths (multi-hop):\n${pathLines.join('\n')}`;
    }

    // ── 2b. Quality hints ────────────────────────────────────────────────────
    const latestProfiles: { id: number; table_name: string; row_count: number | null; overall_score: number | null }[] = tableNames.length
      ? await semanticDb('dataset_profiles')
          .where({ connection_id: connectionId })
          .whereIn('table_name', tableNames)
          .orderBy('id', 'desc')
          .select(semanticDb.raw('DISTINCT ON (table_name) id, table_name, row_count, overall_score'))
          .catch(() => [])
      : [];
    const profileIds = latestProfiles.map((p) => p.id);
    const fieldProfiles: ({ profile_id: number; field_name: string; null_pct: number; distinct_count: number; min_value: string | null; max_value: string | null; mean_value: number | null; top_values: { value: unknown; pct: number }[] | null })[] = profileIds.length
      ? await semanticDb('field_profiles').whereIn('profile_id', profileIds).catch(() => [])
      : [];

    const qualityHints = latestProfiles.map((prof) => {
      const fields = fieldProfiles.filter((f) => f.profile_id === prof.id);
      const fieldLines = fields.map((f) => {
        const parts: string[] = [];
        if (f.null_pct > 0.01) parts.push(`${Math.round(f.null_pct * 100)}% nulls`);
        if (f.distinct_count <= 20 && f.top_values?.length) {
          const vals = f.top_values.slice(0, 8).map((v) => `'${String(v.value)}'`).join(', ');
          parts.push(`values: ${vals}`);
        } else if (f.min_value !== null && f.max_value !== null && f.distinct_count > 20) {
          parts.push(`range ${f.min_value} to ${f.max_value}`);
        }
        return parts.length ? `    ${f.field_name}: ${parts.join('; ')}` : null;
      }).filter(Boolean);
      return fieldLines.length
        ? `Quality for ${prof.table_name}:\n${fieldLines.join('\n')}`
        : null;
    }).filter(Boolean).join('\n\n');

    const thinkColDisambig = buildColumnDisambiguationWarning(
      columns as { table_name?: string; table_id: number; column_name: string; description?: string }[],
      tables as { id: number; table_name: string }[],
    );
    const fullContext = qualityHints
      ? `${semanticContext}${thinkColDisambig}\n\n--- Data Quality Hints ---\n${qualityHints}`
      : `${semanticContext}${thinkColDisambig}`;

    // ── 3. Stream SQL generation with extended thinking ─────────────────────
    emit({ type: 'phase', text: 'Reasoning about your question…' });

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    const dialect = getDialect(connection);

    const nlResult = await generateSqlStreaming(
      question, fullContext, thinkRelCtx, kpiFormulas,
      (type, delta) => emit({ type, text: delta }),
      dialect,
      conversationHistory,
    );

    // ── Meta-question short-circuit ────────────────────────────────────────
    // When the model classifies the question as "explain" (asking about the
    // methodology of a previous answer), we skip SQL execution entirely and
    // emit the plain-language explanation as the final answer. This requires
    // conversation history to be loaded — which we already do above.
    if (nlResult.intent === 'explain' && nlResult.explanation) {
      await semanticDb('query_log').insert({
        tenant_id:        thinkTenantId,
        user_id:          (req as Request & { user?: { sub: string } }).user!.sub,
        question_text:    question,
        generated_sql:    null,
        confidence_score: nlResult.confidence,
        was_flagged:      false,
        flag_reason:      null,
      });
      emit({ type: 'done', data: {
        answer: nlResult.explanation,
        confidence: nlResult.confidence,
        subScores: { schema: nlResult.schema_confidence, join: nlResult.join_confidence, formula: nlResult.formula_confidence },
        uncertaintyNotes: nlResult.uncertainty_notes,
        blocked: false,
        tablesUsed: nlResult.tables_used,
        queryLayer: 'source',
        rows: [],
        sql: '',
        intent: 'explain',
      }});
      res.end();
      return;
    }

    emit({ type: 'sql_ready', sql: nlResult.sql, confidence: nlResult.confidence, tablesUsed: nlResult.tables_used });

    // ── 4. Log ──────────────────────────────────────────────────────────────
    const thinkBlockCheck = shouldBlockQuery(nlResult);
    const [logRow] = await semanticDb('query_log').insert({
      tenant_id:        thinkTenantId,
      user_id:          (req as Request & { user?: { sub: string } }).user!.sub,
      question_text:    question,
      generated_sql:    nlResult.sql,
      confidence_score: nlResult.confidence,
      was_flagged:      thinkBlockCheck.blocked,
      flag_reason:      thinkBlockCheck.blocked ? thinkBlockCheck.reason : null,
    }).returning('id');
    const queryLogId: number = typeof logRow === 'object' ? (logRow as { id: number }).id : (logRow as number);

    // ── 5. Block low-confidence (overall < 0.7 OR any sub-score < 0.5) ────
    if (thinkBlockCheck.blocked) {
      await upsertDefinitionGap(queryLogId, buildGapDescription(question, nlResult), question, thinkTenantId);
      emit({ type: 'done', data: {
        answer: blockedUserMessage(nlResult),
        confidence: nlResult.confidence,
        subScores: { schema: nlResult.schema_confidence, join: nlResult.join_confidence, formula: nlResult.formula_confidence },
        uncertaintyNotes: nlResult.uncertainty_notes,
        flagReason: thinkBlockCheck.reason,
        blocked: true, sql: nlResult.sql, tablesUsed: nlResult.tables_used, queryLayer: 'source',
        debug: { confirmedTables: tables.length, confirmedColumns: columns.length, confirmedRelationships: relationships.length, confirmedKpis: kpis.length, hint: thinkBlockCheck.reason, semanticContext, relationshipContext, kpiFormulas },
      }});
      res.end(); return;
    }

    // ── 6. Entity pre-flight check ──────────────────────────────────────────
    const cfg = typeof connection.config === 'string' ? JSON.parse(connection.config) : connection.config;
    const entityCheckConnector = await createConnector(connection);
    await entityCheckConnector.connect();

    const literalMatches = [...nlResult.sql.matchAll(/'([^']+)'/g)];
    const stringLiterals = [...new Set(literalMatches.map((m) => m[1]))];
    const allDimCols = await getDimensionColumns(connectionId);
    const textTypes = new Set(['TEXT', 'VARCHAR', 'text', 'varchar', 'NVARCHAR', 'nvarchar', 'CHAR', 'char']);
    const dimColumns = allDimCols.filter((c) =>
      nlResult.tables_used.includes(c.table_name) && textTypes.has(c.data_type),
    );

    type Mismatch  = { literal: string; alternatives: string[] };
    type Ambiguity = { literal: string; tableName: string; columnName: string; rows: Record<string, unknown>[] };
    const mismatches:  Mismatch[]  = [];
    const ambiguities: Ambiguity[] = [];

    for (const literal of stringLiterals) {
      if (literal.length < 3 || /^\d+$/.test(literal)) continue;
      let found = false, ambiguous = false;
      let alternatives: string[] = [];
      for (const col of dimColumns as { table_name: string; column_name: string }[]) {
        try {
          const exact = await entityCheckConnector.executeQuery(
            `SELECT COUNT(*) as cnt FROM "${col.table_name}" WHERE "${col.column_name}" = '${literal.replace(/'/g, "''")}'`,
          );
          const count = Number((exact.rows[0] as { cnt: unknown })?.cnt ?? 0);
          if (count === 1) { found = true; break; }
          if (count > 1 && count <= 15) {
            const rowsResult = await entityCheckConnector.executeQuery(
              `SELECT * FROM "${col.table_name}" WHERE "${col.column_name}" = '${literal.replace(/'/g, "''")}' LIMIT 15`,
            );
            ambiguities.push({ literal, tableName: col.table_name, columnName: col.column_name, rows: rowsResult.rows });
            ambiguous = true; break;
          }
          if (count > 15) { found = true; break; }
          const words = literal.split(/\s+/).filter((w) => w.length >= 4);
          for (const word of words) {
            const fuzzy = await entityCheckConnector.executeQuery(
              `SELECT DISTINCT "${col.column_name}" FROM "${col.table_name}" WHERE "${col.column_name}" LIKE '%${word.replace(/'/g, "''")}%' LIMIT 5`,
            );
            const hits = fuzzy.rows.map((r) => String((r as Record<string, unknown>)[col.column_name]));
            alternatives = [...alternatives, ...hits];
            if (hits.length > 0) break;
          }
        } catch { /* ignore per-column errors */ }
      }
      if (!found && !ambiguous && alternatives.length > 0) {
        mismatches.push({ literal, alternatives: [...new Set(alternatives)].slice(0, 5) });
      }
    }
    entityCheckConnector.disconnect();

    if (ambiguities.length > 0 || mismatches.length > 0) {
      const hint = ambiguities.length > 0
        ? `Entity pre-flight: ${ambiguities.length} ambiguous name(s): ${ambiguities.map((a) => a.literal).join(', ')}`
        : `Entity pre-flight: unrecognised literal(s): ${mismatches.map((m) => m.literal).join(', ')}`;
      emit({ type: 'done', data: {
        needsClarification: true, ambiguities, mismatches,
        answer: ambiguities.length > 0
          ? `"${ambiguities[0].literal}" matches multiple records. Please pick which one you mean.`
          : `I couldn't find ${mismatches.map((m) => `"${m.literal}"`).join(' or ')} in your data.`,
        confidence: nlResult.confidence, blocked: true, sql: nlResult.sql, tablesUsed: nlResult.tables_used, queryLayer: 'source',
        debug: { confirmedTables: tables.length, confirmedColumns: columns.length, confirmedRelationships: relationships.length, confirmedKpis: kpis.length, hint, semanticContext, relationshipContext, kpiFormulas },
      }});
      res.end(); return;
    }

    // ── 7. Execute SQL ──────────────────────────────────────────────────────
    emit({ type: 'phase', text: 'Running your query…' });
    const queryConnector = await createConnector(connection);
    await queryConnector.connect();
    const queryResult = await queryConnector.executeQuery(nlResult.sql);
    queryConnector.disconnect();

    // ── 8. Format answer ────────────────────────────────────────────────────
    emit({ type: 'phase', text: 'Formatting answer…' });
    const [answer, validation] = await Promise.all([
      formatAnswer(question, queryResult.rows),
      validateQueryResultIfNeeded(nlResult.confidence, question, nlResult.sql, queryResult.rows),
    ]);

    await semanticDb('query_log').where({ id: queryLogId }).update({ executed: true, result_summary: answer });

    emit({ type: 'done', data: {
      answer, confidence: nlResult.confidence,
      subScores: { schema: nlResult.schema_confidence, join: nlResult.join_confidence, formula: nlResult.formula_confidence },
      uncertaintyNotes: nlResult.uncertainty_notes,
      blocked: false, tablesUsed: nlResult.tables_used, queryLayer: 'source',
      ...(validation.ok ? {} : { warning: (validation as { ok: boolean; warning?: string }).warning }),
      rows: queryResult.rows.slice(0, 200),
      sql: nlResult.sql,
      ...(nlResult.visualization ? { visualization: nlResult.visualization } : {}),
      debug: { confirmedTables: tables.length, confirmedColumns: columns.length, confirmedRelationships: relationships.length, confirmedKpis: kpis.length,
        hint: `Query executed successfully with confidence ${Math.round(nlResult.confidence * 100)}%.`,
        semanticContext, relationshipContext, kpiFormulas },
    }});
    res.end();

  } catch (err) {
    console.error('[/think] Error:', err);
    // Show the real error to admin/analyst — viewers still get the generic
    // message because raw errors can leak SQL / file paths / internals.
    const role = req.user?.role;
    const canSeeDetails = role === 'admin' || role === 'analyst';
    const detail = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    emit({
      type: 'error',
      message: 'Something went wrong. Please try again.',
      ...(canSeeDetails ? { errorDetail: detail, errorStack: stack } : {}),
    });
    res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/query/repair — agentic repair loop, streams SSE events
// ---------------------------------------------------------------------------

router.post('/repair', requireAuth, async (req: Request, res: Response) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function send(type: string, data: Record<string, unknown> = {}) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    (res as unknown as { flush?: () => void }).flush?.();
  }

  let sqliteConnector: import('../connectors/BaseConnector').BaseConnector | null = null;

  try {
    const {
      connectionId, question, originalSql, originalRows, warning,
      conversationHistory, clarificationAnswer,
      dataLayer: requestedLayer,
    } = req.body as {
      connectionId: number;
      question: string;
      originalSql: string;
      originalRows: Record<string, unknown>[];
      warning: string;
      conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
      clarificationAnswer?: string;
      dataLayer?: 'product' | 'source';
    };

    // ── Resolve data layer: stay on the same layer the original query used.
    //    Earlier behaviour was to always rebuild source context + use a source
    //    connector here, which silently dropped the user out of the product
    //    layer mid-investigation and produced inconsistent answers across
    //    follow-up turns.
    const repairProductCtx = requestedLayer === 'source'
      ? null
      : await buildProductSemanticContext(connectionId);
    const repairTenantId = req.user!.tenantId;
    const repairProductWarehouse = repairProductCtx
      ? await semanticDb.transaction(async (trx) => {
          if (repairTenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(repairTenantId)}'`);
          return getProductWarehousePath(connectionId, trx);
        })
      : null;
    const repairLayer = resolveDataLayer(requestedLayer, !!(repairProductCtx && repairProductWarehouse));

    let semanticContext: string;
    let relationshipContext: string;

    if (repairLayer === 'product' && repairProductCtx) {
      semanticContext     = repairProductCtx.semanticContext;
      relationshipContext = repairProductCtx.relationshipContext;
    } else {
      // ── Source-layer context (legacy path) ──
      const tables = await semanticDb('source_tables')
        .where({ connection_id: connectionId, is_active: true });

      const columns = await semanticDb('source_columns')
        .join('source_tables', 'source_columns.table_id', 'source_tables.id')
        .where('source_tables.connection_id', connectionId)
        .where('source_tables.is_active', true)
        .select('source_columns.*', 'source_tables.table_name');

      const tableIds = tables.map((t: { id: number }) => t.id);
      const relationships = tableIds.length
        ? await semanticDb('table_relationships')
            .leftJoin('source_columns as fc', 'table_relationships.from_column_id', 'fc.id')
            .leftJoin('source_columns as tc', 'table_relationships.to_column_id', 'tc.id')
            .leftJoin('source_tables  as ft', 'table_relationships.from_table_id', 'ft.id')
            .leftJoin('source_tables  as tt', 'table_relationships.to_table_id', 'tt.id')
            .whereIn('table_relationships.from_table_id', tableIds)
            .select(
              'ft.table_name as from_table', 'fc.column_name as from_column',
              'tt.table_name as to_table',   'tc.column_name as to_column',
              'table_relationships.relationship_type', 'table_relationships.description',
            )
        : [];

      semanticContext = tables
        .map((t: { id: number; table_name: string; description: string }) => {
          const cols = columns
            .filter((c: { table_id: number }) => c.table_id === t.id)
            .map((c: { column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }) =>
              `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`,
            )
            .join('\n');
          return `Table: ${t.table_name} — ${t.description ?? ''}\n  Columns:\n${cols}`;
        })
        .join('\n\n');

      relationshipContext = relationships.length
        ? relationships
            .map((r: { from_table: string; from_column: string | null; to_table: string; to_column: string | null; relationship_type: string; description: string | null }) => {
              const from = r.from_column ? `${r.from_table}.${r.from_column}` : r.from_table;
              const to   = r.to_column   ? `${r.to_table}.${r.to_column}`     : r.to_table;
              return `- ${from} → ${to} (${r.relationship_type})${r.description ? `: ${r.description}` : ''}`;
            })
            .join('\n')
        : 'No relationships defined.';
    }

    // ── Connection + connector for diagnostics — match the layer ──
    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    sqliteConnector = repairLayer === 'product' && repairProductWarehouse
      ? await createProductConnector(repairProductWarehouse, connection.id, repairTenantId)
      : await createConnector(connection);
    await sqliteConnector.connect();

    // ── Build initial conversation ──
    let messages: Array<{ role: 'user' | 'assistant'; content: string }> =
      conversationHistory ??
      [{
        role: 'user',
        content: buildRepairContext(question, originalSql, originalRows, warning, semanticContext, relationshipContext),
      }];

    if (clarificationAnswer && conversationHistory) {
      messages = [...messages, { role: 'user', content: buildRepairClarificationAnswer(clarificationAnswer) }];
      send('thinking', { text: `Got it — "${clarificationAnswer}". Resuming investigation…` });
    } else {
      send('thinking', { text: `Validator flagged: "${warning}". Starting investigation…` });
    }

    // ── Repair loop (max 5 turns) ──
    const MAX_TURNS = 5;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let raw: string;
      try {
        const repairDialect: SqlDialect = repairLayer === 'product'
          ? 'duckdb'
          : (connection?.query_engine === 'duckdb' ? 'duckdb' : 'sqlite');
        raw = await callClaudeMultiTurn(getRepairSystem(repairDialect), messages);
      } catch (err: unknown) {
        send('error', { text: 'Claude API call failed. Please try again.' });
        break;
      }
      messages = [...messages, { role: 'assistant', content: raw }];

      // Extract the first {...} block from Claude's response.
      // Claude sometimes wraps the JSON in prose ("Based on my findings: {...}")
      // so we search for the outermost JSON object rather than parsing the whole string.
      let action: RepairAction;
      try {
        // 1. Strip markdown fences
        let candidate = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        // 2. If the result isn't a bare object, pull out the first {...} block
        if (!candidate.startsWith('{')) {
          const match = candidate.match(/\{[\s\S]*\}/);
          if (!match) throw new Error('no JSON object found');
          candidate = match[0];
        }
        action = JSON.parse(candidate) as RepairAction;
      } catch {
        send('error', { text: 'Could not parse repair response. Stopping.' });
        break;
      }

      if (action.type === 'data_query') {
        send('thinking', { text: action.reasoning });
        send('data_query', { sql: action.sql });

        try {
          const result = await sqliteConnector!.executeQuery(action.sql);
          send('query_result', { rows: result.rows.slice(0, 20), rowCount: result.rows.length });
          messages = [
            ...messages,
            { role: 'user', content: buildRepairQueryResult(result.rows, result.rows.length) },
          ];
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          send('thinking', { text: `Diagnostic query failed: ${msg}. Trying a different approach.` });
          messages = [
            ...messages,
            { role: 'user', content: `That query failed: ${msg}. Please try a different diagnostic or proceed with what you know.` },
          ];
        }

      } else if (action.type === 'clarification') {
        send('clarification', { question: action.question, conversationHistory: messages });
        break; // pause — frontend will resume with the user's answer

      } else if (action.type === 'revised_sql') {
        send('thinking', { text: action.reasoning });
        send('revised_sql', { sql: action.sql });

        let result: { rows: Record<string, unknown>[] };
        try {
          result = await sqliteConnector!.executeQuery(action.sql);
        } catch (execErr: unknown) {
          const msg = execErr instanceof Error ? execErr.message : String(execErr);
          send('thinking', { text: `⚠ Revised query failed to execute: ${msg}. Adding this to the context and retrying…` });
          messages = [
            ...messages,
            { role: 'user', content: `That revised SQL failed with error: "${msg}". Please fix the SQL and try again.` },
          ];
          continue; // go to next iteration so Claude can correct itself
        }

        const [answer, validation] = await Promise.all([
          formatAnswer(question, result.rows),
          validateQueryResultIfNeeded(action.confidence, question, action.sql, result.rows),
        ]);

        send('revised_answer', {
          answer,
          sql:        action.sql,
          rows:       result.rows.slice(0, 200),
          confidence: action.confidence,
          warning:    validation.ok ? null : validation.warning,
        });
        break;

      } else {
        send('error', { text: 'Unexpected response from repair agent.' });
        break;
      }
    }

    res.end();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Repair]', err);
    send('error', { text: `Investigation failed: ${msg}` });
    res.end();
  } finally {
    sqliteConnector?.disconnect();
  }
});

// ---------------------------------------------------------------------------
// POST /api/query/cross-view — query across multiple SQLite sources via ATTACH
// ---------------------------------------------------------------------------

router.post('/cross-view', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  let inMemDb: Database.Database | null = null;
  try {
    const { viewId, question, conversationId } = req.body as { viewId: number; question: string; conversationId?: number };

    if (!question?.trim()) {
      res.status(400).json({ ok: false, error: 'question is required' });
      return;
    }

    // Load conversation history for follow-up context (if conversationId provided)
    const conversationHistory = conversationId
      ? await loadConversationHistory(conversationId)
      : undefined;

    // 1. Load view tables with connection info
    const viewTables = await semanticDb('cross_view_tables as vt')
      .join('source_tables as st', 'vt.table_id', 'st.id')
      .join('connections as c', 'st.connection_id', 'c.id')
      .where('vt.view_id', viewId)
      .select(
        'st.id as table_id',
        'st.table_name',
        'st.display_name',
        'st.description',
        'st.connection_id',
        'c.name as connection_name',
        'c.config as connection_config',
      );

    if (!viewTables.length) {
      res.status(400).json({ ok: false, error: 'This integration view has no tables. Add tables to the canvas first.' });
      return;
    }

    // 2. Build connection → alias map (one alias per connection)
    const connAliasMap = new Map<number, { alias: string; filepath: string }>();
    for (const vt of viewTables as { connection_id: number; connection_name: string; connection_config: string | Record<string, unknown> }[]) {
      if (!connAliasMap.has(vt.connection_id)) {
        const cfg = typeof vt.connection_config === 'string'
          ? JSON.parse(vt.connection_config) as { filepath: string }
          : vt.connection_config as { filepath: string };
        connAliasMap.set(vt.connection_id, {
          alias:    sanitizeAlias(vt.connection_name),
          filepath: path.resolve(cfg.filepath),
        });
      }
    }

    // 3. Load columns for all tables in the view
    const tableIds = (viewTables as { table_id: number }[]).map((t) => t.table_id);
    const columns = await semanticDb('source_columns').whereIn('table_id', tableIds).orderBy('id');

    // 4. Load cross-view relationships with resolved names
    const rawRels = await semanticDb('cross_view_relationships as r')
      .leftJoin('source_columns as fc', 'r.from_column_id', 'fc.id')
      .leftJoin('source_columns as tc', 'r.to_column_id',   'tc.id')
      .leftJoin('source_tables  as ft', 'r.from_table_id',  'ft.id')
      .leftJoin('source_tables  as tt', 'r.to_table_id',    'tt.id')
      .where('r.view_id', viewId)
      .select(
        'ft.table_name as from_table',
        'ft.connection_id as from_conn_id',
        'fc.column_name as from_column',
        'tt.table_name as to_table',
        'tt.connection_id as to_conn_id',
        'tc.column_name as to_column',
        'r.relationship_type',
      );

    // 5. Build semantic context  —  each table prefixed with its schema alias
    type VT = { table_id: number; table_name: string; display_name: string; description: string; connection_id: number; connection_name: string };
    type Col = { table_id: number; column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean };

    const semanticContext = (viewTables as VT[]).map((t) => {
      const alias = connAliasMap.get(t.connection_id)?.alias ?? 'db';
      const cols  = (columns as Col[])
        .filter((c) => c.table_id === t.table_id)
        .map((c) =>
          `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`,
        )
        .join('\n');
      return `Database: ${alias}\nTable: ${alias}.${t.table_name} — ${t.description ?? ''}\n  Columns:\n${cols}`;
    }).join('\n\n');

    // 6. Build relationship context with fully-qualified names
    type Rel = { from_table: string; from_conn_id: number; from_column: string | null; to_table: string; to_conn_id: number; to_column: string | null; relationship_type: string };
    const relationshipContext = (rawRels as Rel[]).length
      ? (rawRels as Rel[]).map((r) => {
          const fa = connAliasMap.get(r.from_conn_id)?.alias ?? 'db';
          const ta = connAliasMap.get(r.to_conn_id)?.alias   ?? 'db';
          const from = r.from_column ? `${fa}.${r.from_table}.${r.from_column}` : `${fa}.${r.from_table}`;
          const to   = r.to_column   ? `${ta}.${r.to_table}.${r.to_column}`     : `${ta}.${r.to_table}`;
          return `- ${from} → ${to} (${r.relationship_type})`;
        }).join('\n')
      : 'No cross-source relationships defined yet — avoid cross-schema JOINs unless you are certain of the key columns.';

    // 7. Generate SQL via Claude (cross-source variant)
    const nlResult = await generateCrossSourceSql(question, semanticContext, relationshipContext, 'No KPIs defined yet.', 'sqlite', conversationHistory);

    // 8. Log the query
    const [logRow] = await semanticDb('query_log')
      .insert({
        tenant_id:        req.user!.tenantId,
        user_id:          req.user!.sub,
        question_text:    question,
        generated_sql:    nlResult.sql,
        confidence_score: nlResult.confidence,
        was_flagged:      nlResult.confidence < 0.7,
        flag_reason:      nlResult.confidence < 0.7 ? 'Low confidence (cross-source)' : null,
      })
      .returning('id');
    const queryLogId: number = typeof logRow === 'object' ? (logRow as { id: number }).id : (logRow as number);

    // 9. Block low-confidence queries
    if (nlResult.confidence < 0.7) {
      await upsertDefinitionGap(queryLogId, `Cross-source low confidence (${nlResult.confidence}) for: "${question}"`, question, req.user!.tenantId);
      res.json({
        ok: true,
        data: {
          answer:    "I don't have enough context to answer that confidently across these data sources. This question has been noted for review.",
          confidence: nlResult.confidence,
          blocked:    true,
          sql:        nlResult.sql,
          tablesUsed: nlResult.tables_used,
          crossSource: true,
          debug: { confirmedTables: tableIds.length, confirmedColumns: (columns as Col[]).length, confirmedRelationships: (rawRels as Rel[]).length, confirmedKpis: 0, hint: 'Cross-source query blocked due to low confidence. Check your integration view — ensure relationships are defined between the tables you are asking about.', semanticContext, relationshipContext },
        },
      });
      return;
    }

    // 10. Execute SQL: open in-memory DB, ATTACH all sources, run query
    inMemDb = new Database(':memory:');
    for (const [, { alias, filepath }] of connAliasMap) {
      inMemDb.exec(`ATTACH DATABASE '${filepath.replace(/'/g, "''")}' AS "${alias}"`);
    }
    const rows = inMemDb.prepare(nlResult.sql).all() as Record<string, unknown>[];
    inMemDb.close();
    inMemDb = null;

    // 11. Format answer + validate
    const [answer, validation] = await Promise.all([
      formatAnswer(question, rows),
      validateQueryResultIfNeeded(nlResult.confidence, question, nlResult.sql, rows),
    ]);

    await semanticDb('query_log').where({ id: queryLogId }).update({ executed: true, result_summary: answer });

    res.json({
      ok: true,
      data: {
        answer,
        confidence:  nlResult.confidence,
        blocked:     false,
        crossSource: true,
        tablesUsed:  nlResult.tables_used,
        rows:        rows.slice(0, 200),
        sql:         nlResult.sql,
        ...(nlResult.visualization ? { visualization: nlResult.visualization } : {}),
        ...(validation.ok ? {} : { warning: validation.warning }),
        debug: {
          confirmedTables:        tableIds.length,
          confirmedColumns:       (columns as Col[]).length,
          confirmedRelationships: (rawRels as Rel[]).length,
          confirmedKpis:          0,
          hint: `Cross-source query executed with confidence ${Math.round(nlResult.confidence * 100)}%.`,
          semanticContext,
          relationshipContext,
        },
      },
    });
  } catch (err) {
    inMemDb?.close();
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/query/forecast — AI-driven forecasting pipeline
// Detects forecast intent, fetches historical data, computes statistical
// forecast, and returns both historical + predicted data for visualization.
// ---------------------------------------------------------------------------

router.post('/forecast', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, question, domains } = req.body as {
      connectionId: number; question: string; domains?: string[];
    };

    if (!question?.trim()) {
      res.status(400).json({ ok: false, error: 'question is required' });
      return;
    }

    // 1. Build semantic context (same as the main query path)
    const productCtx = await buildProductSemanticContext(connectionId);
    const tenantId = req.user!.tenantId;
    const productWarehouse = productCtx
      ? await semanticDb.transaction(async (trx) => {
          if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
          return getProductWarehousePath(connectionId, trx);
        })
      : null;

    let semanticContext: string;
    let relationshipContext: string;
    let kpiFormulas: string;
    let dialect: SqlDialect;

    if (productCtx && productWarehouse) {
      semanticContext = productCtx.semanticContext;
      relationshipContext = productCtx.relationshipContext;
      kpiFormulas = productCtx.kpiFormulas;
      dialect = 'duckdb';
    } else {
      // Source layer context
      const catalog = await getTableAndColumnNames(connectionId, domains);
      const entityMatches = extractEntitiesFromQuestion(question, catalog);
      const seeds = entityMatches.length > 0 ? entityMatches : [];

      const ctx = seeds.length > 0
        ? await buildRelevantSubgraph(connectionId, seeds, domains)
        : await buildSemanticContextForQuery(connectionId, domains);

      semanticContext = (ctx.tables as { id: number; table_name: string; description: string; grain?: string }[]).map((t) => {
        const cols = (ctx.columns as { table_id: number; column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }[])
          .filter((c) => c.table_id === t.id)
          .map((c) =>
            `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`,
          ).join('\n');
        const grainNote = t.grain ? ` (grain: ${t.grain})` : '';
        return `Table: ${t.table_name}${grainNote} — ${t.description ?? ''}\n  Columns:\n${cols}`;
      }).join('\n\n');

      relationshipContext = ctx.relationships.length
        ? (ctx.relationships as { from_table: string; from_column: string | null; to_table: string; to_column: string | null; relationship_type: string; description: string | null }[])
            .map((r) => {
              const from = r.from_column ? `${r.from_table}.${r.from_column}` : r.from_table;
              const to   = r.to_column   ? `${r.to_table}.${r.to_column}`     : r.to_table;
              return `- ${from} → ${to} (${r.relationship_type})${r.description ? `: ${r.description}` : ''}`;
            }).join('\n')
        : 'No relationships defined yet.';

      kpiFormulas = ctx.kpis.length
        ? (ctx.kpis as { name: string; formula_plain_text: string | null; formula_sql: string }[])
            .map((k) => `${k.name}: ${k.formula_sql ?? '(not defined)'}`)
            .join('\n')
        : 'No KPIs defined yet.';

      const connection = await semanticDb('connections').where({ id: connectionId }).first();
      dialect = getDialect(connection);
    }

    // 2. Ask Claude to generate the historical SQL + forecast parameters
    const fcResult = await forecastQuery(question, semanticContext, relationshipContext, kpiFormulas, dialect);

    if (fcResult.confidence < 0.5) {
      res.json({
        ok: true,
        data: {
          answer: "I'm not confident enough to generate a forecast for this question. Try being more specific about what metric you'd like to predict and over what time period.",
          blocked: true,
          confidence: fcResult.confidence,
        },
      });
      return;
    }

    // 3. Execute the historical SQL to get time-series data
    let histRows: Record<string, unknown>[];

    if (productCtx && productWarehouse) {
      const connection = await semanticDb('connections').where({ id: connectionId }).first();
      const connector = await createProductConnector(productWarehouse, connection.id, req.user!.tenantId);
      await connector.connect();
      try {
        const result = await connector.executeQuery(fcResult.historicalSql);
        histRows = result.rows;
      } finally {
        connector.disconnect();
      }
    } else {
      const connection = await semanticDb('connections').where({ id: connectionId }).first();
      const connector = await createConnector(connection);
      await connector.connect();
      try {
        const result = await connector.executeQuery(fcResult.historicalSql);
        histRows = result.rows;
      } finally {
        connector.disconnect();
      }
    }

    // 4. Transform rows into time-series format
    const timeSeries: TimeSeriesPoint[] = histRows.map((row) => ({
      date: String(row[fcResult.dateColumn] ?? ''),
      value: Number(row[fcResult.valueColumn] ?? 0),
    })).filter((p) => p.date && !isNaN(p.value));

    if (timeSeries.length < 2) {
      res.json({
        ok: true,
        data: {
          answer: 'Not enough historical data points to generate a meaningful forecast. I need at least 2 data points in the time series.',
          blocked: true,
          confidence: fcResult.confidence,
          rows: histRows.slice(0, 50),
          sql: fcResult.historicalSql,
        },
      });
      return;
    }

    // 5. Compute the statistical forecast
    const forecastResult = computeForecast(timeSeries, fcResult.forecastPeriods, fcResult.periodUnit);

    // 6. Log the query
    await semanticDb('query_log').insert({
      tenant_id:        req.user!.tenantId,
      user_id:          req.user!.sub,
      question_text:    question,
      generated_sql:    fcResult.historicalSql,
      confidence_score: fcResult.confidence,
      was_flagged:      false,
      executed:         true,
      result_summary:   fcResult.explanation,
    });

    // 7. Return combined response
    res.json({
      ok: true,
      data: {
        answer: fcResult.explanation,
        confidence: fcResult.confidence,
        blocked: false,
        tablesUsed: fcResult.tables_used,
        sql: fcResult.historicalSql,
        rows: histRows.slice(0, 200),
        forecast: {
          historical: forecastResult.historical,
          predicted: forecastResult.forecast,
          method: forecastResult.method === 'linear_regression' ? 'Linear Regression' : 'Moving Average',
          r2: forecastResult.r2,
          periods: fcResult.forecastPeriods,
          periodUnit: fcResult.periodUnit,
          explanation: fcResult.explanation,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
