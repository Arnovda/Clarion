/**
 * The Studio coworker's tools — what it may look at, and what it may PROPOSE.
 *
 * Two kinds, and the difference is the whole safety story:
 *
 *   read     looks something up. Runs immediately, costs no model call (the
 *            work is a database or warehouse read behind an existing route).
 *   propose  prepares a change and CHECKS it — compiles the SQL, measures the
 *            relationship, resolves the glossary links, works out which
 *            dashboards would notice — and hands it to the person. It never
 *            writes. The panel's Keep calls the same write route the screens
 *            call, as the same user, so a coworker proposal is held to exactly
 *            the rules a hand-made change is.
 *
 * What is deliberately NOT here (owner decision, 2026-09-24): deleting
 * anything, data policies and masks, users and roles, source credentials,
 * a full rebuild, budgets and model choice. Those stay human acts on their
 * own screens; the system prompt tells the model to say where.
 *
 * Every tool reaches the product through `internalCall` (the same HTTP routes,
 * with the person's own token) or, for the two reads no route serves, through
 * the request's tenant-scoped handle with an explicit tenant filter.
 */
import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import type {
  CoworkerFocus, CoworkerImpact, CoworkerProposal, CoworkerGlossaryLink,
} from '../../shared/contract';
import type { CoworkerToolDefinition } from '../../ai/AIService';
import { internalCall, type InternalCaller } from './internalApi';
import { buildCoverageContext } from '../buildChatContext';

export interface ToolContext {
  caller: InternalCaller;
  tenantId: number;
  /** The request's tenant-scoped handle (routes each query through tenantQuery after the SSE flush). */
  db: Knex | Knex.Transaction;
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
  /** The step's label, in the product's words — the person reads this live. */
  label: (input: Record<string, unknown>) => string;
  run: (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolOutcome>;
}

/** A refusal the model can act on (it reads the message). Not a crash. */
export class ToolError extends Error {}

// ─── small helpers ──────────────────────────────────────────────────────────

const clip = (s: unknown, max: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function posInt(input: Record<string, unknown>, key: string): number {
  const n = Number(input[key]);
  if (!Number.isInteger(n) || n <= 0) throw new ToolError(`"${key}" must be a positive whole number.`);
  return n;
}

function text(input: Record<string, unknown>, key: string, max: number, required = true): string {
  const v = typeof input[key] === 'string' ? (input[key] as string).trim() : '';
  if (required && !v) throw new ToolError(`"${key}" is required.`);
  if (v.length > max) throw new ToolError(`"${key}" is too long (max ${max} characters).`);
  return v;
}

async function get(ctx: ToolContext, path: string) {
  const r = await internalCall(ctx.caller, 'GET', path);
  if (!r.ok) throw new ToolError(r.status === 404 ? 'Not found in this workspace.' : r.error ?? 'The lookup failed.');
  return r.data;
}

async function post(ctx: ToolContext, path: string, body: unknown) {
  const r = await internalCall(ctx.caller, 'POST', path, body);
  if (!r.ok) throw new ToolError(r.status === 404 ? 'Not found in this workspace.' : r.error ?? 'The check failed.');
  return r.data;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function impactLine(impact: CoworkerImpact): string {
  const n = impact.dashboards.length, q = impact.savedQuestions.length;
  if (!n && !q) return 'nothing else uses it';
  const parts: string[] = [];
  if (n) parts.push(`${n} dashboard${n === 1 ? '' : 's'}`);
  if (q) parts.push(`${q} saved question${q === 1 ? '' : 's'}`);
  return `used by ${parts.join(' and ')}`;
}

// ─── the tools ──────────────────────────────────────────────────────────────

const describeWorkspace: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'describe_workspace',
    description: 'Overview of the whole workspace: every source with its synced tables (and which subject uses each), every subject with its tables and metrics. Call this first when you do not know what exists.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  label: () => 'Reading what is in the workspace',
  async run(ctx) {
    const coverage = await buildCoverageContext(ctx.db as Knex, ctx.tenantId);
    return { result: clip(coverage.text, 9000), detail: `${coverage.connectionIds.size} source(s), ${coverage.productNamesLower.size} subject(s)` };
  },
};

const searchCatalog: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'search_catalog',
    description: 'Find tables and columns by name or meaning across sources and subjects. Returns ids you can open.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Two or more characters, e.g. "invoice" or "customer country".' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  label: (i) => `Searching the catalog for “${clip(i.query, 40)}”`,
  async run(ctx, input) {
    const q = text(input, 'query', 120);
    const data = await get(ctx, `/catalog/search?q=${encodeURIComponent(q)}`);
    const hits = Array.isArray(data) ? data : [];
    return {
      result: hits.slice(0, 25).map((h: Record<string, unknown>) => {
        // The schema slug ends in the owner's id: `exact_online_17` → source 17,
        // `finance_4` → subject 4. That is how the catalog addresses a hit.
        const ownerId = Number(String(h.schemaSlug ?? '').match(/_(\d+)$/)?.[1] ?? 0) || undefined;
        const layer = h.catalog === 'sources' ? 'source' : 'subject';
        return {
          layer, kind: h.kind, table_id: Number(h.tableId), table: h.tableName, label: h.tableLabel,
          column: h.columnName ?? undefined, in: h.schemaLabel,
          ...(layer === 'source' ? { connection_id: ownerId } : { product_id: ownerId }),
        };
      }),
      detail: `${hits.length} match${hits.length === 1 ? '' : 'es'}`,
    };
  },
};

const openSubject: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'open_subject',
    description: 'Open a subject (a data product): its description, its tables (with ids, role, row counts, shared-from) and metrics. The screen follows.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'integer' } },
      required: ['product_id'],
      additionalProperties: false,
    },
  },
  label: () => 'Opening the subject',
  async run(ctx, input) {
    const productId = posInt(input, 'product_id');
    const p = await get(ctx, `/products/${productId}`);
    const tables = (p?.star_schemas ?? []).flatMap((s: { tables?: unknown[] }) => s.tables ?? []) as Array<Record<string, unknown>>;
    return {
      focus: { kind: 'subject', productId },
      detail: `${clip(p?.name, 40)} · ${tables.length} table(s)`,
      result: {
        id: productId, name: p?.name, description: clip(p?.description, 400), connection_id: p?.connection_id,
        tables: tables.slice(0, 40).map((t) => ({
          id: t.id, name: t.table_name, label: t.display_name ?? undefined, role: t.table_role,
          rows: t.row_count ?? undefined, status: t.transformation_status ?? undefined,
          shared_from_another_subject: t.is_reference === true || t.is_shared_dimension === true || undefined,
          description: clip(t.description, 160) || undefined,
        })),
      },
    };
  },
};

