/**
 * Query starters service — generates personalised "Try asking…" prompts
 * for the /query empty state.
 *
 * Cached in-process per tenant for 24h so we don't burn tokens on every
 * /query page load. Cache invalidates when:
 *   - the tenant's KPI list changes (manual flush via clearStartersCache)
 *   - 24h elapses (lazy)
 *   - process restart (no persistence yet — fine; first /query hit
 *     after deploy regenerates)
 *
 * The cache is intentionally per-tenant (not per-user) because the
 * starters are derived from the tenant's products, not the user's
 * preferences. Pulse / personal context is layered later.
 */

import { tenantQuery } from './tenantQuery';
import { logger } from '../utils/logger';
import {
  type QueryStartersContext,
  type QueryStartersResult,
} from '../ai/prompts/queryStartersPrompt';

interface CacheEntry {
  result: QueryStartersResult;
  expiresAt: number;
}

const CACHE = new Map<number, CacheEntry>();
const TTL_MS = 24 * 60 * 60 * 1000;

export async function getQueryStarters(tenantId: number): Promise<QueryStartersResult> {
  const cached = CACHE.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const ctx = await buildContext(tenantId);
  if (ctx.products.length === 0) {
    const empty: QueryStartersResult = { starters: [] };
    CACHE.set(tenantId, { result: empty, expiresAt: Date.now() + TTL_MS });
    return empty;
  }

  try {
    const { generateQueryStarters } = await import('../ai/AIService');
    const result = await generateQueryStarters(ctx);
    CACHE.set(tenantId, { result, expiresAt: Date.now() + TTL_MS });
    return result;
  } catch (err) {
    logger.warn({ err, tenantId }, 'queryStartersService: AI call failed — returning fallback');
    return { starters: defaultFallbacks(ctx) };
  }
}

export function clearStartersCache(tenantId?: number): void {
  if (tenantId) CACHE.delete(tenantId);
  else CACHE.clear();
}

// ---------------------------------------------------------------------------
// Context builder — pulls the tenant's products + KPIs + dimension
// columns. Single tenantQuery so RLS is set once.
// ---------------------------------------------------------------------------

async function buildContext(tenantId: number): Promise<QueryStartersContext> {
  return tenantQuery(tenantId, async (trx) => {
    const tenant = await trx('tenants').where({ id: tenantId }).first();

    const products = await trx('data_products')
      .whereIn('status', ['approved', 'success'])
      .select('id', 'name', 'description');

    const productIds = products.map((p) => Number(p.id));

    const kpis = productIds.length > 0
      ? await trx('product_kpis').whereIn('data_product_id', productIds)
          .select('data_product_id', 'name', 'description')
      : [];

    // Pick fact tables + their dimension columns (max 4 dims per fact
    // for prompt brevity).
    const facts = productIds.length > 0
      ? await trx('product_tables as pt')
          .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
          .whereIn('ss.data_product_id', productIds)
          .where('pt.table_role', 'fact')
          .select('pt.id', 'pt.table_name', 'ss.data_product_id')
      : [];

    const factIds = facts.map((f) => Number(f.id));
    const dims = factIds.length > 0
      ? await trx('product_columns')
          .whereIn('product_table_id', factIds)
          .where('column_role', 'dimension')
          .select('product_table_id', 'column_name')
      : [];

    const kpisByProduct = new Map<number, typeof kpis>();
    for (const k of kpis) {
      const list = kpisByProduct.get(Number(k.data_product_id)) ?? [];
      list.push(k);
      kpisByProduct.set(Number(k.data_product_id), list);
    }
    const dimsByFact = new Map<number, string[]>();
    for (const d of dims) {
      const list = dimsByFact.get(Number(d.product_table_id)) ?? [];
      list.push(String(d.column_name));
      dimsByFact.set(Number(d.product_table_id), list);
    }
    const factsByProduct = new Map<number, Array<{ tableName: string; dimensions: string[] }>>();
    for (const f of facts) {
      const list = factsByProduct.get(Number(f.data_product_id)) ?? [];
      list.push({
        tableName: String(f.table_name),
        dimensions: (dimsByFact.get(Number(f.id)) ?? []).slice(0, 4),
      });
      factsByProduct.set(Number(f.data_product_id), list);
    }

    return {
      tenantName: tenant ? String(tenant.name) : null,
      products: products.map((p) => ({
        productName: String(p.name),
        productDescription: p.description ? String(p.description) : null,
        kpis: (kpisByProduct.get(Number(p.id)) ?? []).map((k) => ({
          name: String(k.name),
          description: k.description ? String(k.description) : null,
        })),
        factTables: factsByProduct.get(Number(p.id)) ?? [],
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Fallback — when the AI call fails we want SOMETHING in the empty state.
// Uses real product/KPI names so the suggestions still feel grounded.
// ---------------------------------------------------------------------------

function defaultFallbacks(ctx: QueryStartersContext): QueryStartersContext['products'] extends infer _ ? Array<{ question: string; kind: 'trend' | 'compare' | 'rank' | 'why' | 'state' }> : never;
function defaultFallbacks(ctx: QueryStartersContext) {
  const out: Array<{ question: string; kind: 'trend' | 'compare' | 'rank' | 'why' | 'state' }> = [];
  for (const p of ctx.products.slice(0, 3)) {
    if (p.kpis.length > 0) {
      out.push({ question: `What was our ${p.kpis[0].name.toLowerCase()} last month?`, kind: 'state' });
      out.push({ question: `How has ${p.kpis[0].name.toLowerCase()} moved this year?`, kind: 'trend' });
      if (p.kpis[0]) out.push({ question: `Why did ${p.kpis[0].name.toLowerCase()} change last month?`, kind: 'why' });
    }
  }
  return out.slice(0, 6);
}
