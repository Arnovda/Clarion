/**
 * Proposals that edit DEFINITIONS the workspace already has: descriptions and
 * display names, metrics, glossary terms, and existing relationships.
 *
 * Same contract as every other proposal (see tools.ts): the tool reads what is
 * there NOW, checks the change (a metric's formula is run, a relationship is
 * measured, glossary links are resolved), and hands the person a before/after
 * they decide on. Nothing here writes — Keep calls the screens' own routes.
 */
import { randomUUID } from 'crypto';
import type {
  CoworkerDescriptionItem, CoworkerFieldChange, CoworkerGlossaryLink, CoworkerProposal,
} from '../../shared/contract';
import { internalCall } from './internalApi';
import {
  type CoworkerTool, type ToolContext, ToolError, clip, posInt, text, get, post, optPosInt, norm,
  subjectIdByName,
} from './toolKit';

// ─── shared helpers ─────────────────────────────────────────────────────────

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim() === (b ?? '').trim();

/** Only the fields that actually change, in the order the person reads them. */
function fieldChanges(rows: Array<[string, string | null, string | null]>): CoworkerFieldChange[] {
  return rows.filter(([, b, a]) => !same(b, a)).map(([field, before, after]) => ({ field, before, after }));
}

export function linkText(l: CoworkerGlossaryLink): string {
  return l.kind === 'kpi' ? `metric: ${l.kpi}` : l.kind === 'table' ? String(l.table) : `${l.table}.${l.column}`;
}

export function normalizeLinks(raw: unknown): CoworkerGlossaryLink[] {
  const list = Array.isArray(raw) ? raw.slice(0, 8) as Array<Record<string, unknown>> : [];
  return list.map((l) => {
    const kind = l.kind === 'table' || l.kind === 'kpi' ? l.kind : 'column';
    return kind === 'kpi'
      ? { kind, kpi: String(l.kpi ?? '') }
      : kind === 'table' ? { kind, table: String(l.table ?? '') } : { kind, table: String(l.table ?? ''), column: String(l.column ?? '') };
  });
}

/** Every link must point at something that exists — the glossary route refuses otherwise. */
export async function checkGlossaryLinks(ctx: ToolContext, links: CoworkerGlossaryLink[]): Promise<void> {
  if (!links.length) return;
  const targets = await get(ctx, '/semantic/glossary/link-targets');
  const tables = (targets?.tables ?? []) as Array<{ tableName: string; columns?: Array<{ name: string }> }>;
  const kpis = (targets?.kpis ?? []) as Array<{ name?: string }>;
  for (const l of links) {
    if (l.kind === 'kpi') {
      if (!kpis.some((k) => norm(k.name) === norm(l.kpi))) throw new ToolError(`There is no metric called "${l.kpi}".`);
      continue;
    }
    const t = tables.find((x) => x.tableName === l.table);
    if (!t) throw new ToolError(`"${l.table}" is not a subject table a term can point at.`);
    if (l.kind === 'column' && !(t.columns ?? []).some((c) => c.name === l.column)) {
      throw new ToolError(`"${l.table}" has no column "${l.column}" a term can point at.`);
    }
  }
}

type Measurement = NonNullable<Extract<CoworkerProposal, { kind: 'relationship-review' }>['measurement']>;

/** /relationships/measure's answer, in the shape a card shows. */
export function toMeasurement(m: Record<string, unknown> | null): Measurement {
  return {
    verdict: (m?.verdict as Measurement['verdict']) ?? 'unmeasurable',
    reason: String(m?.reason ?? ''),
    containment: (m?.containment as Measurement['containment']) ?? null,
    cardinality: (m?.cardinality as Measurement['cardinality']) ?? null,
    orphans: (m?.orphans as Measurement['orphans']) ?? null,
  };
}

/** One relationship with its names, under an explicit tenant filter. */
export async function loadRelationship(ctx: ToolContext, id: number) {
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
  return rel as Record<string, unknown> | undefined;
}