const openTable: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'open_table',
    description: 'Open a SUBJECT table by its id: its SQL declaration, columns, build state and who changed it last. The screen follows to its SQL.',
    input_schema: {
      type: 'object',
      properties: { table_id: { type: 'integer', description: 'The product table id.' } },
      required: ['table_id'],
      additionalProperties: false,
    },
  },
  label: () => 'Opening the table',
  async run(ctx, input) {
    const tableId = posInt(input, 'table_id');
    const d = await get(ctx, `/products/tables/${tableId}/declaration`);
    return {
      focus: { kind: 'table', tableId, tab: 'sql' },
      detail: `${clip(d?.display_name || d?.table_name, 48)} · ${d?.row_count ?? '?'} rows`,
      result: {
        id: tableId, name: d?.table_name, label: d?.display_name ?? undefined, role: d?.table_role,
        subject: d?.product?.name, product_id: d?.product?.id,
        status: d?.transformation_status, rows: d?.row_count, last_error: clip(d?.last_run_error, 300) || undefined,
        changed_since_last_build: d?.pending_rebuild, shared_from: d?.shared_from?.productName ?? undefined,
        is_copy_of_shared_table: d?.is_copy || undefined,
        sql: clip(d?.transformation_sql, 6000),
        columns: (d?.columns ?? []).slice(0, 80).map((c: Record<string, unknown>) => ({
          name: c.column_name, type: c.data_type, role: c.column_role ?? undefined, description: clip(c.description, 120) || undefined,
        })),
      },
    };
  },
};

