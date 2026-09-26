/**
 * Asking the DATA a question: one read-only SELECT on a source's subjects.
 *
 * It goes through the dashboards' own read path (POST /dashboards/execute):
 * the SQL guard refuses anything but a read of this workspace's tables, and
 * the person's data policies (row filters, column masks) apply. Rows reach the
 * model, so the tool is withheld from a tenant that keeps rows off Claude.
 * It is how the coworker checks that a change gives the right number — a
 * claim it can show instead of assert.
 */
import { internalCall } from './internalApi';
import { type CoworkerTool, ToolError, posInt, text } from './toolKit';

const MAX_ROWS = 50;

const runQuery: CoworkerTool = {
  kind: 'read',
  sendsRows: true,
  definition: {
    name: 'run_query',
    description: 'Run ONE read-only SELECT (DuckDB SQL) on a source\'s subject tables (and "Your tables", as grid_...) and see up to 50 rows. Use it to answer a number question or to check that a change gives the right result. Name subject tables by their technical names (from open_subject / open_table). The person\'s data policies apply.',
    input_schema: {
      type: 'object',
      properties: {
        connection_id: { type: 'integer', description: 'The source whose subjects the query reads (describe_workspace).' },
        sql: { type: 'string' },
      },
      required: ['connection_id', 'sql'],
      additionalProperties: false,
    },
  },
  label: () => 'Running a query on your data',
  resultLimit: 8000,
  async run(ctx, input) {
    const connectionId = posInt(input, 'connection_id');
    const sql = text(input, 'sql', 6000).replace(/;+\s*$/, '');
    const r = await internalCall(ctx.caller, 'POST', '/dashboards/execute', {
      connectionId, sql: `SELECT * FROM (${sql}) AS _q LIMIT ${MAX_ROWS + 1}`,
    });
    if (!r.ok) {
      throw new ToolError(r.status === 404 ? 'That source is not in this workspace.' : `The query did not run: ${r.detail ?? r.error}`);
    }
    const rows = (r.data?.rows ?? []) as Array<Record<string, unknown>>;
    const shown = rows.slice(0, MAX_ROWS);
    return {
      detail: `${shown.length}${rows.length > MAX_ROWS ? '+' : ''} row(s)`,
      result: { columns: shown[0] ? Object.keys(shown[0]) : [], rows: shown, more_rows: rows.length > MAX_ROWS || undefined },
    };
  },
};

export const QUERY_TOOLS: CoworkerTool[] = [runQuery];
