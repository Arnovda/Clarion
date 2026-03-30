import { Knex } from 'knex';

// Creates a PostgreSQL sequence used to issue stable integer pgIds for Neo4j nodes.
// Every node created in Neo4j receives a pgId drawn from this sequence so that
// existing cross-view integer FKs and query-log references remain valid across the migration.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS semantic_node_id_seq START 1`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP SEQUENCE IF EXISTS semantic_node_id_seq`);
}
