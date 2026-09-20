/**
 * Glossary links — the place where a business term meets the data.
 *
 * A glossary entry used to be prose only. With a link it also says WHAT the
 * term is in the topic layer: a product column ("openstaande vordering" IS
 * `fact_receivables.outstanding_amount`), a whole table ("klant" IS
 * `dim_customer`) or a KPI. Three things follow, and they are the reason this
 * module exists:
 *
 *   1. The model stops guessing. The prompt can state the column as a FACT
 *      instead of a hint (see `formatLinksForPrompt`).
 *   2. It reads both ways. The catalog can show, on the column, which business
 *      words the team uses for it.
 *   3. It survives change visibly. Links are stored BY NAME (same rule as the
 *      managed-grid links): a rebuild that renames or drops the target makes
 *      the term resolve to nothing, and the screen says "pick it again"
 *      rather than the term silently pointing at the wrong thing.
 *
 * Targets live on the PRODUCT layer only (product_tables / product_columns /
 * product_kpis). That is the layer a business user sees as "topics"; a
 * source-layer link would be a later, separate kind.
 *
 * Every query here filters `tenant_id` EXPLICITLY. Callers pass either the
 * request's tenant-scoped handle or a `tenantQuery` transaction; the explicit
 * predicate is the house rule regardless (an authorization decision never
 * rides the session variable alone).
 */
import type { Knex } from 'knex';

/** Bounded: a term that means eight different columns is not a definition. */
export const GLOSSARY_MAX_LINKS = 8;

const LINK_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type GlossaryLink =
  | { kind: 'column'; table: string; column: string }
  | { kind: 'table'; table: string }
  | { kind: 'kpi'; kpi: string };

export type GlossaryLinkKind = GlossaryLink['kind'];

/** A stored link, checked against the catalog at read time. */
export interface ResolvedGlossaryLink {
  kind: GlossaryLinkKind;
  table?: string;
  column?: string;
  kpi?: string;
  /** false = the target is no longer in the catalog (renamed or dropped by a rebuild). */
  resolved: boolean;
  /** Topic (data product) the target belongs to, when resolved. */
  topic: string | null;
  /** Business label of the target (display name / KPI name), when resolved. */
  label: string | null;
}

export interface GlossaryLinkTargets {
  tables: Array<{
    topic: string;
    tableName: string;
    displayName: string | null;
    role: string | null;
    columns: Array<{ name: string; displayName: string | null; role: string | null }>;
  }>;
  kpis: Array<{ name: string; topic: string; description: string | null }>;
}

export function isValidLinkIdent(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 128 && LINK_IDENT_RE.test(s);
}

/** Identity of a link, for dedupe and for matching resolved results back. */
export function linkKey(l: { kind: string; table?: string; column?: string; kpi?: string }): string {
  switch (l.kind) {
    case 'column': return `column:${l.table}.${l.column}`;
    case 'table':  return `table:${l.table}`;
    case 'kpi':    return `kpi:${l.kpi}`;
    default:       return `${l.kind}:?`;
  }
}

/** Human form, used in refusals and in the prompt. */
export function describeLink(l: { kind: string; table?: string; column?: string; kpi?: string }): string {
  switch (l.kind) {
    case 'column': return `${l.table}.${l.column}`;
    case 'table':  return `${l.table}`;
    case 'kpi':    return `KPI "${l.kpi}"`;
    default:       return '?';
  }
}

/**
 * Tolerant parse of the stored jsonb. A malformed entry is DROPPED, never
 * thrown: a bad row must not take the glossary (and with it every AI prompt)
 * down. Writes are validated strictly at the route (Zod), so in practice this
 * only ever meets what the route stored.
 */
export function parseGlossaryLinks(value: unknown): GlossaryLink[] {
  let arr: unknown = value;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out: GlossaryLink[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (r.kind === 'column' && isValidLinkIdent(r.table) && isValidLinkIdent(r.column)) {
      out.push({ kind: 'column', table: r.table, column: r.column });
    } else if (r.kind === 'table' && isValidLinkIdent(r.table)) {
      out.push({ kind: 'table', table: r.table });
    } else if (r.kind === 'kpi' && typeof r.kpi === 'string' && r.kpi.trim() && r.kpi.length <= 200) {
      out.push({ kind: 'kpi', kpi: r.kpi.trim() });
    }
  }
  return dedupeLinks(out);
}