// ─── descriptions and display names ─────────────────────────────────────────

const TARGETS = ['source-table', 'source-column', 'subject-table', 'subject-column'] as const;
type Target = typeof TARGETS[number];

interface CurrentText { id: number; label: string; description: string | null; display_name: string | null }

/**
 * What an item says now, and the id its write route takes. A subject table or
 * column is written through the graph-backed route, so its GRAPH id is the
 * one carried; a copy of a shared table is refused — its original is edited.
 */
async function currentText(ctx: ToolContext, target: Target, id: number): Promise<CurrentText> {
  const t = ctx.tenantId;
  if (target === 'source-table') {
    const r = await ctx.db('source_tables').where({ id, tenant_id: t }).first('id', 'table_name', 'display_name', 'description');
    if (!r) throw new ToolError(`source table ${id} is not in this workspace.`);
    return { id, label: String(r.display_name || r.table_name), description: r.description ?? null, display_name: r.display_name ?? null };
  }
  if (target === 'source-column') {
    const r = await ctx.db('source_columns as c').join('source_tables as st', 'c.table_id', 'st.id')
      .where({ 'c.id': id, 'st.tenant_id': t })
      .first('c.column_name', 'c.display_name', 'c.description', 'st.table_name', 'st.display_name as table_label');
    if (!r) throw new ToolError(`source column ${id} is not in this workspace. Open the source table to get its column ids.`);
    return { id, label: `${r.table_label || r.table_name} › ${r.column_name}`, description: r.description ?? null, display_name: r.display_name ?? null };
  }
  const tables = ctx.db('product_tables as pt')
    .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
    .join('data_products as dp', 'ss.data_product_id', 'dp.id')
    .where('dp.tenant_id', t);
  if (target === 'subject-table') {
    const r = await tables.clone().where('pt.id', id)
      .first('pt.id', 'pt.neo4j_pg_id', 'pt.table_name', 'pt.display_name', 'pt.description', 'pt.source_product_table_id', 'pt.is_shared_dimension');
    if (!r) throw new ToolError(`subject table ${id} is not in this workspace.`);
    if (r.source_product_table_id || r.is_shared_dimension === true) {
      throw new ToolError(`${r.display_name || r.table_name} is a copy of a shared table — describe the original${r.source_product_table_id ? ` (table_id ${r.source_product_table_id})` : ''}.`);
    }
    if (r.neo4j_pg_id == null) throw new ToolError(`${r.display_name || r.table_name} is not in the catalog yet — rebuild its subject first.`);
    return { id: Number(r.neo4j_pg_id), label: String(r.display_name || r.table_name), description: r.description ?? null, display_name: r.display_name ?? null };
  }
  const r = await tables.clone().join('product_columns as pc', 'pc.product_table_id', 'pt.id').where('pc.id', id)
    .first('pc.neo4j_pg_id', 'pc.column_name', 'pc.display_name', 'pc.description',
      'pt.table_name', 'pt.display_name as table_label', 'pt.source_product_table_id', 'pt.is_shared_dimension');
  if (!r) throw new ToolError(`subject column ${id} is not in this workspace. Open the table to get its column ids.`);
  if (r.source_product_table_id || r.is_shared_dimension === true) {
    throw new ToolError(`${r.table_label || r.table_name} is a copy of a shared table — describe the original's columns instead.`);
  }
  if (r.neo4j_pg_id == null) throw new ToolError(`${r.table_label || r.table_name} is not in the catalog yet — rebuild its subject first.`);
  return { id: Number(r.neo4j_pg_id), label: `${r.table_label || r.table_name} › ${r.column_name}`, description: r.description ?? null, display_name: r.display_name ?? null };
}

const MAX_DESCRIPTION_ITEMS = 40;