const openSourceTable: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'open_source_table',
    description: 'Open a SOURCE table (synced from a source system) by id: its columns WITH column ids, and the relationships around it. Use the ids with propose_relationship. The screen follows.',
    input_schema: {
      type: 'object',
      properties: { table_id: { type: 'integer', description: 'The source table id.' } },
      required: ['table_id'],
      additionalProperties: false,
    },
  },
  label: () => 'Opening the source table and its relationships',
  async run(ctx, input) {
    const tableId = posInt(input, 'table_id');
    const g = await get(ctx, `/relationships/graph?anchorTableId=${tableId}&depth=1&withColumns=1`);
    const tables = (g?.tables ?? []) as Array<Record<string, unknown>>;
    const self = tables.find((t) => Number(t.id) === tableId);
    const columns = (g?.columns ?? []) as Array<Record<string, unknown>>;
    const nameOf = (id: unknown) => { const t = tables.find((x) => Number(x.id) === Number(id)); return t ? String(t.tableName) : String(id); };
    const colOf = (id: unknown) => { const c = columns.find((x) => Number(x.id) === Number(id)); return c ? String(c.column_name) : '?'; };
    const rels = (g?.relationships ?? []) as Array<Record<string, unknown>>;
    const connectionId = Number(self?.connectionId ?? 0);
    return {
      ...(connectionId > 0 ? { focus: { kind: 'source-table' as const, tableId, connectionId } } : {}),
      detail: `${columns.filter((c) => Number(c.table_id) === tableId).length} columns · ${rels.length} relationship(s)`,
      result: {
        id: tableId, name: self ? nameOf(tableId) : undefined, connection_id: connectionId || undefined,
        columns: columns.filter((c) => Number(c.table_id) === tableId).slice(0, 120).map((c) => ({
          id: c.id, name: c.column_name, type: c.source_data_type ?? c.data_type,
        })),
        neighbours: tables.filter((t) => Number(t.id) !== tableId).slice(0, 12).map((t) => ({
          id: t.id, name: nameOf(t.id),
          columns: columns.filter((c) => Number(c.table_id) === Number(t.id)).slice(0, 40).map((c) => ({ id: c.id, name: c.column_name })),
        })),
        relationships: rels.slice(0, 30).map((r) => ({
          id: r.id,
          from: `${nameOf(r.fromTableId)}.${colOf(r.fromColumnId)}`,
          to: `${nameOf(r.toTableId)}.${colOf(r.toColumnId)}`,
          type: r.relationshipType, kind: r.kind, flagged: r.flagged || undefined,
        })),
      },
    };
  },
};

const previewRows: CoworkerTool = {
  kind: 'read',
  sendsRows: true,
  definition: {
    name: 'preview_rows',
    description: 'A few sample rows of a SUBJECT table (data policies apply). Use sparingly — only when the values matter to the question.',
    input_schema: {
      type: 'object',
      properties: { table_id: { type: 'integer' } },
      required: ['table_id'],
      additionalProperties: false,
    },
  },
  label: () => 'Looking at a few rows',
  async run(ctx, input) {
    const tableId = posInt(input, 'table_id');
    const d = await get(ctx, `/semantic/product-preview?productTableId=${tableId}&limit=6`);
    const rows = (d?.rows ?? []) as unknown[];
    return { detail: `${rows.length} row(s)`, result: { columns: d?.columns, rows: rows.slice(0, 6) } };
  },
};

const tableLineage: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'table_lineage',
    description: 'Where a table comes from (layer "product": which source columns feed it) or what it feeds (layer "source").',
    input_schema: {
      type: 'object',
      properties: { table_id: { type: 'integer' }, layer: { type: 'string', enum: ['product', 'source'] } },
      required: ['table_id', 'layer'],
      additionalProperties: false,
    },
  },
  label: () => 'Tracing where the data comes from',
  async run(ctx, input) {
    const tableId = posInt(input, 'table_id');
    const layer = input.layer === 'source' ? 'source' : 'product';
    const d = await get(ctx, `/lineage/table?layer=${layer}&tableId=${tableId}`);
    return { detail: 'lineage read', result: clip(JSON.stringify(d), 5000) };
  },
};

