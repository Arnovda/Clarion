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
import type { CoworkerFocus, CoworkerProposal, CoworkerGlossaryLink } from '../../shared/contract';
import { buildCoverageContext } from '../buildChatContext';
import {
  type CoworkerTool, ToolError, clip, posInt, text, get, post, optPosInt,
  subjectIdByName, subjectTableIdByName, sourceColumnLabel, IDENT, tableImpact, impactLine,
} from './toolKit';
import { DEFINITION_TOOLS, checkGlossaryLinks, normalizeLinks } from './definitionTools';
import { BUILD_TOOLS } from './buildTools';
import { GRID_TOOLS } from './gridTools';
import { QUERY_TOOLS } from './queryTools';

export { ToolError, tableImpact } from './toolKit';
export type { ToolContext, ToolOutcome, CoworkerTool } from './toolKit';

// ─── the tools ──────────────────────────────────────────────────────────────

const describeWorkspace: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'describe_workspace',
    description: 'Overview of the whole workspace WITH IDS: every subject (product_id) with its tables (table_id) and metrics, every source (connection_id) with its synced tables (source table_id) and which subject uses each. Call this first when you do not know what exists; use its ids with the open_* tools.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  resultLimit: 14_000,
  label: () => 'Reading what is in the workspace',
  async run(ctx) {
    const coverage = await buildCoverageContext(ctx.db as Knex, ctx.tenantId, { withIds: true });
    return { result: clip(coverage.text, 14_000), detail: `${coverage.connectionIds.size} source(s), ${coverage.productNamesLower.size} subject(s)` };
  },
};

const searchCatalog: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'search_catalog',
    description: 'Find subjects, tables and columns by name across sources and subjects. Returns ids you can open (product_id for a subject, table_id for a table).',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Two or more characters, e.g. "cash flow", "invoice" or "customer country".' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  label: (i) => `Searching the catalog for “${clip(i.query, 40)}”`,
  async run(ctx, input) {
    const q = text(input, 'query', 120);
    // Subjects by name — the catalog search matches tables and columns only,
    // and "the Cash Flow subject" is how a person names what they mean.
    const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const subjects = (await ctx.db('data_products')
      .where({ tenant_id: ctx.tenantId })
      .andWhere((qb) => qb.where('name', 'ilike', pattern).orWhere('description', 'ilike', pattern))
      .orderBy('name').limit(10)
      .select('id', 'name', 'kind')) as Array<{ id: number; name: string; kind: string | null }>;
    const data = await get(ctx, `/catalog/search?q=${encodeURIComponent(q)}`);
    const hits = Array.isArray(data) ? data : [];
    const found = [
      ...subjects.map((p) => ({ layer: 'subject', kind: p.kind === 'reference' ? 'shared data' : 'subject', product_id: Number(p.id), name: p.name })),
      ...hits.slice(0, 25).map((h: Record<string, unknown>) => {
        // The schema slug ends in the owner's id: `exact_online_17` → source 17,
        // `finance_4` → subject 4. That is how the catalog addresses a hit.
        const ownerId = Number(String(h.schemaSlug ?? '').match(/_(\d+)$/)?.[1] ?? 0) || undefined;
        const layer = h.catalog === 'sources' ? 'source' : 'subject table';
        return {
          layer, kind: h.kind, table_id: Number(h.tableId), table: h.tableName, label: h.tableLabel,
          column: h.columnName ?? undefined, in: h.schemaLabel,
          ...(layer === 'source' ? { connection_id: ownerId } : { product_id: ownerId }),
        };
      }),
    ];
    return {
      result: found.length ? found : 'Nothing matches. Try another word, or describe_workspace for the full list.',
      detail: `${found.length} match${found.length === 1 ? '' : 'es'}`,
    };
  },
};

