/**
 * Exact Online catalog — everything the connector KNOWS about the source,
 * loaded from the source package in `./package/` (docs/SOURCE_ONBOARDING.md;
 * `src/sourcePackage/types.ts` for the format).
 *
 * This module used to be three files of TypeScript data — `entities.ts`
 * (61 entities + 69 curated foreign keys), `docs.ts` (2,613 transcribed
 * column descriptions) and `starSchemaTemplate.ts` (the Kimball template).
 * The facts moved to YAML; the names below stayed, so every consumer and
 * test kept its import. Regenerate the column docs with
 * `npx tsx scripts/generate-eo-docs.ts` (it rewrites `package/datasets/`).
 */
import * as path from 'path';
import type { ColumnDoc, EntityDescriptor, KnownRelationship } from '../types';
import type { StarSchemaTemplate } from '../starSchema';
import {
  loadSourcePackage,
  sourceDatasets,
  toColumnDocs,
  toKnownRelationships,
  toStarSchemaTemplate,
  type SourcePackage,
} from '../sourcePackage';

export const EXACT_ONLINE_PACKAGE: SourcePackage = loadSourcePackage(path.join(__dirname, 'package'));

export interface ExactOnlineEntity extends EntityDescriptor {
  /** Path relative to `/api/v1/{division}`, with leading slash. */
  apiPath: string;

  /**
   * EO endpoints that reject a bare listing request with HTTP 400
   * "Please add a $select or a $top=1 statement to the query string."
   * These are typically wide tables (50+ columns) where EO refuses to
   * stream the full schema unless the client declares the columns it
   * actually wants. Without this declaration the entity sync fails as
   * a warning and writes ZERO rows — the user gets an empty table in
   * the warehouse with no obvious explanation.
   *
   * When `true`, the connector DISCOVERS the field list at sync time:
   * it issues `?$top=1` to the entity (which EO always allows — that's
   * the second half of "$select OR $top=1"), reads the keys off the
   * returned row, then re-issues the actual listing with
   * `$select=<discovered fields>`. This is far more robust than
   * maintaining hand-curated field lists per entity: EO data-model
   * changes flow through automatically.
   *
   * Caveats: an entity with zero rows yields no fields and is skipped
   * (correct: nothing to sync); discovery costs one extra HTTP call per
   * affected entity per sync; fields absent from row #1 are missed (EO's
   * wide entities return all columns on every row, NULL when empty).
   */
  requiresSelect?: boolean;

  /**
   * Optional OData `$filter` applied unconditionally to this entity's pulls
   * (`clarion.sync.defaultFilter` in the package). No shipped entity sets
   * one — the product decision is to ingest ALL history.
   */
  defaultFilter?: string;

  /** Soft context from the package (Markdown) — reaches the profiler's prompts, never a description. */
  notes?: string;
}

/**
 * The entity catalog, in package order. Every entry was cross-referenced
 * against ExactOnline's REST API reference; paths are stable across
 * .nl/.be/.com/.de/.fr/.es/.co.uk/.us regions. No date filters by design:
 * the product decision (May 2026) is to ingest ALL history.
 */
export const EXACT_ONLINE_ENTITIES: readonly ExactOnlineEntity[] = sourceDatasets(EXACT_ONLINE_PACKAGE).map((d) => {
  if (!d.source) throw new Error(`[exactonline] dataset '${d.name}' has no source (the API path)`);
  const cursor = d.clarion.sync?.cursor;
  const e: ExactOnlineEntity = {
    name: d.name,
    displayName: d.label,
    category: d.clarion.category,
    description: d.description,
    apiPath: d.source,
    supportsIncremental: !!cursor,
  };
  if (d.clarion.estimatedRowCount !== undefined) e.estimatedRowCount = d.clarion.estimatedRowCount;
  if (cursor) (e as { incrementalCursor?: EntityDescriptor['incrementalCursor'] }).incrementalCursor = { field: cursor.field, type: cursor.type };
  if (d.primary_key?.[0]) (e as { businessKey?: string }).businessKey = d.primary_key[0];
  if (d.clarion.sync?.requiresSelect) e.requiresSelect = true;
  if (d.clarion.sync?.defaultFilter) e.defaultFilter = d.clarion.sync.defaultFilter;
  if (d.clarion.notes) e.notes = d.clarion.notes;
  return e;
});

/** Stable name → entity, for fast lookup during sync. */
export const ENTITIES_BY_NAME: ReadonlyMap<string, ExactOnlineEntity> = new Map(
  EXACT_ONLINE_ENTITIES.map((e) => [e.name, e]),
);

/** EntityDescriptor projection (without internals like apiPath). */
export function asEntityDescriptors(): EntityDescriptor[] {
  return EXACT_ONLINE_ENTITIES.map((e) => ({
    name: e.name,
    displayName: e.displayName,
    category: e.category,
    description: e.description,
    estimatedRowCount: e.estimatedRowCount,
    supportsIncremental: e.supportsIncremental,
  }));
}

/**
 * Documented FKs among the catalogued entities — what WE wrote down after
 * reading the vendor's data model (the `curated` rung). The vendor's own
 * per-column references travel on the fields (`EXACT_ONLINE_COLUMN_DOCS`).
 */
export const EXACT_ONLINE_KNOWN_RELATIONSHIPS: readonly KnownRelationship[] = toKnownRelationships(EXACT_ONLINE_PACKAGE);

/**
 * Column documentation transcribed from the vendor's REST reference, one
 * details page per entity — descriptions verbatim, the Edm type, a role hint
 * derived from that type, and the FK target where the docs hyperlink one.
 */
export const EXACT_ONLINE_COLUMN_DOCS: Readonly<Record<string, readonly ColumnDoc[]>> = toColumnDocs(EXACT_ONLINE_PACKAGE);

/** The deterministic Kimball design (version in the package). */
export const EXACT_ONLINE_STAR_SCHEMA_TEMPLATE: StarSchemaTemplate = (() => {
  const t = toStarSchemaTemplate(EXACT_ONLINE_PACKAGE);
  if (!t) throw new Error('[exactonline] the source package ships no star-schema template');
  return t;
})();