const tableUsage: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'table_usage',
    description: 'Which dashboards and saved questions use a table (by its technical name). Check this before proposing a change that removes or renames columns.',
    input_schema: {
      type: 'object',
      properties: { table_name: { type: 'string' } },
      required: ['table_name'],
      additionalProperties: false,
    },
  },
  label: (i) => `Checking what uses ${clip(i.table_name, 40)}`,
  async run(ctx, input) {
    const name = text(input, 'table_name', 128);
    if (!IDENT.test(name)) throw new ToolError('table_name must be a technical table name, e.g. fact_sales_lines.');
    const impact = await tableImpact(ctx.db, ctx.tenantId, name);
    return { detail: impactLine(impact), result: impact };
  },
};

const listDefinitions: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'list_definitions',
    description: 'The glossary terms (with what they point at), the metrics per subject, and the verified answers.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  label: () => 'Reading the definitions',
  async run(ctx) {
    const d = await get(ctx, '/definitions');
    const terms = (d?.terms ?? []) as Array<Record<string, unknown>>;
    return {
      detail: `${terms.length} term(s)`,
      result: {
        terms: terms.slice(0, 80).map((t) => ({ term: t.term, meaning: clip(t.meaning, 160) })),
        metrics: clip(JSON.stringify(d?.metrics ?? []), 2500),
      },
    };
  },
};

// ─── proposals ──────────────────────────────────────────────────────────────

const proposeSqlChange: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_sql_change',
    description: 'Propose a change to a SUBJECT table\'s SQL, described in words. A specialised writer drafts the SQL; it is guarded and compiled, and the person sees the diff and what uses the table before deciding. Nothing is saved.',
    input_schema: {
      type: 'object',
      properties: {
        table_id: { type: 'integer' },
        instruction: { type: 'string', description: 'The change in plain words, precise: which columns, which filter, which join.' },
      },
      required: ['table_id', 'instruction'],
      additionalProperties: false,
    },
  },
  label: () => 'Drafting and compiling a SQL change',
  async run(ctx, input) {
    const tableId = posInt(input, 'table_id');
    const instruction = text(input, 'instruction', 1500);
    const before = await get(ctx, `/products/tables/${tableId}/declaration`);
    if (before?.is_copy) throw new ToolError(`This table is a copy of a shared table${before?.shared_from?.productName ? ` from ${before.shared_from.productName}` : ''} — change the original instead.`);
    const p = await post(ctx, `/products/tables/${tableId}/sql/propose`, { instruction });
    if (!p?.proposed) {
      return { detail: 'no change needed', result: { proposed: false, why: p?.summary ?? 'No change was needed.' } };
    }
    const impact = await tableImpact(ctx.db, ctx.tenantId, String(before?.table_name ?? ''));
    const proposal: CoworkerProposal = {
      id: randomUUID(), kind: 'sql', tableId,
      tableName: String(before?.table_name ?? ''),
      label: String(before?.display_name || before?.table_name || `table ${tableId}`),
      before: String(before?.transformation_sql ?? ''), after: String(p.sql ?? ''),
      summary: String(p.summary ?? ''), compiled: !!p.compiled, error: p.error ?? null, impact,
    };
    return {
      proposal,
      focus: { kind: 'table', tableId, tab: 'sql' },
      detail: p.compiled ? `compiles · ${impactLine(impact)}` : 'does not compile yet',
      result: { proposed: true, compiled: !!p.compiled, compile_error: p.error ?? undefined, summary: p.summary, impact: impactLine(impact) },
    };
  },
};

