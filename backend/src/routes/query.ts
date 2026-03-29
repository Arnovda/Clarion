import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { SqliteConnector } from '../connectors/SqliteConnector';
import { generateSql, formatAnswer, validateQueryResult, callClaudeMultiTurn } from '../ai/AIService';
import {
  REPAIR_SYSTEM,
  buildRepairContext,
  buildRepairQueryResult,
  buildRepairClarificationAnswer,
  RepairAction,
} from '../ai/prompts/repairPrompt';

const router = Router();

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

    // 2. Generate SQL + confidence (Call Type 2a)
    const nlResult = await generateSql(question, semanticContext, relationshipContext, kpiFormulas);

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

    // 6. Execute SQL against SQLite source
    const sqliteConnector = new SqliteConnector(config.filepath);
    await sqliteConnector.connect();
    const queryResult = await sqliteConnector.executeQuery(nlResult.sql);
    sqliteConnector.disconnect();

    // 7. Run result sanity check (Call Type 2c) — parallel with answer formatting
    // Non-blocking: a failed validation adds a warning but never hides the answer
    const [answer, validation] = await Promise.all([
      formatAnswer(question, queryResult.rows),
      validateQueryResult(question, nlResult.sql, queryResult.rows),
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
        tablesUsed:  nlResult.tables_used,
        // Sanity-check warning — shown to all users when validation flags a concern
        ...(validation.ok ? {} : { warning: validation.warning }),
        // Raw rows — used by the frontend to render a table / chart
        rows: queryResult.rows.slice(0, 200),
        // Debug info — always sent; the frontend only renders it for admin role
        sql: nlResult.sql,
        debug: {
          confirmedTables:        tables.length,
          confirmedColumns:       columns.length,
          confirmedRelationships: relationships.length,
          confirmedKpis:          kpis.length,
          hint: `Query executed successfully with confidence ${Math.round(nlResult.confidence * 100)}%.`,
          semanticContext,
          relationshipContext,
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

export default router;