export function dedupeLinks(links: readonly GlossaryLink[]): GlossaryLink[] {
  const seen = new Set<string>();
  const out: GlossaryLink[] = [];
  for (const l of links) {
    const k = linkKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

interface TableRow {
  table_id: number;
  table_name: string;
  display_name: string | null;
  topic: string;
  is_shared_dimension: boolean | null;
}

/**
 * Check every link against the catalog, in three queries however many links
 * there are (tables, their columns, KPIs). A shared dimension is stubbed into
 * several products; the OWNER row (not a stub) names the topic we report.
 */
export async function resolveGlossaryLinks(
  db: Knex,
  tenantId: number,
  links: readonly GlossaryLink[],
): Promise<ResolvedGlossaryLink[]> {
  if (links.length === 0) return [];

  const tableNames = [...new Set(links.filter((l) => l.kind !== 'kpi').map((l) => (l as { table: string }).table))];
  const kpiNames = [...new Set(links.filter((l): l is { kind: 'kpi'; kpi: string } => l.kind === 'kpi').map((l) => l.kpi))];

  const tableRows: TableRow[] = tableNames.length === 0 ? [] : (await db('product_tables as pt')
    .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
    .join('data_products as dp', 'ss.data_product_id', 'dp.id')
    .where('dp.tenant_id', tenantId)
    .whereIn('pt.table_name', tableNames)
    .select(
      'pt.id as table_id',
      'pt.table_name',
      'pt.display_name',
      'dp.name as topic',
      'pt.is_shared_dimension',
    )) as TableRow[];

  // Owner first, so the topic we name is the one that BUILDS the table.
  tableRows.sort((a, b) => Number(!!a.is_shared_dimension) - Number(!!b.is_shared_dimension));
  const tablesByName = new Map<string, TableRow[]>();
  for (const r of tableRows) {
    const list = tablesByName.get(r.table_name) ?? [];
    list.push(r);
    tablesByName.set(r.table_name, list);
  }

  const columnLinks = links.filter((l): l is { kind: 'column'; table: string; column: string } => l.kind === 'column');
  const colRows: Array<{ product_table_id: number; column_name: string; display_name: string | null }> =
    columnLinks.length === 0 || tableRows.length === 0 ? [] : (await db('product_columns as pc')
      .where('pc.tenant_id', tenantId)
      .whereIn('pc.product_table_id', tableRows.map((r) => r.table_id))
      .whereIn('pc.column_name', [...new Set(columnLinks.map((l) => l.column))])
      .select('pc.product_table_id', 'pc.column_name', 'pc.display_name')) as Array<{ product_table_id: number; column_name: string; display_name: string | null }>;
  const colByTableId = new Map<string, { display_name: string | null }>();
  for (const c of colRows) colByTableId.set(`${c.product_table_id}:${c.column_name}`, { display_name: c.display_name });

  const kpiRows: Array<{ name: string; topic: string }> = kpiNames.length === 0 ? [] : (await db('product_kpis as pk')
    .join('data_products as dp', 'pk.data_product_id', 'dp.id')
    .where('dp.tenant_id', tenantId)
    .whereIn('pk.name', kpiNames)
    .select('pk.name', 'dp.name as topic')) as Array<{ name: string; topic: string }>;
  const kpiByName = new Map(kpiRows.map((k) => [k.name, k]));

  return links.map((l): ResolvedGlossaryLink => {
    if (l.kind === 'kpi') {
      const k = kpiByName.get(l.kpi);
      return { kind: 'kpi', kpi: l.kpi, resolved: !!k, topic: k?.topic ?? null, label: k ? l.kpi : null };
    }
    const candidates = tablesByName.get(l.table) ?? [];
    if (l.kind === 'table') {
      const t = candidates[0];
      return { kind: 'table', table: l.table, resolved: !!t, topic: t?.topic ?? null, label: t?.display_name ?? (t ? l.table : null) };
    }
    for (const t of candidates) {
      const c = colByTableId.get(`${t.table_id}:${l.column}`);
      if (c) {
        return { kind: 'column', table: l.table, column: l.column, resolved: true, topic: t.topic, label: c.display_name ?? l.column };
      }
    }
    return { kind: 'column', table: l.table, column: l.column, resolved: false, topic: null, label: null };
  });
}

/**
 * What a term may link to: every product table and its non-technical columns
 * (the `is_technical` firewall holds here as on every user-facing surface —
 * a raw FK id is not something a business word names), plus every KPI.
 * Grouped by topic; a shared dimension is listed once, under its owner.
 */
export async function listGlossaryLinkTargets(db: Knex, tenantId: number): Promise<GlossaryLinkTargets> {
  const rows = (await db('product_tables as pt')
    .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
    .join('data_products as dp', 'ss.data_product_id', 'dp.id')
    .join('product_columns as pc', 'pc.product_table_id', 'pt.id')
    .where('dp.tenant_id', tenantId)
    .where((qb) => qb.where('pc.is_technical', false).orWhereNull('pc.is_technical'))
    .select(
      'dp.name as topic',
      'pt.table_name',
      'pt.display_name as table_display_name',
      'pt.table_role',
      'pt.is_shared_dimension',
      'pc.column_name',
      'pc.display_name as column_display_name',
      'pc.column_role',
    )
    .orderBy([
      { column: 'pt.is_shared_dimension', order: 'asc', nulls: 'first' },
      { column: 'dp.name', order: 'asc' },
      { column: 'pt.table_name', order: 'asc' },
      { column: 'pc.column_name', order: 'asc' },
    ])) as Array<Record<string, unknown>>;

  const byTable = new Map<string, GlossaryLinkTargets['tables'][number]>();
  for (const r of rows) {
    const key = String(r.table_name);
    // First row per table wins the topic — and the sort put the OWNER (not a
    // stub) first, so a shared dim is attributed to the product that builds it.
    let t = byTable.get(key);
    if (!t) {
      t = {
        topic: String(r.topic),
        tableName: key,
        displayName: r.table_display_name == null ? null : String(r.table_display_name),
        role: r.table_role == null ? null : String(r.table_role),
        columns: [],
      };
      byTable.set(key, t);
    }
    // A stub carries a copy of the owner's columns; do not list a column twice.
    if (!t.columns.some((c) => c.name === String(r.column_name))) {
      t.columns.push({
        name: String(r.column_name),
        displayName: r.column_display_name == null ? null : String(r.column_display_name),
        role: r.column_role == null ? null : String(r.column_role),
      });
    }
  }

  const kpiRows = (await db('product_kpis as pk')
    .join('data_products as dp', 'pk.data_product_id', 'dp.id')
    .where('dp.tenant_id', tenantId)
    .select('pk.name', 'dp.name as topic', 'pk.description')
    .orderBy(['dp.name', 'pk.name'])) as Array<Record<string, unknown>>;

  const tables = [...byTable.values()].sort((a, b) =>
    a.topic.localeCompare(b.topic) || a.tableName.localeCompare(b.tableName));
  const kpis = kpiRows.map((k) => ({
    name: String(k.name),
    topic: String(k.topic),
    description: k.description == null ? null : String(k.description),
  }));
  return { tables, kpis };
}

/**
 * The prompt line for a term's links — RESOLVED links only. A link whose
 * target vanished must not send the model at a table that is not there; the
 * screen carries that warning, the prompt does not. Returns null when there
 * is nothing resolved to say.
 */
export function formatLinksForPrompt(links: readonly ResolvedGlossaryLink[]): string | null {
  const parts: string[] = [];
  for (const l of links) {
    if (!l.resolved) continue;
    const topic = l.topic ? ` (topic ${l.topic})` : '';
    if (l.kind === 'column') parts.push(`\`${l.table}.${l.column}\`${topic}`);
    else if (l.kind === 'table') parts.push(`table \`${l.table}\`${topic}`);
    else parts.push(`KPI "${l.kpi}"${topic}`);
  }
  return parts.length > 0 ? `In the data: ${parts.join(' · ')}` : null;
}
