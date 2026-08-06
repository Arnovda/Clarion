/**
 * Topic-first data experience — two nullable text columns.
 *
 * `product_kpis.question_text`
 *   The topic page's "Try asking" rows are the product's KPIs rephrased as
 *   first-person questions ("Outstanding receivables" → "Who owes me money
 *   right now?"). The phrasing is STORED rather than derived in the client
 *   so a curator can edit it in Manage mode and every surface that shows a
 *   question — topic page, the table list's "Answers …" sub-line — reads the
 *   same string. NULL falls back to the KPI name.
 *
 * `product_tables.plain_summary`
 *   The "How it's built" card leads with a plain-language paragraph and
 *   treats SQL as the appendix. `description` already holds the one-line
 *   grain ("One row per general-ledger line") and is shown as the table
 *   sub-line, so the paragraph needs its own column rather than overloading
 *   that one. NULL means "not written yet" — the UI derives a provenance
 *   sentence from the transformation instead.
 *
 * Both nullable with no backfill: an absent value has a defined meaning in
 * each case, so writing a placeholder would be worse than leaving it empty.
 * No RLS/grant work needed — columns inherit the table's policy and grants.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasQuestion = await knex.schema.hasColumn('product_kpis', 'question_text');
  if (!hasQuestion) {
    await knex.schema.alterTable('product_kpis', (t) => {
      t.text('question_text');
    });
  }

  const hasSummary = await knex.schema.hasColumn('product_tables', 'plain_summary');
  if (!hasSummary) {
    await knex.schema.alterTable('product_tables', (t) => {
      t.text('plain_summary');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasQuestion = await knex.schema.hasColumn('product_kpis', 'question_text');
  if (hasQuestion) {
    await knex.schema.alterTable('product_kpis', (t) => {
      t.dropColumn('question_text');
    });
  }

  const hasSummary = await knex.schema.hasColumn('product_tables', 'plain_summary');
  if (hasSummary) {
    await knex.schema.alterTable('product_tables', (t) => {
      t.dropColumn('plain_summary');
    });
  }
}
