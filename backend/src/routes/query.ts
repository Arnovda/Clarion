import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import Database from 'better-sqlite3';
import { requireAuth } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { SqliteConnector } from '../connectors/SqliteConnector';
import { generateSql, generateCrossSourceSql, formatAnswer, validateQueryResult, callClaudeMultiTurn } from '../ai/AIService';
import {
  REPAIR_SYSTEM,
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

// POST /api/query
router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, question } = req.body as { connectionId: number; question: string };

    if (!question?.trim()) {
      res.status(400).json({ ok: false, error: 'question is required' });
      return;
    }

    // 1. Build semantic context — include both confirmed and AI-draft definitions
    //    so queries work even before the admin has reviewed every row
    const tables = await semanticDb('source_tables')
      .where({ connection_id: connectionId, is_active: true });

    const columns = await semanticDb('source_columns')
      .join('source_tables', 'source_columns.table_id', 'source_tables.id')
      .where('source_tables.connection_id', connectionId)
      .where('source_tables.is_active', true)
      .select('source_columns.*', 'source_tables.table_name');

    const kpis = await semanticDb('kpi_definitions')
      .where({ connection_id: connectionId });

    // Fetch all relationships (confirmed + draft) with resolved table + column names
    const tableIds = tables.map((t: { id: number }) => t.id);
    const relationships = tableIds.length
      ? await semanticDb('table_relationships')
          .leftJoin('source_columns as fc', 'table_relationships.from_column_id', 'fc.id')
          .leftJoin('source_columns as tc', 'table_relationships.to_column_id',   'tc.id')
          .leftJoin('source_tables  as ft', 'table_relationships.from_table_id',  'ft.id')
          .leftJoin('source_tables  as tt', 'table_relationships.to_table_id',    'tt.id')
          .whereIn('table_relationships.from_table_id', tableIds)
          .select(
            'ft.table_name as from_table',
            'fc.column_name as from_column',
            'tt.table_name as to_table',
            'tc.column_name as to_column',
            'table_relationships.relationship_type',
            'table_relationships.description',
          )
      : [];

    // Format semantic context — table + column definitions
    const semanticContext = tables.map((t: { id: number; table_name: string; description: string }) => {
      const cols = columns
        .filter((c: { table_id: number }) => c.table_id === t.id)
        .map((c: { column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }) =>
          `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`,
        )
        .join('\n');
      return `Table: ${t.table_name} — ${t.description ?? ''}\n  Columns:\n${cols}`;
    }).join('\n\n');

    // Format relationship context — JOIN guidance
    const relationshipContext = relationships.length
      ? relationships.map((r: {
          from_table: string; from_column: string | null;
          to_table: string;   to_column: string | null;
          relationship_type: string; description: string | null;
        }) => {
          const from = r.from_column ? `${r.from_table}.${r.from_column}` : r.from_table;
          const to   = r.to_column   ? `${r.to_table}.${r.to_column}`     : r.to_table;
          return `- ${from} → ${to} (${r.relationship_type})${r.description ? `: ${r.description}` : ''}`;
        }).join('\n')
      : 'No relationships defined yet — avoid JOINs unless you are certain of the key columns.';

    const kpiFormulas = kpis.length
      ? kpis.map((k: { name: string; formula_sql: string }) => `${k.name}: ${k.formula_sql}`).join('\n')
      : 'No KPIs defined yet.';

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

    const tableNames = tables.map((t: { table_name: string }) => t.table_name);

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

    // Append quality hints to semantic context when available
    const semanticContextWithQuality = qualityHints
      ? `${semanticContext}\n\n--- Data Quality Hints ---\n${qualityHints}`
      : semanticContext;

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

    let crossConnAliasMap: Map<number, { alias: string; filepath: string }> | null = null;
    let enrichedSemanticContext  = semanticContextWithQuality;
    let enrichedRelationshipContext = relationshipContext;
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
    const nlResult = isCrossSourceQuery
      ? await generateCrossSourceSql(question, enrichedSemanticContext, enrichedRelationshipContext)
      : await generateSql(question, enrichedSemanticContext, enrichedRelationshipContext, kpiFormulas);

    // 3. Log the query regardless of outcome
    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    const [logRow] = await semanticDb('query_log')
      .insert({
        user_id:          req.user!.sub,
        question_text:    question,
        generated_sql:    nlResult.sql,
        confidence_score: nlResult.confidence,
        was_flagged:      nlResult.confidence < 0.7,
        flag_reason:      nlResult.confidence < 0.7 ? 'Low confidence score' : null,
      })
      .returning('id');
    const queryLogId: number = typeof logRow === 'object' ? (logRow as { id: number }).id : (logRow as number);

    // 4. Block low-confidence queries
    if (nlResult.confidence < 0.7) {
      await semanticDb('definition_gaps').insert({
        query_log_id:    queryLogId,
        gap_description: `Low confidence (${nlResult.confidence}) for question: "${question}"`,
      });

      res.json({
        ok: true,
        data: {
          answer: "I don't have enough context to answer that confidently yet. This question has been noted for review.",
          confidence: nlResult.confidence,
          blocked: true,
          sql:        nlResult.sql,
          tablesUsed: nlResult.tables_used,
          debug: {
            confirmedTables:        tables.length,
            confirmedColumns:       columns.length,
            confirmedRelationships: relationships.length,
            confirmedKpis:          kpis.length,
            hint: tables.length === 0
              ? 'No table definitions found at all. Run the schema profiler first (Setup page).'
              : relationships.length === 0
                ? 'No relationships found. Re-suggest on the Definitions → Relationships tab.'
                : `Context has ${tables.length} tables and ${relationships.length} relationships — Claude returned low confidence. Try improving descriptions or rephrasing.`,
            semanticContext,
            relationshipContext,
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

    const entityCheckConnector = new SqliteConnector(config.filepath);
    await entityCheckConnector.connect();

    // Extract every single-quoted string literal from the SQL
    const literalMatches = [...nlResult.sql.matchAll(/'([^']+)'/g)];
    const stringLiterals = [...new Set(literalMatches.map((m) => m[1]))];

    // Dimension columns (text/varchar) in the tables Claude used
    const dimColumns = await semanticDb('source_columns')
      .join('source_tables', 'source_columns.table_id', 'source_tables.id')
      .whereIn('source_tables.table_name', nlResult.tables_used)
      .where('source_columns.is_dimension', true)
      .whereIn('source_columns.data_type', ['TEXT', 'VARCHAR', 'text', 'varchar', 'NVARCHAR', 'nvarchar', 'CHAR', 'char'])
      .select('source_tables.table_name', 'source_columns.column_name');

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
          debug: {
            confirmedTables:        tables.length,
            confirmedColumns:       columns.length,
            confirmedRelationships: relationships.length,
            confirmedKpis:          kpis.length,
            hint,
            semanticContext,
            relationshipContext,
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
      const sqliteConnector = new SqliteConnector(config.filepath);
      await sqliteConnector.connect();
      const queryResult = await sqliteConnector.executeQuery(nlResult.sql);
      sqliteConnector.disconnect();
      execRows = queryResult.rows;
    }

    // 7. Run result sanity check (Call Type 2c) — parallel with answer formatting
    // Non-blocking: a failed validation adds a warning but never hides the answer
    const [answer, validation] = await Promise.all([
      formatAnswer(question, execRows),
      validateQueryResult(question, nlResult.sql, execRows),
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
        blocked:     false,
        crossSource: isCrossSourceQuery,
        tablesUsed:  nlResult.tables_used,
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
        },
      },
    });
  } catch (err) {
    next(err);
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

  let sqliteConnector: SqliteConnector | null = null;

  try {
    const {
      connectionId, question, originalSql, originalRows, warning,
      conversationHistory, clarificationAnswer,
    } = req.body as {
      connectionId: number;
      question: string;
      originalSql: string;
      originalRows: Record<string, unknown>[];
      warning: string;
      conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
      clarificationAnswer?: string;
    };

    // ── Rebuild semantic context ──
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

    const semanticContext = tables
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

    const relationshipContext = relationships.length
      ? relationships
          .map((r: { from_table: string; from_column: string | null; to_table: string; to_column: string | null; relationship_type: string; description: string | null }) => {
            const from = r.from_column ? `${r.from_table}.${r.from_column}` : r.from_table;
            const to   = r.to_column   ? `${r.to_table}.${r.to_column}`     : r.to_table;
            return `- ${from} → ${to} (${r.relationship_type})${r.description ? `: ${r.description}` : ''}`;
          })
          .join('\n')
      : 'No relationships defined.';

    // ── SQLite connection ──
    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    const cfg = typeof connection.config === 'string' ? JSON.parse(connection.config) : connection.config;
    sqliteConnector = new SqliteConnector(cfg.filepath);
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
        raw = await callClaudeMultiTurn(REPAIR_SYSTEM, messages);
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
          validateQueryResult(question, action.sql, result.rows),
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
    const { viewId, question } = req.body as { viewId: number; question: string };

    if (!question?.trim()) {
      res.status(400).json({ ok: false, error: 'question is required' });
      return;
    }

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
    const nlResult = await generateCrossSourceSql(question, semanticContext, relationshipContext);

    // 8. Log the query
    const [logRow] = await semanticDb('query_log')
      .insert({
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
      await semanticDb('definition_gaps').insert({
        query_log_id:    queryLogId,
        gap_description: `Cross-source low confidence (${nlResult.confidence}) for: "${question}"`,
      });
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
      validateQueryResult(question, nlResult.sql, rows),
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

export default router;
