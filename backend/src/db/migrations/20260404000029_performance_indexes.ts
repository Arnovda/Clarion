/**
 * Performance indexes — add missing indexes for frequently-queried columns.
 * These speed up list endpoints, RLS filtering, and admin log views.
 */
import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Dashboards: list by user, filter by folder, sort by favorite/updated
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dashboards_user_id ON dashboards (user_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dashboards_folder ON dashboards (folder) WHERE folder IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dashboards_shared ON dashboards (is_shared) WHERE is_shared = true`);

  // Conversations: list by user, sort by updated
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations (user_id, updated_at DESC)`);

  // Query log: admin view sorted by created_at
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_query_log_created ON query_log (created_at DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_query_log_flagged ON query_log (was_flagged) WHERE was_flagged = true`);

  // Definition gaps: admin view sorted by resolved + hit_count
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_definition_gaps_resolved ON definition_gaps (resolved, hit_count DESC)`);

  // Notifications: list by user, filter unread
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id, read) WHERE read = false`);

  // Data products: list sorted by created_at
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_data_products_created ON data_products (created_at DESC)`);

  // Star schemas: FK lookup for product count subquery
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_star_schemas_product ON star_schemas (data_product_id)`);

  // Product tables: FK lookups
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_product_tables_schema ON product_tables (star_schema_id)`);

  // Source tables: connection lookup (used by semantic layer queries)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_source_tables_conn ON source_tables (connection_id)`);

  // Source columns: table lookup
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_source_columns_table ON source_columns (table_id)`);

  // Field profiles: profile lookup
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_field_profiles_profile ON field_profiles (profile_id)`);

  // Quality score history: trend queries
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_quality_history_lookup ON quality_score_history (connection_id, table_name, score_date DESC)`);
}

export async function down(knex: Knex): Promise<void> {
  const indexes = [
    'idx_dashboards_user_id', 'idx_dashboards_folder', 'idx_dashboards_shared',
    'idx_conversations_user_updated',
    'idx_query_log_created', 'idx_query_log_flagged',
    'idx_definition_gaps_resolved',
    'idx_notifications_user', 'idx_notifications_unread',
    'idx_data_products_created',
    'idx_star_schemas_product',
    'idx_product_tables_schema',
    'idx_source_tables_conn',
    'idx_source_columns_table',
    'idx_field_profiles_profile',
    'idx_quality_history_lookup',
  ];
  for (const idx of indexes) {
    await knex.raw(`DROP INDEX IF EXISTS ${idx}`);
  }
}
