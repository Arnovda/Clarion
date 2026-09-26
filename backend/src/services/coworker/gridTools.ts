/**
 * "Your tables" — the managed grids (budgets, mappings, lists) — for the
 * coworker: read them, and PROPOSE a new one or changes to its rows.
 *
 * A grid's CONTENTS are the customer's data like any other rows: they reach
 * the model only when the tenant's AI routing allows rows (`rowsAllowed`).
 * Otherwise the coworker still sees the structure and the coverage counts, and
 * can propose ADDING rows (e.g. the values a mapping is missing) — it just
 * cannot read, change or remove what is there.
 *
 * Keep for rows re-reads the grid and refuses when it moved since the
 * proposal (someone edited it meanwhile) — a full-replacement save must never
 * overwrite a person's edit it did not see.
 */
import { randomUUID } from 'crypto';
import type { CoworkerGridRow, CoworkerProposal } from '../../shared/contract';
import {
  type CoworkerTool, type ToolContext, ToolError, clip, posInt, text, get, norm,
} from './toolKit';

interface GridColumn { key: string; name: string; type: 'text' | 'number' | 'date' | 'boolean'; link?: { table: string; column: string } | null }
interface Grid {
  id: number; name: string; kind: string; viewName: string; description: string | null;
  columns: GridColumn[]; rowCount: number | null; updatedAt: string | null; materializeError: string | null;
  rows?: Array<{ id: number; data: CoworkerGridRow }>;
}

/** The most rows a rows proposal carries (both versions travel to the card). */
const MAX_GRID_ROWS = 2000;
const MAX_ROW_CHANGES = 200;
const SHOWN_ROWS = 150;

async function loadGrid(ctx: ToolContext, gridId: number): Promise<Grid> {
  return (await get(ctx, `/grids/${gridId}`)) as Grid;
}

async function gridIdByName(ctx: ToolContext, name: string): Promise<number> {
  const grids = ((await get(ctx, '/grids')) ?? []) as Grid[];
  const want = norm(name);
  const hit = grids.filter((g) => norm(g.name) === want || norm(g.viewName) === want);
  if (hit.length === 1) return Number(hit[0].id);
  const partial = grids.filter((g) => norm(g.name).includes(want));
  if (partial.length === 1) return Number(partial[0].id);
  throw new ToolError(`No single one of "Your tables" matches "${name}". There are: ${grids.map((g) => `${g.name} (grid_id ${g.id})`).join(', ') || 'none'}.`);
}

function gridIdFrom(ctx: ToolContext, input: Record<string, unknown>): Promise<number> {
  if (input.grid_id !== undefined && input.grid_id !== null && input.grid_id !== '') return Promise.resolve(posInt(input, 'grid_id'));
  const name = text(input, 'name', 120, false);
  if (!name) throw new ToolError('Give grid_id or name.');
  return gridIdByName(ctx, name);
}

const listYourTables: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'list_your_tables',
    description: '"Your tables": the budgets, mappings and lists people keep in Clarion. Each with grid_id, its columns (and which subject column a column contains), its row count, and the name Ask AI uses for it (grid_...).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  label: () => 'Reading your tables',
  async run(ctx) {
    const grids = ((await get(ctx, '/grids')) ?? []) as Grid[];
    return {
      detail: `${grids.length} table(s)`,
      result: grids.slice(0, 60).map((g) => ({
        grid_id: g.id, name: g.name, kind: g.kind, in_answers_as: g.viewName, rows: g.rowCount ?? 0,
        columns: g.columns.map((c) => ({ name: c.name, type: c.type, contains: c.link ? `${c.link.table}.${c.link.column}` : undefined })),
        problem: g.materializeError ? clip(g.materializeError, 160) : undefined,
      })),
    };
  },
};