const proposeRelationship: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_relationship',
    description: 'Propose a relationship between two SOURCE table columns (from = the many side, e.g. invoice.customer_id; to = the key, e.g. customer.id). It is MEASURED on the real data first; the person sees the measurement before deciding. Get column ids from open_source_table.',
    input_schema: {
      type: 'object',
      properties: {
        from_table_id: { type: 'integer' }, from_column_id: { type: 'integer' },
        to_table_id: { type: 'integer' }, to_column_id: { type: 'integer' },
        reason: { type: 'string', description: 'One sentence: why these two columns belong together.' },
      },
      required: ['from_table_id', 'from_column_id', 'to_table_id', 'to_column_id', 'reason'],
      additionalProperties: false,
    },
  },
  label: () => 'Measuring the relationship on your data',
  async run(ctx, input) {
    const ids = {
      fromTableId: posInt(input, 'from_table_id'), fromColumnId: posInt(input, 'from_column_id'),
      toTableId: posInt(input, 'to_table_id'), toColumnId: posInt(input, 'to_column_id'),
    };
    const reason = text(input, 'reason', 400);
    const m = await post(ctx, '/relationships/measure', ids);
    // Names for the card, from the same graph the canvas reads.
    const g = await get(ctx, `/relationships/graph?anchorTableId=${ids.fromTableId}&depth=1&withColumns=1`).catch(() => null); // non-db: a loopback HTTP call
    const tname = (id: number) => { const t = (g?.tables ?? []).find((x: Record<string, unknown>) => Number(x.id) === id); return t ? String(t.displayName || t.tableName) : `table ${id}`; };
    const cname = (id: number) => { const c = (g?.columns ?? []).find((x: Record<string, unknown>) => Number(x.id) === id); return c ? String(c.column_name) : `column ${id}`; };
    const ratio = m?.containment?.ratio;
    const proposal: CoworkerProposal = {
      id: randomUUID(), kind: 'relationship', ...ids,
      fromLabel: `${tname(ids.fromTableId)}.${cname(ids.fromColumnId)}`,
      toLabel: `${tname(ids.toTableId)}.${cname(ids.toColumnId)}`,
      reason,
      measurement: {
        verdict: m?.verdict ?? 'unmeasurable', reason: String(m?.reason ?? ''),
        containment: m?.containment ?? null, cardinality: m?.cardinality ?? null, orphans: m?.orphans ?? null,
      },
    };
    return {
      proposal,
      focus: { kind: 'relations', tableId: ids.fromTableId },
      detail: `${m?.verdict ?? 'unmeasurable'}${typeof ratio === 'number' ? ` · ${Math.round(ratio * 100)}% of values found` : ''}`,
      result: { verdict: m?.verdict, reason: m?.reason, containment: ratio, cardinality: m?.cardinality?.type, orphans: m?.orphans?.rows },
    };
  },
};

const proposeGlossaryTerm: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_glossary_term',
    description: 'Propose a new glossary term: what the business calls something, what it means, and optionally where it lives (a subject table, a column of one, or a metric). Links are checked against the catalog first.',
    input_schema: {
      type: 'object',
      properties: {
        term: { type: 'string' },
        meaning: { type: 'string', description: 'One or two plain sentences.' },
        links: {
          type: 'array', maxItems: 8,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['column', 'table', 'kpi'] },
              table: { type: 'string', description: 'Technical subject table name, for column/table links.' },
              column: { type: 'string', description: 'Technical column name, for a column link.' },
              kpi: { type: 'string', description: 'Metric name, for a kpi link.' },
            },
            required: ['kind'],
          },
        },
      },
      required: ['term', 'meaning'],
      additionalProperties: false,
    },
  },
  label: (i) => `Preparing the term “${clip(i.term, 40)}”`,
  async run(ctx, input) {
    const term = text(input, 'term', 120);
    const meaning = text(input, 'meaning', 1200);
    const rawLinks = Array.isArray(input.links) ? input.links.slice(0, 8) as Array<Record<string, unknown>> : [];
    const links: CoworkerGlossaryLink[] = rawLinks.map((l) => {
      const kind = l.kind === 'table' || l.kind === 'kpi' ? l.kind : 'column';
      return kind === 'kpi'
        ? { kind, kpi: String(l.kpi ?? '') }
        : kind === 'table' ? { kind, table: String(l.table ?? '') } : { kind, table: String(l.table ?? ''), column: String(l.column ?? '') };
    });

    const existing = await get(ctx, '/semantic/glossary');
    const terms = (Array.isArray(existing) ? existing : []) as Array<Record<string, unknown>>;
    if (terms.some((t) => String(t.term ?? '').trim().toLowerCase() === term.toLowerCase())) {
      throw new ToolError(`The glossary already has "${term}". Say so instead of proposing it again.`);
    }
    if (links.length) {
      const targets = await get(ctx, '/semantic/glossary/link-targets');
      const tables = (targets?.tables ?? []) as Array<{ tableName: string; columns?: Array<{ name: string }> }>;
      const kpis = (targets?.kpis ?? []) as Array<{ name?: string }>;
      for (const l of links) {
        if (l.kind === 'kpi') {
          if (!kpis.some((k) => String(k.name ?? '').toLowerCase() === String(l.kpi).toLowerCase())) throw new ToolError(`There is no metric called "${l.kpi}".`);
          continue;
        }
        const t = tables.find((x) => x.tableName === l.table);
        if (!t) throw new ToolError(`"${l.table}" is not a subject table a term can point at.`);
        if (l.kind === 'column' && !(t.columns ?? []).some((c) => c.name === l.column)) {
          throw new ToolError(`"${l.table}" has no column "${l.column}" a term can point at.`);
        }
      }
    }
    const proposal: CoworkerProposal = { id: randomUUID(), kind: 'glossary', term, meaning, links };
    return { proposal, detail: links.length ? `${links.length} link(s) checked` : 'no links', result: { proposed: true } };
  },
};

