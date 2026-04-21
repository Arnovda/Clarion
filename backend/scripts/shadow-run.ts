/**
 * Shadow-run driver for Phase 3 Stage B validation.
 *
 * Given a product id + tenant id + an engine flag, this script:
 *   1. Resets the product's tables to a pristine pre-run state
 *     (transformation_status='draft', clears delta_path + last_run_error)
 *   2. Invokes runProductTransformation, which routes through the legacy
 *      runner OR the dbt runner based on USE_DBT_TRANSFORMATIONS.
 *   3. Reports per-table results.
 *
 * Used by scripts/compare-shadow-run.sh which invokes this twice and diffs
 * the resulting Parquet trees.
 *
 * Usage:
 *   USE_DBT_TRANSFORMATIONS=false tsx scripts/shadow-run.ts <productId> <tenantId>
 *   USE_DBT_TRANSFORMATIONS=true  tsx scripts/shadow-run.ts <productId> <tenantId>
 */

import { semanticDb } from '../src/db/knex';
import { runProductTransformation } from '../src/services/transformationRunner';

async function main() {
  const productId = Number(process.argv[2]);
  const tenantId  = Number(process.argv[3]);
  if (!productId || !tenantId) {
    console.error('Usage: tsx shadow-run.ts <productId> <tenantId>');
    process.exit(1);
  }

  const engine = process.env.USE_DBT_TRANSFORMATIONS === 'true' ? 'dbt' : 'legacy';
  console.log(`[shadow] engine=${engine} productId=${productId} tenantId=${tenantId}`);

  // Apply tenant context so RLS policies let us read/update this product.
  await semanticDb.raw(`SET app.current_tenant = '${tenantId}'`);

  const product = await semanticDb('data_products').where({ id: productId }).first();
  if (!product) throw new Error(`Product ${productId} not found (tenant ${tenantId}?)`);

  const tables = await semanticDb('product_tables as pt')
    .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
    .where('ss.data_product_id', productId)
    .select('pt.*');
  if (tables.length === 0) throw new Error(`Product ${productId} has no tables`);

  console.log(`[shadow] "${product.name}" has ${tables.length} tables`);

  // Reset pre-run state so the runner treats this as a fresh build.
  await semanticDb('product_tables')
    .whereIn('id', tables.map((t) => t.id))
    .update({
      transformation_status: 'draft',
      last_run_error: null,
      last_run_at: null,
    });

  const started = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results = await runProductTransformation(product, tables as any, tenantId);
  const elapsed = Date.now() - started;

  const succeeded = results.filter((r) => r.status === 'success').length;
  const failed    = results.filter((r) => r.status === 'error').length;
  console.log(`[shadow] engine=${engine} done in ${elapsed}ms — ${succeeded} success, ${failed} error`);
  for (const r of results) {
    const badge = r.status === 'success' ? 'OK  ' : 'FAIL';
    const rc    = r.row_count !== undefined ? `rows=${r.row_count}` : '';
    const err   = r.error ? `err="${r.error.slice(0, 120)}"` : '';
    console.log(`  [${badge}] ${r.table_name} ${rc} ${err}`);
  }

  await semanticDb.destroy();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[shadow] crashed:', err instanceof Error ? err.stack : err);
  process.exit(2);
});