const openYourTable: CoworkerTool = {
  kind: 'read',
  definition: {
    name: 'open_your_table',
    description: 'Open one of "Your tables" by grid_id or name: its columns, how well a mapping covers the subject column it points at (e.g. 42 of 57 customers mapped), and — where this workspace allows the AI to read rows — its rows, numbered. The screen follows.',
    input_schema: {
      type: 'object',
      properties: { grid_id: { type: 'integer' }, name: { type: 'string' } },
      additionalProperties: false,
    },
  },
  label: (i) => (i.name ? `Opening ${clip(i.name, 40)}` : 'Opening your table'),
  resultLimit: 12_000,
  async run(ctx, input) {
    const gridId = await gridIdFrom(ctx, input);
    const g = await loadGrid(ctx, gridId);
    const linked = g.columns.some((c) => c.link);
    const coverage = linked ? ((await get(ctx, `/grids/${gridId}/coverage`).catch(() => null))?.columns ?? []) as Array<Record<string, unknown>> : []; // non-db: a loopback HTTP call
    const rows = g.rows ?? [];
    return {
      focus: { kind: 'grid', gridId },
      detail: `${g.name} · ${rows.length} row(s)`,
      result: {
        grid_id: g.id, name: g.name, kind: g.kind, in_answers_as: g.viewName,
        columns: g.columns.map((c) => ({ key: c.key, name: c.name, type: c.type, contains: c.link ? `${c.link.table}.${c.link.column}` : undefined })),
        coverage: coverage.map((c) => ({
          column: c.key, status: c.status, total: c.total, mapped: c.matched,
          ...(ctx.rowsAllowed && Array.isArray(c.missing) && c.missing.length ? { some_missing: (c.missing as string[]).slice(0, 25) } : {}),
        })),
        row_count: rows.length,
        ...(ctx.rowsAllowed
          ? { rows: rows.slice(0, SHOWN_ROWS).map((r, i) => ({ row: i + 1, ...r.data })), rows_shown: Math.min(SHOWN_ROWS, rows.length) }
          : { rows: 'Not shown: this workspace keeps row data away from the AI. You can still propose ADDING rows.' }),
      },
    };
  },
};

const proposeNewGrid: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_new_grid',
    description: 'Propose a new one of "Your tables": a mapping (e.g. account → cash-flow category), a budget, or a list. A column can CONTAIN the values of a subject column (link) — for a mapping, the first such column is what gets mapped, and seed_from_link starts the table with one row per value.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A business name, e.g. "Cash flow categories".' },
        kind: { type: 'string', enum: ['mapping', 'budget', 'list'] },
        description: { type: 'string' },
        columns: {
          type: 'array', minItems: 1, maxItems: 40,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['text', 'number', 'date', 'boolean'] },
              link_table: { type: 'string', description: 'The subject table whose column this contains (technical name).' },
              link_column: { type: 'string' },
            },
            required: ['name', 'type'],
          },
        },
        seed_from_link: { type: 'boolean', description: 'Start with one row per distinct value of the first linked column.' },
      },
      required: ['name', 'kind', 'description', 'columns'],
      additionalProperties: false,
    },
  },
  label: (i) => `Preparing a new table “${clip(i.name, 40)}”`,
  async run(ctx, input) {
    const name = text(input, 'name', 80);
    const gridKind = input.kind === 'budget' || input.kind === 'list' ? input.kind : 'mapping';
    const description = text(input, 'description', 500);
    const grids = ((await get(ctx, '/grids')) ?? []) as Grid[];
    if (grids.some((g) => norm(g.name) === norm(name))) throw new ToolError(`There already is a table called "${name}".`);
    const raw = Array.isArray(input.columns) ? input.columns as Array<Record<string, unknown>> : [];
    if (!raw.length) throw new ToolError('Give at least one column.');
    if (raw.length > 40) throw new ToolError('At most 40 columns.');
    const linkable = raw.some((c) => c.link_table) ? ((await get(ctx, '/grids/linkable-columns')) ?? []) as Array<{ tableName: string; columns: Array<{ name: string }> }> : [];
    const names = new Set<string>();
    const columns = raw.map((c) => {
      const colName = text(c, 'name', 80);
      if (names.has(norm(colName))) throw new ToolError(`Two columns are called "${colName}".`);
      names.add(norm(colName));
      const type = (['text', 'number', 'date', 'boolean'] as const).find((t) => t === c.type) ?? 'text';
      let link: { table: string; column: string } | null = null;
      if (typeof c.link_table === 'string' && c.link_table) {
        const t = linkable.find((x) => x.tableName === c.link_table);
        const column = String(c.link_column ?? '');
        if (!t || !t.columns.some((x) => x.name === column)) {
          throw new ToolError(`${c.link_table}.${column} is not a subject column a table can contain. Lookup columns (names, codes, categories) of built subjects can.`);
        }
        if (type !== 'text') throw new ToolError(`"${colName}" contains ${c.link_table}.${column}, so it must be a text column.`);
        link = { table: c.link_table, column };
      }
      return { name: colName, type, link };
    });
    const seedFromLink = input.seed_from_link === true && columns.some((c) => c.link);
    const proposal: CoworkerProposal = { id: randomUUID(), kind: 'grid-new', name, gridKind, description, columns, seedFromLink };
    return { proposal, detail: `${columns.length} column(s)${seedFromLink ? ' · pre-filled' : ''}`, result: { proposed: true } };
  },
};