const proposeNewTable: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_new_table',
    description: 'Propose adding a new table to an existing subject. On Keep the table is created and its SQL is drafted from sql_instruction as a second proposal the person reviews.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'integer' },
        table_name: { type: 'string', description: 'lowercase_with_underscores, e.g. dim_region or fact_quotation_lines' },
        table_role: { type: 'string', enum: ['fact', 'dimension', 'bridge'] },
        description: { type: 'string', description: 'What one row is.' },
        sql_instruction: { type: 'string', description: 'What the SQL should select, from which source tables.' },
      },
      required: ['product_id', 'table_name', 'table_role', 'description', 'sql_instruction'],
      additionalProperties: false,
    },
  },
  label: (i) => `Preparing a new table ${clip(i.table_name, 40)}`,
  async run(ctx, input) {
    const productId = posInt(input, 'product_id');
    const tableName = text(input, 'table_name', 63);
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(tableName)) throw new ToolError('table_name must be lowercase letters, digits and underscores, starting with a letter.');
    const role = input.table_role === 'fact' || input.table_role === 'bridge' ? input.table_role : 'dimension';
    const p = await get(ctx, `/products/${productId}`);
    const taken = (p?.star_schemas ?? []).flatMap((s: { tables?: Array<{ table_name?: string }> }) => s.tables ?? [])
      .some((t: { table_name?: string }) => t.table_name === tableName);
    if (taken) throw new ToolError(`"${p?.name}" already has a table called ${tableName}.`);
    const proposal: CoworkerProposal = {
      id: randomUUID(), kind: 'table', productId, productName: String(p?.name ?? ''),
      tableName, tableRole: role, description: text(input, 'description', 600), sqlInstruction: text(input, 'sql_instruction', 1500),
    };
    return { proposal, focus: { kind: 'subject', productId }, detail: `in ${clip(p?.name, 40)}`, result: { proposed: true } };
  },
};

const proposeNewSubject: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_new_subject',
    description: 'Propose a NEW subject built from synced source tables of one source, next to the existing ones (existing subjects are never changed). On Keep the subject is designed and built — that takes minutes.',
    input_schema: {
      type: 'object',
      properties: {
        connection_id: { type: 'integer' },
        name: { type: 'string', description: 'A business name, e.g. "Quotations".' },
        description: { type: 'string' },
        entities: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 25, description: 'Exact synced source table names.' },
        focus: { type: 'string', description: 'Optional: what the person most wants to answer with it.' },
      },
      required: ['connection_id', 'name', 'description', 'entities'],
      additionalProperties: false,
    },
  },
  label: (i) => `Preparing a new subject “${clip(i.name, 40)}”`,
  async run(ctx, input) {
    const connectionId = posInt(input, 'connection_id');
    const name = text(input, 'name', 80);
    const entities = (Array.isArray(input.entities) ? input.entities : []).map((e) => String(e).trim()).filter(Boolean).slice(0, 25);
    if (!entities.length) throw new ToolError('Name at least one synced source table.');
    const coverage = await buildCoverageContext(ctx.db as Knex, ctx.tenantId);
    if (!coverage.connectionIds.has(connectionId)) throw new ToolError('That source is not in this workspace.');
    if (coverage.productNamesLower.has(name.toLowerCase())) throw new ToolError(`A subject called "${name}" already exists.`);
    const synced = coverage.syncedTablesByConnection.get(connectionId) ?? new Set<string>();
    const missing = entities.filter((e) => !synced.has(e));
    if (missing.length) throw new ToolError(`Not synced on that source: ${missing.join(', ')}.`);
    const conn = await get(ctx, '/connections').catch(() => []); // non-db: a loopback HTTP call
    const connectionName = String((Array.isArray(conn) ? conn : []).find((c: { id: number }) => Number(c.id) === connectionId)?.name ?? `source ${connectionId}`);
    const focusText = text(input, 'focus', 400, false);
    const proposal: CoworkerProposal = {
      id: randomUUID(), kind: 'subject', connectionId, connectionName, name,
      description: text(input, 'description', 600), entities, ...(focusText ? { focus: focusText } : {}),
    };
    return { proposal, detail: `${entities.length} source table(s) from ${connectionName}`, result: { proposed: true } };
  },
};

