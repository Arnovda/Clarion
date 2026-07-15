/**
 * Connector conformance checks.
 *
 * Pure validators every connector must satisfy. The contract has invariants
 * that are documented across `types.ts` but were previously unenforced — and
 * "every new connector author must remember the rules" does not scale to the
 * 200 connectors this framework is meant to host. These functions turn the
 * rules into assertions; `conformance.test.ts` runs them across the registry
 * so CI blocks a non-conforming connector at merge time.
 *
 * Each validator returns a list of human-readable violation strings (empty =
 * conformant) so tests can assert `toEqual([])` and print exactly what's wrong.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { EntityDescriptor, KnownRelationship, SourceConnector } from './types';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const SAFE_TABLE_NAME = /^[A-Za-z0-9_-]+$/;
const SAFE_COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_TYPE = /^[a-z][a-z0-9_]*$/;

/**
 * Connector-level metadata invariants — checkable without any network or
 * config. Run for every registered connector.
 */
export function validateConnectorMetadata(c: SourceConnector): string[] {
  const errs: string[] = [];
  const p = `[${c.type ?? '?'}]`;

  if (!c.type || typeof c.type !== 'string') {
    errs.push(`${p} type must be a non-empty string`);
  } else if (!SAFE_TYPE.test(c.type)) {
    errs.push(`${p} type must be lower-snake-case (got '${c.type}')`);
  }

  if (!c.displayName || typeof c.displayName !== 'string') {
    errs.push(`${p} displayName must be a non-empty string`);
  }

  if (!Array.isArray(c.egressAllowList) || c.egressAllowList.length === 0) {
    errs.push(`${p} egressAllowList must be a non-empty array`);
  }

  // configSchema must be a compilable JSON Schema.
  try {
    ajv.compile(c.configSchema as object);
  } catch (e) {
    errs.push(`${p} configSchema does not compile: ${e instanceof Error ? e.message : String(e)}`);
  }

  // OAuth preAuthFields must reference real schema properties.
  if (c.oauth) {
    const props = ((c.configSchema as { properties?: Record<string, unknown> })?.properties) ?? {};
    for (const f of c.oauth.preAuthFields) {
      if (!(f in props)) {
        errs.push(`${p} oauth.preAuthFields references '${f}', absent from configSchema.properties`);
      }
    }
  }

  return errs;
}

/**
 * Entity-catalog invariants. Run against a connector's RAW catalog (the array
 * that carries `incrementalCursor` / `businessKey`) — the public
 * `listEntities` projection may strip those, so connectors export their
 * catalog for this check.
 */
export function validateEntityCatalog(
  connectorType: string,
  entities: ReadonlyArray<EntityDescriptor>,
): string[] {
  const errs: string[] = [];
  const p = `[${connectorType}]`;
  const seen = new Set<string>();

  for (const e of entities) {
    const id = `${p} entity '${e.name}'`;

    if (!e.name || !SAFE_TABLE_NAME.test(e.name)) {
      errs.push(`${id}: name must match ${SAFE_TABLE_NAME} (warehouse table-name safety)`);
    }
    if (seen.has(e.name)) errs.push(`${id}: duplicate entity name`);
    seen.add(e.name);

    // supportsIncremental MUST mirror the presence of a cursor.
    if (e.supportsIncremental !== !!e.incrementalCursor) {
      errs.push(`${id}: supportsIncremental (${e.supportsIncremental}) must equal !!incrementalCursor (${!!e.incrementalCursor})`);
    }

    // An incremental entity without a businessKey silently OVERWRITES the
    // whole table with each delta (the writer falls back to overwrite when no
    // mergeKey is passed) while the cursor still advances — catastrophic,
    // silent data loss. This is the highest-value invariant in the suite.
    if (e.incrementalCursor && !e.businessKey) {
      errs.push(`${id}: declares incrementalCursor but no businessKey — incremental sync would wipe unchanged rows`);
    }

    if (e.businessKey && !SAFE_COLUMN_NAME.test(e.businessKey)) {
      errs.push(`${id}: businessKey '${e.businessKey}' must match ${SAFE_COLUMN_NAME}`);
    }

    if (e.incrementalCursor && !e.incrementalCursor.field) {
      errs.push(`${id}: incrementalCursor.field is required`);
    }

    // Documentation-before-inference (docs/SOURCE_ONBOARDING.md Phase C):
    // every curated catalog entity carries a description — it feeds the
    // wizard picker AND the trusted semantic tier. An empty description on
    // a Tier 1/2 connector is a review blocker, enforced here.
    if (!e.description || !e.description.trim()) {
      errs.push(`${id}: description is required (playbook Phase C — curated catalogs document every entity)`);
    }
  }

  return errs;
}

/**
 * Known-relationship invariants (docs/SOURCE_ONBOARDING.md Phase E1): every
 * declared FK must connect two catalogued entities with safe column names
 * and a valid cardinality. Column EXISTENCE can't be checked statically
 * (catalogs don't carry column lists) — the profiler's name-matching drops
 * non-existent columns harmlessly at runtime.
 */
export function validateKnownRelationships(
  connectorType: string,
  relationships: ReadonlyArray<KnownRelationship>,
  entities: ReadonlyArray<EntityDescriptor>,
): string[] {
  const errs: string[] = [];
  const p = `[${connectorType}]`;
  const names = new Set(entities.map((e) => e.name));
  const seen = new Set<string>();

  for (const r of relationships) {
    const id = `${p} rel ${r.fromTable}.${r.fromColumn}→${r.toTable}.${r.toColumn}`;
    if (!names.has(r.fromTable)) errs.push(`${id}: fromTable not in catalog`);
    if (!names.has(r.toTable)) errs.push(`${id}: toTable not in catalog`);
    if (!SAFE_COLUMN_NAME.test(r.fromColumn)) errs.push(`${id}: unsafe fromColumn`);
    if (!SAFE_COLUMN_NAME.test(r.toColumn)) errs.push(`${id}: unsafe toColumn`);
    if (r.type && !['many_to_one', 'one_to_many', 'many_to_many', 'one_to_one'].includes(r.type)) {
      errs.push(`${id}: invalid type '${r.type}'`);
    }
    const key = `${r.fromTable}.${r.fromColumn}→${r.toTable}.${r.toColumn}`;
    if (seen.has(key)) errs.push(`${id}: duplicate relationship`);
    seen.add(key);
  }

  return errs;
}
