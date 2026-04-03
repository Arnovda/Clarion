import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Tenants — each company/organization is a tenant
  await knex.schema.createTable('tenants', (table) => {
    table.increments('id').primary();
    table.text('name').notNullable();                          // Company name
    table.text('slug').notNullable().unique();                 // URL-safe identifier (e.g. "acme-bv")
    table.text('status').notNullable().defaultTo('active');    // active, suspended, deleted
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  // Users — belong to a tenant, authenticate with email + password
  await knex.schema.createTable('users', (table) => {
    table.increments('id').primary();
    table.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.text('email').notNullable();
    table.text('password_hash').notNullable();
    table.text('display_name').notNullable();
    table.text('role').notNullable().defaultTo('viewer');      // admin, analyst, viewer
    table.boolean('is_active').notNullable().defaultTo(true);
    table.text('password_reset_token');                        // hashed token for password reset
    table.timestamp('password_reset_expires', { useTz: true }); // token expiry
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    // Unique email per tenant (same person can have accounts in different tenants)
    table.unique(['tenant_id', 'email']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
  await knex.schema.dropTableIfExists('tenants');
}