/**
 * One existing relationship, re-measured on the data — the question a person
 * asks on the Relations canvas ("does this one hold?"). The endpoints are read
 * from the row (explicit tenant filter), the measurement goes through the SAME
 * route the canvas's measure button calls. It does NOT store the result:
 * measuring is not deciding, and caching it would be a write.
 */
const checkRelationship: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'check_relationship',
    description: 'Re-measure an existing relationship (by id) on the real data: how many values are found on the other side, the cardinality, orphans, plus who laid it and whether it is flagged. Use it when the person asks whether a relationship holds. Nothing is saved.',
    input_schema: {
      type: 'object',
      properties: { relationship_id: { type: 'integer' } },
      required: ['relationship_id'],
      additionalProperties: false,
    },
  },
  label: () => 'Checking the relationship against your data',
  async run(ctx, input) {
    const id = posInt(input, 'relationship_id');
    const rel = await ctx.db('table_relationships as r')
      .leftJoin('source_tables as ft', function () { this.on('ft.id', '=', 'r.from_table_id').andOn('ft.tenant_id', '=', 'r.tenant_id'); })
      .leftJoin('source_tables as tt', function () { this.on('tt.id', '=', 'r.to_table_id').andOn('tt.tenant_id', '=', 'r.tenant_id'); })
      .leftJoin('source_columns as fc', 'fc.id', 'r.from_column_id')
      .leftJoin('source_columns as tc', 'tc.id', 'r.to_column_id')
      .where('r.id', id).andWhere('r.tenant_id', ctx.tenantId)
      .first(
        'r.id', 'r.from_table_id', 'r.to_table_id', 'r.from_column_id', 'r.to_column_id',
        'r.relationship_type', 'r.kind', 'r.ai_draft', 'r.confirmed_by_user', 'r.flagged_at', 'r.flagged_reason',
        'r.semantic_source', 'ft.table_name as from_table', 'tt.table_name as to_table',
        'fc.column_name as from_column', 'tc.column_name as to_column',
      );
    if (!rel) throw new ToolError('Not found in this workspace.');
    const fromTableId = Number(rel.from_table_id);
    const about = {
      id,
      link: `${rel.from_table}.${rel.from_column ?? '?'} → ${rel.to_table}.${rel.to_column ?? '?'}`,
      stored_type: rel.relationship_type ?? undefined,
      kind: rel.kind ?? 'join',
      laid_by: rel.semantic_source === 'vendor_docs' || rel.semantic_source === 'declared' ? 'the source' : 'a person or Clarion',
      status: rel.confirmed_by_user ? 'confirmed' : rel.ai_draft ? 'suggestion awaiting review' : 'confirmed',
      flagged: rel.flagged_at ? (rel.flagged_reason || 'yes') : undefined,
    };
    const focus: CoworkerFocus = { kind: 'relations', tableId: fromTableId, relationshipId: id };
    if (!rel.from_column_id || !rel.to_column_id) {
      return { focus, detail: 'no column on one side', result: { ...about, measured: 'This link does not name a column on both sides, so it cannot be measured.' } };
    }
    if ((rel.kind ?? 'join') === 'match') {
      return { focus, detail: 'a cross-source match', result: { ...about, measured: 'This is a match between two sources; it is judged by match rate on the canvas, not re-measured here.' } };
    }
    const m = await post(ctx, '/relationships/measure', {
      fromTableId, fromColumnId: Number(rel.from_column_id),
      toTableId: Number(rel.to_table_id), toColumnId: Number(rel.to_column_id),
    });
    const ratio = m?.containment?.ratio;
    return {
      focus,
      detail: `${m?.verdict ?? 'unmeasurable'}${typeof ratio === 'number' ? ` · ${Math.round(ratio * 100)}% of values found` : ''}`,
      result: {
        ...about,
        verdict: m?.verdict, reason: m?.reason, containment: ratio,
        measured_type: m?.cardinality?.type, orphans: m?.orphans?.rows,
      },
    };
  },
};

