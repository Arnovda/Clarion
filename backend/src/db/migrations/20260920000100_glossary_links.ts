/**
 * Glossary links — a business term gets an ADDRESS in the data.
 *
 * `business_glossary` was a word list: term, meaning, examples, tags. The
 * whole list went into every AI prompt as prose and the model had to GUESS
 * which column "openstaande vordering" is — usually right, never pinned, and
 * Exact Online alone has four amount columns that look alike. `links` records
 * what the term IS in the topic layer:
 *
 *   [{ kind: 'column', table: 'fact_receivables', column: 'outstanding_amount' },
 *    { kind: 'kpi', kpi: 'Outstanding receivables' }]
 *
 * Stored BY NAME, not by id, on purpose — the same rule the managed-grid links
 * follow. A topic rebuild re-mints every product_tables / product_kpis id, so
 * an id would go stale on the first rebuild; a name survives unless the table
 * itself was renamed or dropped, and THEN the term visibly points at nothing
 * ("pick it again") instead of silently drifting. Resolution against the
 * catalog happens at read time (see services/glossaryLinks.ts); a write is
 * refused when a target does not resolve, so a typo is never stored.
 *
 * jsonb array with a default of [] — every existing term keeps working with no
 * links, and the column never reads NULL.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('business_glossary', 'links');
  if (!has) {
    await knex.schema.alterTable('business_glossary', (t) => {
      t.jsonb('links').notNullable().defaultTo('[]');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('business_glossary', 'links');
  if (has) {
    await knex.schema.alterTable('business_glossary', (t) => {
      t.dropColumn('links');
    });
  }
}
