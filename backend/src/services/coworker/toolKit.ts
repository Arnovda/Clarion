/**
 * The coworker's tool kit — the types every tool shares and the small helpers
 * they are built from (argument checks, the loopback reads, name → id
 * resolution, impact). The tools themselves live in tools.ts and its
 * siblings; this file holds nothing a tool DOES.
 */
import type { Knex } from 'knex';
import type { CoworkerFocus, CoworkerImpact, CoworkerProposal } from '../../shared/contract';
import type { CoworkerToolDefinition } from '../../ai/AIService';
import { internalCall, type InternalCaller } from './internalApi';

export interface ToolContext {
  caller: InternalCaller;
  tenantId: number;
  /** The request's tenant-scoped handle (routes each query through tenantQuery after the SSE flush). */
  db: Knex | Knex.Transaction;
  /**
   * The tenant lets customer ROWS reach Claude (AI routing 'claude'). A tool
   * marked `sendsRows` is withheld otherwise; a tool that only SOMETIMES
   * carries rows (a grid's structure vs its contents) reads this instead.
   */
  rowsAllowed: boolean;
}

export interface ToolOutcome {
  /** What the MODEL reads back — compact, never the whole payload. */
  result: unknown;
  /** One line for the person, under the step. */
  detail?: string;
  /** Where the screen should go so the person sees what the coworker sees. */
  focus?: CoworkerFocus;
  proposal?: CoworkerProposal;
}

