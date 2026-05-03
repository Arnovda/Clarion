/**
 * Pipelines: first-class refresh definitions that span sources AND products.
 *
 * Replaces the conceptual gap between `connection_sync_schedules` (source
 * cron) and `transformation_schedules` (product cron) — neither knew the
 * upstream/downstream graph, so users had to wire two crons hoping they
 * stayed coordinated. A pipeline names a SCOPE on the dependency graph
 * (one source, one product, all-of-them, or a hand-picked subset), plus
 * one or more TRIGGERS (manual / cron / on-pipeline-complete /
 * on-source-sync-succeeded), and the runner orchestrates the whole slice
 * in topological order.
 *
 * Built-in pipelines are NOT stored — they're computed on the fly from
 * the graph (always reflect reality, no maintenance). Only USER-created
 * custom pipelines live in this table.
 *
 * Existing schedule tables stay untouched — no migration breakage. We can
 * deprecate / migrate them in a follow-up once /pipelines is the dominant
 * surface.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('pipelines', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.text('name').notNullable();
    t.text('description');

    // 'custom' for user-created. 'builtin' is reserved for any pipelines we
    // ever decide to materialise rather than compute — keeps the type union
    // open for future use.
    t.string('kind', 16).notNullable().defaultTo('custom');

    // Scope is a small JSON discriminator. Shapes:
    //   { type: 'all' }
    //   { type: 'sync-all' }                 // sources only
    //   { type: 'transform-all' }            // products only, no sync
    //   { type: 'from-source', sourceId }    // source + dependents
    //   { type: 'sync-source', sourceId }
    //   { type: 'product', productId, includeUpstreamSync, includeDownstream }
    //   { type: 'rebuild-product', productId } // transforms only
    //   { type: 'custom',
    //     sourceIds: number[], productIds: number[],
    //     includeUpstream: boolean, includeDownstream: boolean,
    //     skipSourceSync: boolean }
    t.jsonb('scope').notNullable();

    // Triggers as a list so a pipeline can fire on multiple conditions
    // without us joining a sub-table for what's almost always 1-2 rows.
    //   [{ kind: 'cron',                    cron: '0 2 * * *', tz: 'Europe/Brussels' },
    //    { kind: 'on_pipeline_complete',    pipelineId: 17 },
    //    { kind: 'on_source_sync_succeeded', sourceId: 5 }]
    t.jsonb('triggers').notNullable().defaultTo('[]');

    t.boolean('enabled').notNullable().defaultTo(true);

    // Denormalised mirror of the latest pipeline_runs row, for fast
    // list-rendering without a join.
    t.timestamp('last_run_at', { useTz: true });
    t.string('last_status', 32);

    t.text('created_by');
    t.timestamps(true, true);

    t.index(['tenant_id'], 'idx_pipelines_tenant');
  });

  await knex.schema.createTable('pipeline_runs', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();

    // Nullable so an ad-hoc "Run from pipeline list with no save" call can
    // still create a history row (we don't want to require pre-saving).
    t.integer('pipeline_id')
      .references('id').inTable('pipelines').onDelete('SET NULL');

    t.string('status', 32).notNullable(); // queued | running | succeeded | partial | failed | cancelled
    t.timestamp('queued_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('started_at', { useTz: true });
    t.timestamp('completed_at', { useTz: true });

    // 'user:42' | 'cron' | 'pipeline:17' | 'sync:5' | 'manual'
    t.string('triggered_by', 64);

    // BullMQ job id — frontend attaches via the existing
    // /bus-matrix/:jobId/stream SSE endpoint for live progress.
    t.string('job_id', 64);

    // Per-node outcome rolled up from sub-jobs:
    //   {
    //     sources: { [sourceId]: { status, syncRunId, rowCounts, warnings } },
    //     products: { [productId]: { status, results: TransformResult[] } }
    //   }
    t.jsonb('node_results');

    t.text('error_message');

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['tenant_id', 'pipeline_id', 'queued_at'], 'idx_pipeline_runs_lookup');
  });

  // RLS — only applied where the dual-role setup exists. Single-role prod
  // (Azure Postgres Flexible Server with default `databridge` only) skips
  // these and relies on application-layer tenant filtering.
  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    for (const tbl of ['pipelines', 'pipeline_runs']) {
      await knex.raw(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`);
      await knex.raw(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY`);
      await knex.raw(`
        CREATE POLICY ${tbl}_tenant ON ${tbl}
        USING (tenant_id = current_setting('app.current_tenant')::integer)
        WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
      `);
      await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tbl} TO databridge_app`);
      await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE ${tbl}_id_seq TO databridge_app`);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('pipeline_runs');
  await knex.schema.dropTableIfExists('pipelines');
}
