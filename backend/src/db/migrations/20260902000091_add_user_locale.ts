import type { Knex } from 'knex';

/**
 * P2-1 (i18n) — the interface language is a USER preference, not a URL.
 *
 * Clarion is a logged-in B2B tool: locale-prefixed routes (/nl/…) would
 * churn every deep link, bookmark and emailed URL for zero benefit, while
 * "which language does this person read?" is exactly the kind of fact the
 * users row exists for. NULL means "not chosen" — the client then guesses
 * from the browser (navigator.language) without persisting, so a user who
 * never touches the switcher still gets Dutch on a Dutch machine and the
 * row records only deliberate choices.
 *
 * Values are validated at the API boundary (updateProfileSchema — only
 * locales with a COMPLETE dictionary are accepted; 'fr' joins when its
 * translation exists, not before). No CHECK constraint on purpose: adding
 * a locale must be a dictionary + enum change, never a migration.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.string('locale', 8).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('locale');
  });
}