const openSubject: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'open_subject',
    description: 'Open a subject (a data product) by product_id OR by its name: its description, its tables (table_id, role, row counts, shared-from) and its metrics (kpi_id) with their formulas. The screen follows.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'integer' },
        name: { type: 'string', description: 'The subject\'s name, e.g. "Cash Flow" — when you have no id.' },
      },
      additionalProperties: false,
    },
  },
  label: (i) => (i.name ? `Opening ${clip(i.name, 40)}` : 'Opening the subject'),
  async run(ctx, input) {
    const byId = optPosInt(input, 'product_id');
    const name = text(input, 'name', 120, false);
    if (!byId && !name) throw new ToolError('Give product_id or name.');
    const productId = byId ?? await subjectIdByName(ctx, name);
    const p = await get(ctx, `/products/${productId}`);
    const kpis = ((await get(ctx, `/products/${productId}/kpis`).catch(() => [])) ?? []) as Array<Record<string, unknown>>; // non-db: a loopback HTTP call
    const tables = (p?.star_schemas ?? []).flatMap((s: { tables?: unknown[] }) => s.tables ?? []) as Array<Record<string, unknown>>;
    return {
      focus: { kind: 'subject', productId },
      detail: `${clip(p?.name, 40)} · ${tables.length} table(s)${kpis.length ? ` · ${kpis.length} metric(s)` : ''}`,
      result: {
        product_id: productId, name: p?.name, description: clip(p?.description, 400), connection_id: p?.connection_id,
        tables: tables.slice(0, 40).map((t) => ({
          table_id: t.is_reference === true && t.owner_table_id ? t.owner_table_id : t.id,
          name: t.table_name, label: t.display_name ?? undefined, role: t.table_role,
          rows: t.row_count ?? undefined, status: t.transformation_status ?? undefined,
          shared_from_another_subject: t.is_reference === true || t.is_shared_dimension === true || undefined,
          description: clip(t.description, 160) || undefined,
        })),
        metrics: kpis.slice(0, 20).map((k) => ({
          kpi_id: k.id, name: k.name, question: k.question_text ?? undefined,
          formula: clip(k.formula_sql ?? k.formula_plain_text, 300) || undefined,
          description: clip(k.description, 160) || undefined,
        })),
      },
    };
  },
};

