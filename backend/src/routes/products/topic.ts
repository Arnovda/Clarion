/**
 * Products router: the topic-first read model.
 *
 * `GET /api/products/:id/topic` is the ONE fetch the topic page makes on
 * mount. The topic page is the business user's front door for a subject
 * area, so it needs exactly four things and nothing else: what this is,
 * what I can ask, what I can break it down by, and whether I can trust it.
 *
 * Deliberately a separate endpoint rather than "GET /:id plus three more":
 * `GET /:id` returns every column of every table with lineage — kilobytes
 * of warehouse vocabulary for a screen that must never say the words
 * "fact", "dimension" or "star schema". Sending that to a viewer and then
 * throwing 95% of it away on the client is both slower and a leak waiting
 * to happen.
 *
 * Viewer-readable (requireAuth only). Everything it returns is already
 * visible to a viewer somewhere else in the product; `pendingChanges` is
 * a count of undeployed edits, not their content.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../../middleware/auth';
import { reqDb } from '../../db/reqDb';

const router = Router();

/** Rows the trust line is allowed to consider "fresh". */
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Cap on the break-down line — six lenses is already a long sentence. */
const MAX_DIMENSIONS = 6;

function isoOrNull(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * A dimension's business-facing label. Prefers the curated `display_name`;
 * otherwise humanises the physical name (`dim_gl_account` → "GL account")
 * because a snake_case identifier must never reach the topic page.
 */
export function dimensionLabel(tableName: string, displayName: string | null): string {
  const curated = (displayName ?? '').trim();
  if (curated) return curated;
  const bare = tableName.replace(/^(dim|lookup|ref)[_-]/i, '').replace(/[_-]+/g, ' ').trim();
  if (!bare) return tableName;
  // "gl account" → "GL account": the leading acronym is the common case and
  // reads wrong in sentence case.
  const sentence = bare.charAt(0).toUpperCase() + bare.slice(1);
  return sentence.replace(/^(Gl|Vat|Kpi|Id)\b/, (m) => m.toUpperCase());
}

/** True for the calendar dimension, which the break-down line always ends on. */
function isDateDimension(label: string, tableName: string): boolean {
  return /^(date|calendar|day)s?$/i.test(label.trim()) || /^dim[_-]?(date|calendar)$/i.test(tableName);
}

router.get('/:id/topic', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId) || productId <= 0) {
      res.status(400).json({ ok: false, error: 'Invalid product id' });
      return;
    }

    // Tenant is matched EXPLICITLY, not left to RLS. Two reasons, both in
    // CLAUDE.md: `reqDb()` falls back to the global pool whose session-level
    // `SET app.current_tenant` has a documented race, and an authorisation
    // check must not depend on which side of that race it lands. Refuse with
    // 404, never 403 — a 403 confirms the id exists and belongs to someone
    // else, and product ids come from a shared, enumerable sequence.
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ ok: false, error: 'Tenant context required' });
      return;
    }
    const product = await db('data_products')
      .where({ id: productId, tenant_id: tenantId })
      .first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const schemaIds = await db('star_schemas').where({ data_product_id: productId }).pluck('id');

    const tables = schemaIds.length
      ? await db('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .select(
            'id', 'table_name', 'display_name', 'table_role',
            'transformation_status', 'last_run_at', 'row_count', 'transformation_sql',
          )
      : [];

    const kpis = await db('product_kpis')
      .where({ data_product_id: productId })
      .orderBy('name')
      .select('id', 'name', 'description', 'question_text');

    // ── What can I ask? ────────────────────────────────────────────────────
    // The KPI's stored question phrasing is the contract; the KPI name is the
    // fallback so a product whose questions were never written still shows
    // something a person can click.
    const questions = kpis.map((k: { id: number; name: string; description: string | null; question_text: string | null }) => ({
      kpiId: k.id,
      text: (k.question_text ?? '').trim() || k.name,
      /** True when we are showing the raw KPI name — the UI may style it flatter. */
      derived: !(k.question_text ?? '').trim(),
      description: k.description,
    }));

    // ── What can I break it down by? ───────────────────────────────────────
    const dimensionTables = tables.filter((t: { table_role: string }) => t.table_role === 'dimension');
    const labelled = dimensionTables.map((t: { table_name: string; display_name: string | null }) => ({
      label: dimensionLabel(t.table_name, t.display_name),
      isDate: isDateDimension(dimensionLabel(t.table_name, t.display_name), t.table_name),
    }));
    // The calendar's OWN label is carried through rather than a hardcoded
    // "Date" — a tenant whose date dimension is called "Calendar" should read
    // its own vocabulary back, not ours.
    const dateLabel = labelled.find((d: { isDate: boolean }) => d.isDate)?.label ?? null;
    const nonDate = labelled
      .filter((d: { isDate: boolean }) => !d.isDate)
      .map((d: { label: string }) => d.label)
      .sort((a: string, b: string) => a.localeCompare(b));
    // The calendar always comes last ("…or date"): it is the lens everyone
    // reaches for and it makes the sentence scan. Everything else is capped
    // so the line stays one sentence.
    const dimensions = dateLabel
      ? [...nonDate.slice(0, MAX_DIMENSIONS - 1), dateLabel]
      : nonDate.slice(0, MAX_DIMENSIONS);

    // ── Can I trust it? ────────────────────────────────────────────────────
    const builtTables = tables.filter((t: { last_run_at: Date | string | null }) => !!t.last_run_at);
    const lastBuiltMs = builtTables.reduce((max: number, t: { last_run_at: Date | string | null }) => {
      const ms = new Date(t.last_run_at as string | Date).getTime();
      return Number.isFinite(ms) && ms > max ? ms : max;
    }, 0);
    const failedTables = tables.filter(
      (t: { transformation_status: string }) => t.transformation_status === 'error',
    ).length;

    // The source this product is attributed to — "Matches Exact Online as of…"
    // needs both the connection's NAME and when it last synced. Same
    // most-tables-contributed rule the list endpoint uses, so the topic page
    // and the catalog card never disagree about which source a topic is from.
    const contributorRows = await db('data_product_sources as dps')
      .join('source_tables as st', 'st.id', 'dps.source_table_id')
      .where('dps.data_product_id', productId)
      .select('st.connection_id as connection_id');
    const tally = new Map<number, number>();
    for (const r of contributorRows as { connection_id: number | null }[]) {
      if (!r.connection_id) continue;
      tally.set(r.connection_id, (tally.get(r.connection_id) ?? 0) + 1);
    }
    const primaryConnectionId =
      Array.from(tally.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
      ?? (product.connection_id as number | null)
      ?? null;
    const connection = primaryConnectionId != null
      ? await db('connections')
          .where({ id: primaryConnectionId })
          .select('id', 'name', 'connector_type', 'last_synced_at', 'last_ingested_at')
          .first()
      : null;

    const syncedAt = connection
      ? (connection.last_synced_at ?? connection.last_ingested_at ?? null)
      : null;
    const syncedMs = syncedAt ? new Date(syncedAt as string | Date).getTime() : 0;
    const now = Date.now();
    // Failure beats staleness: a build that errored is the more urgent thing
    // to say, even if the source synced five minutes ago.
    const state: 'ok' | 'warn' | 'err' =
      failedTables > 0 ? 'err'
        : lastBuiltMs === 0 ? 'warn'
          : (syncedMs > 0 && now - syncedMs > FRESH_WINDOW_MS) ? 'warn'
            : (now - lastBuiltMs > FRESH_WINDOW_MS) ? 'warn'
              : 'ok';

    // ── Quality, as a summary a viewer may read ────────────────────────────
    // The trust line's "see data quality" must resolve to something for a
    // viewer too — they cannot enter Manage mode, and a dead link is worse
    // than no link. Counts only: which check failed and why stays inside
    // Manage mode.
    const tableIds = tables.map((t: { id: number }) => t.id);
    const checks = tableIds.length
      ? await db('transformation_checks')
          .whereIn('product_table_id', tableIds)
          .select('status')
      : [];
    const checksTotal = checks.length;
    const checksPassing = (checks as Array<{ status: string }>)
      .filter((c) => c.status === 'pass').length;

    // ── Undeployed edits ───────────────────────────────────────────────────
    // A table is "changed but not deployed" when its deploy cell holds SQL
    // that differs from the transformation_sql the warehouse was last built
    // from. Whitespace-insensitive: reformatting is not a change a user made.
    const cells = tableIds.length
      ? await db('product_table_cells')
          .whereIn('product_table_id', tableIds)
          .where({ is_deploy_cell: true })
          .select('product_table_id', 'cell_type', 'source', 'generated_sql')
      : [];
    const sqlByTable = new Map<number, string>(
      tables.map((t: { id: number; transformation_sql: string | null }): [number, string] =>
        [t.id, normaliseSql(t.transformation_sql)]),
    );
    let pendingChanges = 0;
    for (const c of cells as Array<{ product_table_id: number; cell_type: string; source: string; generated_sql: string | null }>) {
      const cellSql = normaliseSql(c.cell_type === 'nl' ? c.generated_sql : c.source);
      if (!cellSql) continue;
      if (cellSql !== (sqlByTable.get(c.product_table_id) ?? '')) pendingChanges += 1;
    }

    res.json({
      ok: true,
      data: {
        id: product.id,
        name: product.name,
        description: product.description ?? null,
        kind: product.kind === 'reference' ? 'reference' : 'analytics',
        status: product.status,
        source: connection
          ? { id: connection.id, name: connection.name, connectorType: connection.connector_type ?? null }
          : null,
        questions,
        dimensions,
        counts: {
          // "3 tables · 5 shared lookups · 1 metric" — lookups are counted
          // separately because they are not this topic's own tables.
          tables: tables.length - dimensionTables.length,
          sharedLookups: dimensionTables.length,
          metrics: kpis.length,
        },
        freshness: {
          state,
          lastBuiltAt: lastBuiltMs > 0 ? new Date(lastBuiltMs).toISOString() : null,
          sourceSyncedAt: isoOrNull(syncedAt as Date | string | null),
          failedTables,
        },
        quality: { checksPassing, checksTotal },
        pendingChanges,
      },
    });
  } catch (err) { next(err); }
});

/** Comparison form for SQL: collapsed whitespace, lower-cased, trimmed. */
function normaliseSql(sql: string | null | undefined): string {
  return (sql ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export default router;
