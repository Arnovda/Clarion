import type { Knex } from 'knex';

/**
 * Row-level provenance for the semantic layer (docs/SOURCE_ONBOARDING.md §1).
 *
 * `semantic_source` records which rung of the precedence ladder a table/column
 * description came from:
 *
 *   'declared' — harvested at runtime from the source system's own metadata
 *                API (e.g. Odoo `fields_get` labels + help texts)
 *   'curated'  — transcribed from vendor documentation into the connector
 *                package at build time
 *   'ai'       — AI-inferred (the pre-existing pipeline)
 *   NULL       — row predates provenance tracking
 *
 * Declared/curated rows land with `ai_draft = false` + approved, so they skip
 * the review queue; the UI can use this column to show "from Odoo" vs
 * "AI suggestion". Mirrored to Neo4j as `semanticSource` (dual-write contract).
 */
export async function up(knex: Knex): Promise<void> {
  const hasTables = await knex.schema.hasColumn('source_tables', 'semantic_source');
  if (!hasTables) {
    await knex.schema.alterTable('source_tables', (t) => {
      t.text('semantic_source');
    });
  }

  const hasCols = await knex.schema.hasColumn('source_columns', 'semantic_source');
  if (!hasCols) {
    await knex.schema.alterTable('source_columns', (t) => {
      t.text('semantic_source');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasTables = await knex.schema.hasColumn('source_tables', 'semantic_source');
  if (hasTables) {
    await knex.schema.alterTable('source_tables', (t) => {
      t.dropColumn('semantic_source');
    });
  }

  const hasCols = await knex.schema.hasColumn('source_columns', 'semantic_source');
  if (hasCols) {
    await knex.schema.alterTable('source_columns', (t) => {
      t.dropColumn('semantic_source');
    });
  }
}
