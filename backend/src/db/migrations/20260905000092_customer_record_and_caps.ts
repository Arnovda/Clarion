import type { Knex } from 'knex';

/**
 * P0-8 — a CUSTOMER RECORD on `tenants`, and caps on what is not AI.
 *
 * Billing is manual invoices for now (owner decision, 2026-09-01). A Belgian
 * B2B invoice still needs the legal name, address and BTW/VAT number, and
 * the operator needs to know what was bought (plan, seats, sources) — until
 * this migration that lived in an inbox, unlinked to a tenant id.
 *
 * Every column is nullable. NULL on a cap means UNLIMITED — the meaning
 * `monthly_token_budget` has carried since it shipped, so existing tenants
 * are unchanged by this migration; self-registration stamps defaults
 * (services/signup.ts) the same way it stamps the token budget.
 *
 * `trial_ends_at` is informational: the console shows it, the operator
 * decides (Suspend). Nothing auto-suspends on it — a lockout is a
 * commercial act, not a cron job.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenants', (t) => {
    t.text('plan').nullable();                  // free text: 'trial', 'starter', 'team', …
    t.integer('seats').nullable();              // cap on ACTIVE users; NULL = unlimited
    t.integer('max_connections').nullable();    // cap on connections (sources); NULL = unlimited
    t.timestamp('trial_ends_at', { useTz: true }).nullable();
    t.text('billing_contact').nullable();       // invoice recipient (email or name <email>)
    t.text('legal_name').nullable();
    t.text('vat_number').nullable();            // BTW/BCE number, stored as typed
    t.text('address').nullable();               // free text, multi-line
  });
  await knex.raw(`ALTER TABLE tenants ADD CONSTRAINT tenants_seats_nonneg CHECK (seats IS NULL OR seats >= 0)`);
  await knex.raw(`ALTER TABLE tenants ADD CONSTRAINT tenants_max_connections_nonneg CHECK (max_connections IS NULL OR max_connections >= 0)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_seats_nonneg`);
  await knex.raw(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_max_connections_nonneg`);
  await knex.schema.alterTable('tenants', (t) => {
    t.dropColumn('plan');
    t.dropColumn('seats');
    t.dropColumn('max_connections');
    t.dropColumn('trial_ends_at');
    t.dropColumn('billing_contact');
    t.dropColumn('legal_name');
    t.dropColumn('vat_number');
    t.dropColumn('address');
  });
}
