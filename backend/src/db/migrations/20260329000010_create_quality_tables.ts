import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // One row per profiling run per (connection, table)
  await knex.schema.createTable('dataset_profiles', (t) => {
    t.increments('id').primary();
    t.integer('connection_id').references('id').inTable('connections').onDelete('CASCADE');
    t.text('table_name').notNullable();
    t.integer('row_count');
    t.float('overall_score');
    t.float('completeness_score');
    t.float('validity_score');
    t.float('uniqueness_score');
    t.float('consistency_score');
    t.float('timeliness_score');
    t.float('accuracy_score');
    t.timestamp('profiled_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index(['connection_id', 'table_name']);
  });

  // Per-field statistics — one row per field per profiling run
  await knex.schema.createTable('field_profiles', (t) => {
    t.increments('id').primary();
    t.integer('profile_id').references('id').inTable('dataset_profiles').onDelete('CASCADE');
    t.text('field_name').notNullable();
    t.text('data_type');
    t.integer('null_count').defaultTo(0);
    t.float('null_pct').defaultTo(0);
    t.integer('distinct_count').defaultTo(0);
    t.float('distinct_pct').defaultTo(0);
    t.text('min_value');
    t.text('max_value');
    t.float('mean_value');
    t.float('median_value');
    t.jsonb('top_values');   // [{value, count, pct}]
    t.jsonb('histogram');    // [{label, count}]
  });

  // Configured quality rules per (connection, table)
  await knex.schema.createTable('quality_rules', (t) => {
    t.increments('id').primary();
    t.integer('connection_id').references('id').inTable('connections').onDelete('CASCADE');
    t.text('table_name').notNullable();
    t.text('rule_name').notNullable();
    // completeness | validity | uniqueness | consistency | timeliness | accuracy
    t.text('dimension').notNullable();
    t.jsonb('field_names');  // string[]
    t.text('description');
    // null_check | range | format | uniqueness | freshness | custom
    t.text('rule_type').notNullable();
    t.jsonb('rule_config');  // {threshold,min,max,pattern,sql,date_field,max_age_hours}
    t.float('pass_threshold').defaultTo(0.95);
    t.text('owner_name');
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  // One row per rule per evaluation run
  await knex.schema.createTable('rule_executions', (t) => {
    t.increments('id').primary();
    t.integer('rule_id').references('id').inTable('quality_rules').onDelete('CASCADE');
    t.timestamp('executed_at', { useTz: true }).defaultTo(knex.fn.now());
    t.float('pass_rate');
    t.integer('total_records').defaultTo(0);
    t.integer('passing_records').defaultTo(0);
    t.integer('failing_records').defaultTo(0);
    t.text('status'); // PASS | WARNING | FAIL
    t.index('rule_id');
  });

  // Individual failing records — capped at 200 per execution
  await knex.schema.createTable('quality_failures', (t) => {
    t.increments('id').primary();
    t.integer('rule_id').references('id').inTable('quality_rules').onDelete('CASCADE');
    t.integer('execution_id').references('id').inTable('rule_executions').onDelete('CASCADE');
    t.text('record_id');
    t.text('field_name');
    t.text('actual_value');
    t.text('expected_description');
    t.timestamp('first_detected', { useTz: true }).defaultTo(knex.fn.now());
    // new | known | in_remediation | resolved
    t.text('status').defaultTo('new');
    t.index('rule_id');
    t.index('execution_id');
  });

  // Daily aggregate scores — used for 90-day trend charts and dimension sparklines
  await knex.schema.createTable('quality_score_history', (t) => {
    t.increments('id').primary();
    t.integer('connection_id').references('id').inTable('connections').onDelete('CASCADE');
    t.text('table_name').notNullable();
    t.date('score_date').notNullable();
    t.float('overall_score');
    t.float('completeness_score');
    t.float('validity_score');
    t.float('uniqueness_score');
    t.float('consistency_score');
    t.float('timeliness_score');
    t.float('accuracy_score');
    t.unique(['connection_id', 'table_name', 'score_date']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('quality_score_history');
  await knex.schema.dropTableIfExists('quality_failures');
  await knex.schema.dropTableIfExists('rule_executions');
  await knex.schema.dropTableIfExists('quality_rules');
  await knex.schema.dropTableIfExists('field_profiles');
  await knex.schema.dropTableIfExists('dataset_profiles');
}