const proposeGridRows: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_grid_rows',
    description: 'Propose rows to ADD to one of "Your tables", and — where you can read its rows — rows to CHANGE or REMOVE (by the row numbers open_your_table shows). Values are keyed by column name. The person sees exactly which rows change.',
    input_schema: {
      type: 'object',
      properties: {
        grid_id: { type: 'integer' },
        name: { type: 'string', description: 'When you have no grid_id.' },
        add: { type: 'array', items: { type: 'object', description: 'Column name → value.' }, maxItems: MAX_ROW_CHANGES },
        change: {
          type: 'array', maxItems: MAX_ROW_CHANGES,
          items: { type: 'object', properties: { row: { type: 'integer' }, values: { type: 'object' } }, required: ['row', 'values'] },
        },
        remove: { type: 'array', items: { type: 'integer' }, maxItems: MAX_ROW_CHANGES },
      },
      additionalProperties: false,
    },
  },
  label: () => 'Preparing changes to the rows',
  async run(ctx, input) {
    const gridId = await gridIdFrom(ctx, input);
    const g = await loadGrid(ctx, gridId);
    const current = (g.rows ?? []).map((r) => r.data);
    if (current.length > MAX_GRID_ROWS) throw new ToolError(`This table has ${current.length} rows — too many to change from here. Edit it on its own page.`);
    const add = Array.isArray(input.add) ? input.add as Array<Record<string, unknown>> : [];
    const change = Array.isArray(input.change) ? input.change as Array<Record<string, unknown>> : [];
    const remove = Array.isArray(input.remove) ? (input.remove as unknown[]).map(Number) : [];
    if (!add.length && !change.length && !remove.length) throw new ToolError('Give rows to add, change or remove.');
    if (add.length + change.length + remove.length > MAX_ROW_CHANGES) throw new ToolError(`At most ${MAX_ROW_CHANGES} row changes in one proposal.`);
    if ((change.length || remove.length) && !ctx.rowsAllowed) {
      throw new ToolError('This workspace keeps row data away from the AI, so you cannot change or remove rows — only add them.');
    }

    // Values arrive keyed by column NAME (what the model reads); rows are
    // stored by column KEY. Unknown names are refused rather than dropped.
    const keyOf = new Map<string, string>();
    for (const c of g.columns) { keyOf.set(norm(c.name), c.key); keyOf.set(norm(c.key), c.key); }
    const toRow = (values: Record<string, unknown>, base: CoworkerGridRow = {}): CoworkerGridRow => {
      const out: CoworkerGridRow = { ...base };
      for (const [k, v] of Object.entries(values ?? {})) {
        const key = keyOf.get(norm(k));
        if (!key) throw new ToolError(`"${g.name}" has no column "${k}". Its columns: ${g.columns.map((c) => c.name).join(', ')}.`);
        out[key] = v === undefined ? null : (typeof v === 'object' && v !== null ? JSON.stringify(v) : v as string | number | boolean | null);
      }
      return out;
    };
    const rowNo = (n: unknown) => {
      const i = Number(n);
      if (!Number.isInteger(i) || i < 1 || i > current.length) throw new ToolError(`There is no row ${String(n)} (the table has ${current.length}).`);
      return i - 1;
    };

    const after: Array<CoworkerGridRow | null> = current.map((r) => ({ ...r }));
    const diff: Extract<CoworkerProposal, { kind: 'grid-rows' }>['diff'] = [];
    for (const c of change) {
      const i = rowNo(c.row);
      const next = toRow(c.values as Record<string, unknown>, after[i] ?? {});
      if (JSON.stringify(next) === JSON.stringify(current[i])) continue;
      after[i] = next;
      diff.push({ status: 'changed', before: current[i], after: next });
    }
    for (const n of remove) {
      const i = rowNo(n);
      if (after[i] === null) continue;
      diff.push({ status: 'removed', before: current[i], after: null });
      after[i] = null;
    }
    const added = add.map((v) => toRow(v));
    for (const r of added) diff.push({ status: 'added', before: null, after: r });
    if (!diff.length) throw new ToolError('Nothing would change.');
    const rowsAfter = [...after.filter((r): r is CoworkerGridRow => r !== null), ...added];

    const proposal: CoworkerProposal = {
      id: randomUUID(), kind: 'grid-rows', gridId, gridName: g.name,
      columns: g.columns.map((c) => ({ key: c.key, name: c.name })),
      baseUpdatedAt: g.updatedAt ? String(g.updatedAt) : null,
      rowsBefore: current, rowsAfter, diff,
    };
    const n = (s: string) => diff.filter((d) => d.status === s).length;
    const parts = [n('added') && `${n('added')} added`, n('changed') && `${n('changed')} changed`, n('removed') && `${n('removed')} removed`].filter(Boolean);
    return { proposal, focus: { kind: 'grid', gridId }, detail: parts.join(' · '), result: { proposed: true, added: n('added'), changed: n('changed'), removed: n('removed') } };
  },
};

export const GRID_TOOLS: CoworkerTool[] = [listYourTables, openYourTable, proposeNewGrid, proposeGridRows];
