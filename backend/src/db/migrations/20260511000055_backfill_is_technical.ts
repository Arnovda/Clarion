/**
 * Backfill `is_technical` on existing product_columns rows.
 *
 * The flag was added by 20260508000052_create_refresh_history (as the
 * firewall for `_row_hash` and future SCD2 metadata) but new product
 * designs since then haven't set it on GUID/FK columns. The result:
 * NL→SQL queries surface UUIDs to end users (e.g. invoice GUIDs in chat
 * result tables instead of human-readable invoice numbers).
 *
 * This migration applies the same heuristic the bus-matrix builder
 * uses for newly-designed columns:
 *
 *   - column_role IN ('surrogate_key', 'foreign_key')   → technical
 *   - data_type ILIKE '%uuid%' / 'BLOB' / 'BINARY%'     → technical
 *   - column_name ends in '_key'                        → technical
 *
 * Business-meaningful natural keys (column_role='natural_key' with a
 * non-UUID type) stay non-technical. Idempotent — running again on
 * already-flagged rows is a no-op because the UPDATE filters on
 * is_technical = false.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Surrogate keys and foreign keys: always technical at this design's
  // grain. The user knows entities by their natural key (invoice_number,
  // customer_code), not by surrogate.
  await knex.raw(`
    UPDATE product_columns
       SET is_technical = TRUE
     WHERE COALESCE(is_technical, FALSE) = FALSE
       AND column_role IN ('surrogate_key', 'foreign_key')
  `);

  // UUID / binary data types: always technical. The source's GUIDs are
  // join keys, never display values.
  await knex.raw(`
    UPDATE product_columns
       SET is_technical = TRUE
     WHERE COALESCE(is_technical, FALSE) = FALSE
       AND (
         UPPER(data_type) LIKE '%UUID%'
         OR UPPER(data_type) = 'BLOB'
         OR UPPER(data_type) LIKE 'BINARY%'
       )
  `);

  // Trailing-_key heuristic: catches columns the AI tagged as 'attribute'
  // by mistake but named like a surrogate. Last-resort fallback.
  await knex.raw(`
    UPDATE product_columns
       SET is_technical = TRUE
     WHERE COALESCE(is_technical, FALSE) = FALSE
       AND column_name LIKE '%\\_key' ESCAPE '\\'
       AND column_role NOT IN ('measure', 'attribute', 'degenerate_dimension', 'natural_key')
  `);
}

export async function down(knex: Knex): Promise<void> {
  // No-op intentionally. Rolling back this backfill would put rows
  // into an inconsistent state vs newly-designed rows (which the
  // bus-matrix builder always tags). If you need to unset, do it per
  // row via the product detail panel.
}