export interface CoworkerTool {
  definition: CoworkerToolDefinition;
  kind: 'read' | 'propose';
  /**
   * The tool hands CUSTOMER ROWS to the model (not just names and counts).
   * Such a tool is withheld from a tenant whose AI routing keeps row data off
   * Claude ('hybrid' / 'azure') — the coworker's loop runs on Claude, and the
   * tenant's privacy choice outranks a convenience.
   */
  sendsRows?: boolean;
  /** Characters of `result` the model reads back (default: the agent's 6 000). */
  resultLimit?: number;
  /** The step's label, in the product's words — the person reads this live. */
  label: (input: Record<string, unknown>) => string;
  run: (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolOutcome>;
}

/** A refusal the model can act on (it reads the message). Not a crash. */
export class ToolError extends Error {}

// ─── small helpers ──────────────────────────────────────────────────────────

export const clip = (s: unknown, max: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function posInt(input: Record<string, unknown>, key: string): number {
  const n = Number(input[key]);
  if (!Number.isInteger(n) || n <= 0) throw new ToolError(`"${key}" must be a positive whole number.`);
  return n;
}

export function text(input: Record<string, unknown>, key: string, max: number, required = true): string {
  const v = typeof input[key] === 'string' ? (input[key] as string).trim() : '';
  if (required && !v) throw new ToolError(`"${key}" is required.`);
  if (v.length > max) throw new ToolError(`"${key}" is too long (max ${max} characters).`);
  return v;
}

/**
 * What the model reads when an id does not resolve. It says what to do next,
 * because a bare "not found" is what led the model to give up and tell the
 * person it was "having trouble opening it" — the id it tried was a guess.
 */
export const NOT_FOUND = 'Not found in this workspace. Take ids only from describe_workspace, search_catalog or the bracket line — never guess one. You can also pass the name instead of the id.';

export async function get(ctx: ToolContext, path: string) {
  const r = await internalCall(ctx.caller, 'GET', path);
  if (!r.ok) throw new ToolError(r.status === 404 ? NOT_FOUND : r.error ?? 'The lookup failed.');
  return r.data;
}

export async function post(ctx: ToolContext, path: string, body: unknown) {
  const r = await internalCall(ctx.caller, 'POST', path, body);
  if (!r.ok) throw new ToolError(r.status === 404 ? NOT_FOUND : r.error ?? 'The check failed.');
  return r.data;
}

export function optPosInt(input: Record<string, unknown>, key: string): number | null {
  if (input[key] === undefined || input[key] === null || input[key] === '') return null;
  return posInt(input, key);
}

export const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/**
 * Resolve a subject by NAME (the person says "the Cash Flow subject", not an
 * id). Exact name first, then a single partial match; more than one partial
 * match is a refusal listing them, so the model asks instead of picking.
 * Explicit tenant filter — an authorisation input never rides the session.
 */
export async function subjectIdByName(ctx: ToolContext, name: string): Promise<number> {
  const rows = (await ctx.db('data_products').where({ tenant_id: ctx.tenantId }).select('id', 'name')) as Array<{ id: number; name: string }>;
  const want = norm(name);
  const exact = rows.filter((r) => norm(r.name) === want);
  if (exact.length === 1) return Number(exact[0].id);
  const partial = (exact.length ? exact : rows.filter((r) => norm(r.name).includes(want) || want.includes(norm(r.name))));
  if (partial.length === 1) return Number(partial[0].id);
  if (!partial.length) throw new ToolError(`There is no subject called "${name}". Subjects here: ${rows.map((r) => `${r.name} (product_id ${r.id})`).join(', ') || 'none'}.`);
  throw new ToolError(`More than one subject matches "${name}": ${partial.map((r) => `${r.name} (product_id ${r.id})`).join(', ')}. Pick one.`);
}

/**
 * Resolve a subject TABLE by its technical or display name, optionally inside
 * one subject. A shared lookup's copies resolve to the original (the one that
 * holds the SQL), so the model never opens a copy it could not change.
 */
export async function subjectTableIdByName(ctx: ToolContext, name: string, productId: number | null): Promise<number> {
  const q = ctx.db('product_tables as pt')
    .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
    .join('data_products as dp', 'ss.data_product_id', 'dp.id')
    .where('dp.tenant_id', ctx.tenantId)
    .select('pt.id', 'pt.table_name', 'pt.display_name', 'pt.source_product_table_id', 'pt.is_shared_dimension', 'dp.id as product_id', 'dp.name as product_name');
  if (productId) q.andWhere('dp.id', productId);
  const rows = (await q) as Array<{ id: number; table_name: string; display_name: string | null; source_product_table_id: number | null; is_shared_dimension: boolean | null; product_id: number; product_name: string }>;
  const want = norm(name);
  const matches = rows.filter((r) => norm(r.table_name) === want || norm(r.display_name) === want);
  const originals = matches.filter((r) => !r.source_product_table_id && r.is_shared_dimension !== true);
  const pick = originals.length ? originals : matches;
  const ids = [...new Set(pick.map((r) => Number(r.source_product_table_id ?? r.id)))];
  if (ids.length === 1) return ids[0];
  if (!ids.length) throw new ToolError(`No subject table is called "${name}"${productId ? ' in that subject' : ''}. Use search_catalog to find it.`);
  throw new ToolError(`More than one table matches "${name}": ${pick.map((r) => `${r.display_name || r.table_name} in ${r.product_name} (table_id ${r.id})`).join(', ')}. Pick one.`);
}

/** Names for a source table + column, for a proposal card. Tenant-filtered. */
export async function sourceColumnLabel(ctx: ToolContext, tableId: number, columnId: number): Promise<string | null> {
  const row = await ctx.db('source_columns as sc')
    .join('source_tables as st', 'sc.table_id', 'st.id')
    .where({ 'sc.id': columnId, 'st.id': tableId, 'st.tenant_id': ctx.tenantId })
    .first('st.table_name', 'st.display_name', 'sc.column_name');
  return row ? `${row.display_name || row.table_name}.${row.column_name}` : null;
}

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Who would notice a change to this table: dashboards whose widget SQL names
 * it, saved questions that recorded it. By NAME, whole-word, under an
 * explicit tenant filter — the same way a person would search for it.
 * Best-effort: an unreadable answer is "nothing found", never a failed step.
 */
export async function tableImpact(db: Knex | Knex.Transaction, tenantId: number, tableName: string): Promise<CoworkerImpact> {
  if (!IDENT.test(tableName)) return { dashboards: [], savedQuestions: [] };
  const pattern = `\\m${tableName}\\M`;
  try {
    const [dashboards, questions] = await Promise.all([
      db('dashboards').where({ tenant_id: tenantId }).whereRaw('spec::text ~* ?', [pattern])
        .orderBy('updated_at', 'desc').limit(10).select('id', 'title'),
      db('saved_questions').where({ tenant_id: tenantId })
        .where((qb) => qb.whereRaw('tables_used::text ~* ?', [pattern]).orWhereRaw('sql ~* ?', [pattern]))
        .orderBy('updated_at', 'desc').limit(10).select('id', 'question'),
    ]);
    return {
      dashboards: dashboards.map((d: { id: number; title: string }) => ({ id: Number(d.id), name: String(d.title) })),
      savedQuestions: questions.map((q: { id: number; question: string }) => ({ id: Number(q.id), question: String(q.question) })),
    };
  } catch {
    return { dashboards: [], savedQuestions: [] };
  }
}

export function impactLine(impact: CoworkerImpact): string {
  const n = impact.dashboards.length, q = impact.savedQuestions.length;
  if (!n && !q) return 'nothing else uses it';
  const parts: string[] = [];
  if (n) parts.push(`${n} dashboard${n === 1 ? '' : 's'}`);
  if (q) parts.push(`${q} saved question${q === 1 ? '' : 's'}`);
  return `used by ${parts.join(' and ')}`;
}