const proposeDescriptions: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_descriptions',
    description: 'Propose new descriptions or display names for tables and columns — source or subject. Up to 40 in ONE proposal (use one call for a whole table rather than one per column). The person sees each old text next to the new one. Ids: source tables/columns from open_source_table, subject tables/columns from open_table.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array', minItems: 1, maxItems: MAX_DESCRIPTION_ITEMS,
          items: {
            type: 'object',
            properties: {
              target: { type: 'string', enum: [...TARGETS] },
              id: { type: 'integer', description: 'The table or column id (column ids come with the open_* results).' },
              field: { type: 'string', enum: ['description', 'display_name'] },
              text: { type: 'string', description: 'The new text. A description: one or two plain sentences a business user understands.' },
            },
            required: ['target', 'id', 'field', 'text'],
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  label: (i) => {
    const n = Array.isArray(i.items) ? i.items.length : 0;
    return `Preparing ${n} description${n === 1 ? '' : 's'}`;
  },
  async run(ctx, input) {
    const raw = Array.isArray(input.items) ? input.items as Array<Record<string, unknown>> : [];
    if (!raw.length) throw new ToolError('Give at least one item.');
    if (raw.length > MAX_DESCRIPTION_ITEMS) throw new ToolError(`At most ${MAX_DESCRIPTION_ITEMS} items in one proposal — split the rest into a second one.`);
    const items: CoworkerDescriptionItem[] = [];
    const seen = new Set<string>();
    let unchanged = 0;
    for (const it of raw) {
      const target = TARGETS.find((x) => x === it.target);
      if (!target) throw new ToolError('Each item needs a target: source-table, source-column, subject-table or subject-column.');
      const field = it.field === 'display_name' ? 'display_name' : 'description';
      const id = posInt(it, 'id');
      const after = text(it, 'text', field === 'display_name' ? 120 : 1200);
      const cur = await currentText(ctx, target, id);
      const key = `${target}:${cur.id}:${field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const before = field === 'display_name' ? cur.display_name : cur.description;
      if (same(before, after)) { unchanged++; continue; }
      items.push({ target, id: cur.id, label: cur.label, field, before, after });
    }
    if (!items.length) throw new ToolError('Every text you gave is already what is stored — nothing to propose.');
    const proposal: CoworkerProposal = { id: randomUUID(), kind: 'descriptions', items };
    return {
      proposal,
      detail: `${items.length} change${items.length === 1 ? '' : 's'}${unchanged ? ` · ${unchanged} already right` : ''}`,
      result: { proposed: true, changes: items.length, already_right: unchanged || undefined },
    };
  },
};

// ─── metrics ────────────────────────────────────────────────────────────────

/** A formula as the stored full SELECT, trimmed of a trailing semicolon. */
function formulaSql(s: string): string {
  return s.trim().replace(/;+\s*$/, '');
}

function show(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return clip(v, 80);
}

/**
 * Run the formula on the subject's data (the dashboards' own read path: the
 * SQL guard and data policies apply) and report its first value.
 */
type FormulaCheck = Extract<CoworkerProposal, { kind: 'metric' }>['check'];

export async function runFormula(ctx: ToolContext, connectionId: number, sql: string): Promise<FormulaCheck> {
  const r = await internalCall(ctx.caller, 'POST', '/dashboards/execute', {
    connectionId, sql: `SELECT * FROM (${formulaSql(sql)}) AS _metric LIMIT 1`,
  });
  if (!r.ok) return { ran: true, ok: false, error: r.detail ? `${r.error} (${r.detail})` : r.error };
  const row = (r.data?.rows ?? [])[0] as Record<string, unknown> | undefined;
  const value = row ? show(Object.values(row)[0]) : null;
  return { ran: true, ok: true, value };
}

const proposeMetric: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_metric',
    description: 'Propose a NEW metric for a subject, or a change to an existing one (pass kpi_id — open_subject lists them). The formula is a full SELECT returning one number, e.g. "SELECT SUM(open_amount) FROM fact_receivables"; it is run on the data first and the person sees the result. Fields you leave out stay as they are.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'integer' },
        subject: { type: 'string', description: 'The subject\'s name, when you have no product_id.' },
        kpi_id: { type: 'integer', description: 'Only to change an existing metric.' },
        name: { type: 'string' },
        description: { type: 'string', description: 'What the metric means, in one or two sentences.' },
        formula_sql: { type: 'string' },
        formula_plain_text: { type: 'string', description: 'The formula in words, e.g. "Sum of open invoice amounts".' },
        question_text: { type: 'string', description: 'The question it answers, in the first person: "Who owes me money right now?"' },
      },
      additionalProperties: false,
    },
  },
  label: (i) => `Preparing the metric “${clip(i.name ?? 'metric', 40)}”`,
  async run(ctx, input) {
    const byId = optPosInt(input, 'product_id');
    const subject = text(input, 'subject', 120, false);
    if (!byId && !subject) throw new ToolError('Give product_id or subject.');
    const productId = byId ?? await subjectIdByName(ctx, subject);
    const p = await get(ctx, `/products/${productId}`);
    const kpis = ((await get(ctx, `/products/${productId}/kpis`)) ?? []) as Array<Record<string, unknown>>;
    const kpiId = optPosInt(input, 'kpi_id');
    const existing = kpiId ? kpis.find((k) => Number(k.id) === kpiId) : undefined;
    if (kpiId && !existing) throw new ToolError(`There is no metric ${kpiId} in ${p?.name}. open_subject lists its metrics with ids.`);

    const opt = (k: string, max: number) => (typeof input[k] === 'string' ? text(input, k, max, false) : undefined);
    const name = opt('name', 120);
    if (!existing && !name) throw new ToolError('A new metric needs a name.');
    const cur = {
      name: String(existing?.name ?? ''),
      description: (existing?.description as string | null) ?? null,
      formula_sql: (existing?.formula_sql as string | null) ?? null,
      formula_plain_text: (existing?.formula_plain_text as string | null) ?? null,
      question_text: (existing?.question_text as string | null) ?? null,
    };
    const orNull = (v: string | undefined, fallback: string | null) => (v === undefined ? fallback : (v || null));
    const values = {
      name: name || cur.name,
      description: orNull(opt('description', 1000), cur.description),
      formula_sql: orNull(opt('formula_sql', 4000), cur.formula_sql),
      formula_plain_text: orNull(opt('formula_plain_text', 500), cur.formula_plain_text),
      question_text: orNull(opt('question_text', 200), cur.question_text),
    };
    if (!existing && kpis.some((k) => norm(k.name) === norm(values.name))) {
      const twin = kpis.find((k) => norm(k.name) === norm(values.name));
      throw new ToolError(`${p?.name} already has a metric called "${values.name}" (kpi_id ${twin?.id}) — pass kpi_id to change it.`);
    }
    const changes = fieldChanges([
      ['Name', existing ? cur.name : null, values.name],
      ['What it means', cur.description, values.description],
      ['Formula', cur.formula_sql, values.formula_sql],
      ['Formula in words', cur.formula_plain_text, values.formula_plain_text],
      ['Question it answers', cur.question_text, values.question_text],
    ]);
    if (!changes.length) throw new ToolError('That is exactly what the metric says already.');

    const connectionId = Number(p?.connection_id ?? 0);
    const check: FormulaCheck = values.formula_sql && connectionId > 0
      ? await runFormula(ctx, connectionId, values.formula_sql)
      : { ran: false, ok: false };
    const proposal: CoworkerProposal = {
      id: randomUUID(), kind: 'metric', productId, productName: String(p?.name ?? ''),
      kpiId: existing ? Number(existing.id) : null, name: values.name, values, changes, check,
    };
    return {
      proposal,
      focus: { kind: 'subject', productId },
      detail: !check.ran ? 'no formula to run' : check.ok ? `formula runs${ctx.rowsAllowed && check.value != null ? ` · ${check.value}` : ''}` : 'formula does not run yet',
      result: {
        proposed: true,
        formula: !check.ran ? 'not run' : check.ok ? (ctx.rowsAllowed ? { runs: true, first_value: check.value } : { runs: true }) : { runs: false, error: check.error },
      },
    };
  },
};

// ─── glossary: change an existing term ──────────────────────────────────────

const proposeGlossaryChange: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_glossary_change',
    description: 'Propose a change to a glossary term that already exists: its name, its meaning, and/or what it points at (links replace the old ones). Pass only what changes. list_definitions shows the terms.',
    input_schema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'The existing term, as it is written now.' },
        new_term: { type: 'string', description: 'Only to rename it.' },
        meaning: { type: 'string' },
        links: {
          type: 'array', maxItems: 8,
          description: 'The complete new set of links (an empty list removes them all).',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['column', 'table', 'kpi'] },
              table: { type: 'string' }, column: { type: 'string' }, kpi: { type: 'string' },
            },
            required: ['kind'],
          },
        },
      },
      required: ['term'],
      additionalProperties: false,
    },
  },
  label: (i) => `Preparing a change to “${clip(i.term, 40)}”`,
  async run(ctx, input) {
    const termName = text(input, 'term', 120);
    const all = ((await get(ctx, '/semantic/glossary')) ?? []) as Array<Record<string, unknown>>;
    const row = all.find((t) => norm(t.term) === norm(termName));
    if (!row) throw new ToolError(`There is no term "${termName}". Terms here: ${all.slice(0, 30).map((t) => t.term).join(', ') || 'none'}. To add it, use propose_glossary_term.`);
    const before = { term: String(row.term ?? ''), meaning: String(row.meaning ?? ''), links: normalizeLinks(row.links) };
    const newTerm = text(input, 'new_term', 120, false);
    const meaning = text(input, 'meaning', 1200, false);
    const links = Array.isArray(input.links) ? normalizeLinks(input.links) : before.links;
    if (newTerm && norm(newTerm) !== norm(before.term) && all.some((t) => norm(t.term) === norm(newTerm))) {
      throw new ToolError(`"${newTerm}" is already another term.`);
    }
    await checkGlossaryLinks(ctx, Array.isArray(input.links) ? links : []);
    const after = { term: newTerm || before.term, meaning: meaning || before.meaning, links };
    const changes = fieldChanges([
      ['Term', before.term, after.term],
      ['Meaning', before.meaning, after.meaning],
      ['Points at', before.links.map(linkText).join(', ') || null, after.links.map(linkText).join(', ') || null],
    ]);
    if (!changes.length) throw new ToolError('That is exactly what the term says already.');
    const proposal: CoworkerProposal = { id: randomUUID(), kind: 'glossary-edit', termId: Number(row.id), term: before.term, changes, before, after };
    return { proposal, focus: { kind: 'definitions' }, detail: changes.map((c) => c.field.toLowerCase()).join(', '), result: { proposed: true } };
  },
};

// ─── relationships that already exist ───────────────────────────────────────

const CARD: Record<string, string> = {
  one_to_one: 'one to one', one_to_many: 'one to many', many_to_one: 'many to one', many_to_many: 'many to many',
};

const proposeRelationshipReview: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_relationship_review',
    description: 'Propose a decision on a relationship that already exists (by id): "confirm" it (optionally with the right shape), "flag" it as not holding (Ask AI stops joining on it; give the reason), or "unflag" it. It is measured on the data first. To change which COLUMNS it joins, flag it and propose_relationship the right one instead.',
    input_schema: {
      type: 'object',
      properties: {
        relationship_id: { type: 'integer' },
        action: { type: 'string', enum: ['confirm', 'flag', 'unflag'] },
        reason: { type: 'string', description: 'One sentence the person reads — for a flag, why it does not hold.' },
        relationship_type: { type: 'string', enum: Object.keys(CARD), description: 'Only with confirm, when the stored shape is wrong.' },
      },
      required: ['relationship_id', 'action', 'reason'],
      additionalProperties: false,
    },
  },
  label: (i) => (i.action === 'flag' ? 'Preparing to flag a relationship' : i.action === 'unflag' ? 'Preparing to unflag a relationship' : 'Preparing to confirm a relationship'),
  async run(ctx, input) {
    const id = posInt(input, 'relationship_id');
    const action = input.action === 'flag' || input.action === 'unflag' ? input.action : 'confirm';
    const reason = text(input, 'reason', 400);
    const rel = await loadRelationship(ctx, id);
    if (!rel) throw new ToolError('Not found in this workspace.');
    const flagged = !!rel.flagged_at;
    const confirmed = !!rel.confirmed_by_user || rel.ai_draft === false;
    const wantType = action === 'confirm' && typeof input.relationship_type === 'string' && CARD[input.relationship_type]
      ? input.relationship_type : null;
    const typeChanges = wantType && wantType !== rel.relationship_type;
    if (action === 'flag' && flagged) throw new ToolError('It is already flagged.');
    if (action === 'unflag' && !flagged) throw new ToolError('It is not flagged.');
    if (action === 'confirm' && confirmed && !typeChanges) throw new ToolError('It is already confirmed.');

    const status = (isFlagged: boolean, isConfirmed: boolean) => (isFlagged
      ? 'Flagged — Ask AI does not join on it'
      : isConfirmed ? 'Confirmed — Ask AI joins on it' : 'A suggestion — waiting for review');
    // Confirming does not unflag, and flagging does not un-confirm: each act
    // moves exactly one of the two, as the routes do.
    const flaggedAfter = action === 'flag' ? true : action === 'unflag' ? false : flagged;
    const confirmedAfter = action === 'confirm' ? true : confirmed;
    const changes: CoworkerFieldChange[] = fieldChanges([
      ['Status', status(flagged, confirmed), status(flaggedAfter, confirmedAfter)],
      ['Shape', CARD[String(rel.relationship_type)] ?? (rel.relationship_type as string | null) ?? null, typeChanges ? CARD[wantType!] : CARD[String(rel.relationship_type)] ?? (rel.relationship_type as string | null) ?? null],
      ['Why', flagged ? (rel.flagged_reason as string | null) ?? null : null, action === 'flag' ? reason : action === 'unflag' ? null : flagged ? (rel.flagged_reason as string | null) ?? null : null],
    ]);

    let measurement: Measurement | null = null;
    const measurable = rel.from_column_id && rel.to_column_id && (rel.kind ?? 'join') === 'join';
    if (measurable && action !== 'unflag') {
      measurement = toMeasurement(await post(ctx, '/relationships/measure', {
        fromTableId: Number(rel.from_table_id), fromColumnId: Number(rel.from_column_id),
        toTableId: Number(rel.to_table_id), toColumnId: Number(rel.to_column_id),
      }));
    }
    const fromTableId = Number(rel.from_table_id);
    const label = `${rel.from_table}.${rel.from_column ?? '?'} → ${rel.to_table}.${rel.to_column ?? '?'}`;
    const proposal: CoworkerProposal = {
      id: randomUUID(), kind: 'relationship-review', relationshipId: id, fromTableId, label, action, reason, changes,
      relationshipType: typeChanges ? wantType : null, measurement,
    };
    const ratio = measurement?.containment?.ratio;
    return {
      proposal,
      focus: { kind: 'relations', tableId: fromTableId, relationshipId: id },
      detail: measurement ? `${measurement.verdict}${typeof ratio === 'number' ? ` · ${Math.round(ratio * 100)}% of values found` : ''}` : action,
      result: { proposed: true, verdict: measurement?.verdict, containment: ratio, measured_type: measurement?.cardinality?.type },
    };
  },
};

export const DEFINITION_TOOLS: CoworkerTool[] = [
  proposeDescriptions, proposeMetric, proposeGlossaryChange, proposeRelationshipReview,
];
