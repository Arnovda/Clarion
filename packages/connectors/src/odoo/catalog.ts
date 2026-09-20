/**
 * Odoo catalog — everything the connector KNOWS about the source, loaded
 * from the source package in `./package/` (`src/sourcePackage/types.ts`).
 *
 * The 21-model allowlist, the curated core-field descriptions, the
 * documented many2one foreign keys and the Kimball template used to be
 * TypeScript data in `entities.ts` / `docs.ts` / `starSchemaTemplate.ts`.
 * The facts moved to YAML; the names below stayed. The RULES (which field
 * types to skip, how an Odoo type lands in DuckDB, the role hint) are code
 * and stay in `entities.ts`.
 *
 * Odoo models are addressed by dotted names (`account.move.line`); warehouse
 * identifiers cannot contain dots, so every entity is exposed under the
 * underscore form — the dataset `name` — while the dotted MODEL name is the
 * dataset's `source` (Ossie's physical reference) and is what the RPC calls use.
 */
import * as path from 'path';
import type { EntityCursorSpec, EntityDescriptor, KnownRelationship } from '../types';
import type { StarSchemaTemplate } from '../starSchema';
import {
  loadSourcePackage,
  sourceDatasets,
  toKnownRelationships,
  toStarSchemaTemplate,
  type SourcePackage,
} from '../sourcePackage';

export const ODOO_PACKAGE: SourcePackage = loadSourcePackage(path.join(__dirname, 'package'));

export interface OdooEntity extends EntityDescriptor {
  /** Dotted Odoo model name used for RPC calls (e.g. `account.move.line`). */
  model: string;
  /** Soft context from the package (Markdown) — reaches the profiler's prompts, never a description. */
  notes?: string;
}

/**
 * model → warehouse table_name, plus the wizard's display metadata. Finance /
 * operations focused; deliberately not the thousands of technical models Odoo
 * ships. Package order is the order the wizard shows.
 */
export const ODOO_ALLOWLIST: ReadonlyArray<{ model: string; table: string; category: string; displayName: string; description: string }> =
  sourceDatasets(ODOO_PACKAGE).map((d) => {
    if (!d.source) throw new Error(`[odoo] dataset '${d.name}' has no source (the dotted model name)`);
    return {
      model: d.source,
      table: d.name,
      category: d.clarion.category ?? '',
      displayName: d.label ?? d.name,
      description: d.description ?? '',
    };
  });

/** Dotted model name → warehouse table name, for resolving many2one `relation`
 * targets from `fields_get` into relationship endpoints. */
export const MODEL_TO_TABLE: ReadonlyMap<string, string> = new Map(
  ODOO_ALLOWLIST.map((e) => [e.model, e.table]),
);

export const ODOO_ENTITIES: readonly OdooEntity[] = sourceDatasets(ODOO_PACKAGE).map((d) => {
  const cursor = d.clarion.sync?.cursor;
  const e: OdooEntity = {
    name: d.name,
    displayName: d.label,
    category: d.clarion.category,
    description: d.description,
    model: d.source as string,
    supportsIncremental: !!cursor,
  };
  if (cursor) (e as { incrementalCursor?: EntityCursorSpec }).incrementalCursor = { field: cursor.field, type: cursor.type };
  if (d.primary_key?.[0]) (e as { businessKey?: string }).businessKey = d.primary_key[0];
  if (d.clarion.notes) e.notes = d.clarion.notes;
  return e;
});

export const ENTITIES_BY_NAME: ReadonlyMap<string, OdooEntity> = new Map(
  ODOO_ENTITIES.map((e) => [e.name, e]),
);

/** EntityDescriptor projection for the wizard (keeps cursor/businessKey — Odoo
 * is transparent about incrementality, unlike the EO catalog which strips it). */
export function asEntityDescriptors(): EntityDescriptor[] {
  return ODOO_ENTITIES.map((e) => ({
    name: e.name,
    displayName: e.displayName,
    category: e.category,
    description: e.description,
    supportsIncremental: e.supportsIncremental,
    incrementalCursor: e.incrementalCursor,
    businessKey: e.businessKey,
  }));
}

/**
 * Documented many2one FKs among the allowlisted models. Column names are
 * Odoo's snake_case field names (flattened to the integer id); the target is
 * always `id`. The profiler value-verifies these, so a column absent on a
 * given Odoo version is simply dropped.
 */
export const ODOO_KNOWN_RELATIONSHIPS: readonly KnownRelationship[] = toKnownRelationships(ODOO_PACKAGE);

/**
 * Curated core-field descriptions, keyed by MODEL name then field — the
 * Tier-2 FALLBACK beneath the live `fields_get` harvest: Odoo's field
 * metadata has labels for everything but `help` tooltips only where a
 * developer wrote one. Precedence in `buildEntityDocs`: live `help` > this
 * map > the synthesised many2one sentence > the AI pipeline.
 */
export const ODOO_COLUMN_DOCS: Readonly<Record<string, Readonly<Record<string, string>>>> = (() => {
  const out: Record<string, Record<string, string>> = {};
  for (const d of sourceDatasets(ODOO_PACKAGE)) {
    if (!d.fields || d.fields.length === 0) continue;
    const fields: Record<string, string> = {};
    for (const f of d.fields) {
      if (f.description) fields[f.name] = f.description;
    }
    out[d.source as string] = fields;
  }
  return out;
})();

/** The deterministic Kimball design (version in the package). */
export const ODOO_STAR_SCHEMA_TEMPLATE: StarSchemaTemplate = (() => {
  const t = toStarSchemaTemplate(ODOO_PACKAGE);
  if (!t) throw new Error('[odoo] the source package ships no star-schema template');
  return t;
})();