/**
 * How a source is doing: its last syncs and what went wrong. The question a
 * person asks on the Sources page. Names, statuses, counts and the (already
 * redacted) error text — never the connection's configuration.
 */
const sourceStatus: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'source_status',
    description: 'A source system\'s sync health: its last syncs (status, when, rows per table), what failed and why, tables still loading, and whether it has been analysed. Use it for "why did the sync fail?" or "is my data current?". Get the id from describe_workspace or the page.',
    input_schema: {
      type: 'object',
      properties: { connection_id: { type: 'integer' } },
      required: ['connection_id'],
      additionalProperties: false,
    },
  },
  label: () => 'Looking at the source\'s recent syncs',
  async run(ctx, input) {
    const connectionId = posInt(input, 'connection_id');
    const list = (await get(ctx, '/connections')) as Array<Record<string, unknown>> | null;
    const conn = (list ?? []).find((c) => Number(c.id) === connectionId);
    if (!conn) throw new ToolError('Not found in this workspace.');
    const runs = ((await get(ctx, `/connections/${connectionId}/sync-runs?limit=5`)) ?? []) as Array<Record<string, unknown>>;
    const rowTotal = (rc: unknown): number | undefined => {
      if (!rc || typeof rc !== 'object') return undefined;
      return Object.values(rc as Record<string, unknown>).reduce<number>((n, v) => n + (Number(v) || 0), 0);
    };
    const entities = Array.isArray(conn.selected_entities) ? conn.selected_entities.length : undefined;
    const last = runs[0];
    return {
      focus: { kind: 'source', connectionId },
      detail: last ? `last sync ${String(last.status)}` : 'never synced',
      result: {
        id: connectionId,
        name: conn.name,
        system: conn.connector_type ?? conn.type,
        tables_selected: entities,
        last_synced_at: conn.last_synced_at ?? undefined,
        analysed: conn.profiling_status === 'done' ? 'yes' : conn.profiling_status === 'structural' ? 'tables registered, not analysed yet' : (conn.profiling_status ?? 'no'),
        recent_syncs: runs.map((r) => ({
          status: r.status,
          mode: r.mode ?? undefined,
          queued_at: r.queued_at,
          finished_at: r.completed_at ?? undefined,
          rows: rowTotal(r.row_counts),
          error: r.error_message ? clip(r.error_message, 400) : undefined,
          failed_tables: r.failed_entities && typeof r.failed_entities === 'object' ? Object.keys(r.failed_entities as object).slice(0, 12) : undefined,
          still_loading: Array.isArray(r.incomplete_entities) && r.incomplete_entities.length ? r.incomplete_entities.slice(0, 12) : undefined,
          warnings: Array.isArray(r.warnings) && r.warnings.length ? (r.warnings as unknown[]).slice(0, 3).map((w) => clip(w, 200)) : undefined,
        })),
      },
    };
  },
};

export const COWORKER_TOOLS: CoworkerTool[] = [
  describeWorkspace, searchCatalog, openSubject, openTable, openSourceTable,
  previewRows, tableLineage, tableUsage, listDefinitions, checkRelationship, sourceStatus,
  proposeSqlChange, proposeRelationship, proposeGlossaryTerm, proposeNewTable, proposeNewSubject,
];