const openTable: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'open_table',
    description: 'Open a SUBJECT table by table_id OR by its name (technical like fact_receivables, or its label): its SQL declaration, columns (with ids, for propose_descriptions), build state and who changed it last. The screen follows to its SQL.',
    input_schema: {
      type: 'object',
      properties: {
        table_id: { type: 'integer', description: 'The subject table id.' },
        table_name: { type: 'string', description: 'When you have no id: the table\'s technical name or label.' },
        product_id: { type: 'integer', description: 'Optional, with table_name: only look in this subject.' },
      },
      additionalProperties: false,
    },
  },
  label: (i) => (i.table_name ? `Opening ${clip(i.table_name, 40)}` : 'Opening the table'),
  async run(ctx, input) {
    const byId = optPosInt(input, 'table_id');
    const name = text(input, 'table_name', 128, false);
    if (!byId && !name) throw new ToolError('Give table_id or table_name.');
    const tableId = byId ?? await subjectTableIdByName(ctx, name, optPosInt(input, 'product_id'));
    const d = await get(ctx, `/products/tables/${tableId}/declaration`);
    return {
      focus: { kind: 'table', tableId, tab: 'sql' },
      detail: `${clip(d?.display_name || d?.table_name, 48)} · ${d?.row_count ?? '?'} rows`,
      result: {
        table_id: tableId, name: d?.table_name, label: d?.display_name ?? undefined, role: d?.table_role,
        subject: d?.product?.name, product_id: d?.product?.id,
        status: d?.transformation_status, rows: d?.row_count, last_error: clip(d?.last_run_error, 300) || undefined,
        changed_since_last_build: d?.pending_rebuild, shared_from: d?.shared_from?.productName ?? undefined,
        is_copy_of_shared_table: d?.is_copy || undefined,
        sql: clip(d?.transformation_sql, 6000),
        columns: (d?.columns ?? []).slice(0, 80).map((c: Record<string, unknown>) => ({
          id: c.id, name: c.column_name, label: c.display_name ?? undefined, type: c.data_type,
          role: c.column_role ?? undefined, description: clip(c.description, 120) || undefined,
        })),
      },
    };
  },
  resultLimit: 12_000,
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
    description: 'The glossary terms, the metrics per subject (with their formulas), and the verified answers (questions your team marked as answered correctly).',
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
        // The questions a person marked as answered correctly — the answers
        // Ask AI gives verbatim. The description promised them; they were
        // dropped before the model saw them.
        verified_answers: ((d?.verifiedAnswers ?? []) as Array<Record<string, unknown>>)
          .slice(0, 40).map((v) => clip(v.question, 160)),
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
        table_name: { type: 'string', description: 'When you have no id: the table\'s technical name or label.' },
        instruction: { type: 'string', description: 'The change in plain words, precise: which columns, which filter, which join.' },
      },
      required: ['instruction'],
      additionalProperties: false,
    },
  },
  label: () => 'Drafting and compiling a SQL change',
  async run(ctx, input) {
    const byId = optPosInt(input, 'table_id');
    const name = text(input, 'table_name', 128, false);
    if (!byId && !name) throw new ToolError('Give table_id or table_name.');
    const tableId = byId ?? await subjectTableIdByName(ctx, name, null);
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
    // Names for the card — and a check that each column belongs to the table
    // it was named with, BEFORE spending a measurement on it. Read directly
    // (tenant-filtered) rather than from the canvas graph: the target of a
    // NEW relationship is by definition not yet a neighbour on it, and the
    // card said "table 412.column 9031".
    const fromLabel = await sourceColumnLabel(ctx, ids.fromTableId, ids.fromColumnId);
    const toLabel = await sourceColumnLabel(ctx, ids.toTableId, ids.toColumnId);
    if (!fromLabel) throw new ToolError('from_column_id is not a column of from_table_id in this workspace. Open the source table to get its column ids.');
    if (!toLabel) throw new ToolError('to_column_id is not a column of to_table_id in this workspace. Open the source table to get its column ids.');
    const m = await post(ctx, '/relationships/measure', ids);
    const ratio = m?.containment?.ratio;
    const proposal: CoworkerProposal = {
      id: randomUUID(), kind: 'relationship', ...ids,
      fromLabel, toLabel,
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
    const links: CoworkerGlossaryLink[] = normalizeLinks(input.links);
    const existing = await get(ctx, '/semantic/glossary');
    const terms = (Array.isArray(existing) ? existing : []) as Array<Record<string, unknown>>;
    if (terms.some((t) => String(t.term ?? '').trim().toLowerCase() === term.toLowerCase())) {
      throw new ToolError(`The glossary already has "${term}". To change it, use propose_glossary_change.`);
    }
    await checkGlossaryLinks(ctx, links);
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
        description: { type: 'string', description: 'At most 500 characters.' },
        entities: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12, description: 'Exact synced source table names (at most 12).' },
        focus: { type: 'string', description: 'Optional, at most 300 characters: what the person most wants to answer with it.' },
      },
      required: ['connection_id', 'name', 'description', 'entities'],
      additionalProperties: false,
    },
  },
  label: (i) => `Preparing a new subject “${clip(i.name, 40)}”`,
  async run(ctx, input) {
    // The limits are the build route's own (busMatrixExtendStartSchema): a
    // proposal the route would refuse is a Keep button that can only fail.
    const connectionId = posInt(input, 'connection_id');
    const name = text(input, 'name', 80);
    if (name.length < 2) throw new ToolError('The name needs at least two characters.');
    const entities = [...new Set((Array.isArray(input.entities) ? input.entities : []).map((e) => String(e).trim()).filter(Boolean))];
    if (!entities.length) throw new ToolError('Name at least one synced source table.');
    if (entities.length > 12) throw new ToolError('A new subject is built from at most 12 source tables — pick the ones it needs.');
    const coverage = await buildCoverageContext(ctx.db as Knex, ctx.tenantId);
    if (!coverage.connectionIds.has(connectionId)) throw new ToolError('That source is not in this workspace.');
    const hasSubjects = await ctx.db('data_products').where({ tenant_id: ctx.tenantId, connection_id: connectionId }).first('id');
    if (!hasSubjects) throw new ToolError('This source has no subjects yet — an addition builds on the first ones. Use propose_first_build.');
    if (coverage.productNamesLower.has(name.toLowerCase())) throw new ToolError(`A subject called "${name}" already exists.`);
    const synced = coverage.syncedTablesByConnection.get(connectionId) ?? new Set<string>();
    const missing = entities.filter((e) => !synced.has(e));
    if (missing.length) throw new ToolError(`Not synced on that source: ${missing.join(', ')}.`);
    const conn = await get(ctx, '/connections').catch(() => []); // non-db: a loopback HTTP call
    const connectionName = String((Array.isArray(conn) ? conn : []).find((c: { id: number }) => Number(c.id) === connectionId)?.name ?? `source ${connectionId}`);
    const focusText = text(input, 'focus', 300, false);
    const proposal: CoworkerProposal = {
      id: randomUUID(), kind: 'subject', connectionId, connectionName, name,
      description: text(input, 'description', 500), entities, ...(focusText ? { focus: focusText } : {}),
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
  ...DEFINITION_TOOLS, ...BUILD_TOOLS, ...GRID_TOOLS, ...QUERY_TOOLS,
];

