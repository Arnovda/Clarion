/**
 * Conformance suite — every registered connector must pass.
 *
 * Importing `./index` self-registers all connectors. This file is the gate
 * that scales the framework to many connectors: add a connector, it's
 * automatically held to the contract here (metadata) and, by importing its
 * catalog below, to the entity invariants too.
 */

import { describe, expect, it } from 'vitest';
// Register connectors via their side-effect modules directly (rather than
// './index') so this suite doesn't transitively load the DuckDB-backed
// warehouse writers — conformance is pure metadata + catalog checks.
import './exactonline';
import './odoo';
import './sharepoint';
import { getConnector, listConnectorTypes } from './registry';
import { validateConnectorMetadata, validateEntityCatalog, validateKnownRelationships } from './conformance';
import { validateStarSchemaTemplate } from './starSchema';
import { EXACT_ONLINE_ENTITIES } from './exactonline/entities';
import { EXACT_ONLINE_COLUMN_DOCS } from './exactonline/docs';
import { ODOO_ENTITIES } from './odoo/entities';

describe('connector conformance — metadata (all registered connectors)', () => {
  const types = listConnectorTypes();

  it('registers at least the known connectors', () => {
    expect(types).toContain('exactonline');
    expect(types).toContain('odoo');
    expect(types).toContain('sharepoint');
  });

  it.each(types)('connector "%s" passes metadata invariants', (type) => {
    const errs = validateConnectorMetadata(getConnector(type));
    expect(errs).toEqual([]);
  });
});

describe('connector conformance — entity catalogs', () => {
  // Each connector registers its raw catalog here so the entity invariants
  // (incrementalCursor ⇒ businessKey, name safety, …) are enforced.
  const catalogs: Array<[string, typeof ODOO_ENTITIES]> = [
    ['exactonline', EXACT_ONLINE_ENTITIES],
    ['odoo', ODOO_ENTITIES],
  ];

  it.each(catalogs)('catalog for "%s" passes entity invariants', (type, entities) => {
    const errs = validateEntityCatalog(type, entities);
    expect(errs).toEqual([]);
  });

  /**
   * Column documentation per connector, where it ships any. Supplying it turns
   * endpoint existence and type compatibility into merge-gate errors instead of
   * a silent runtime drop — see validateKnownRelationships.
   */
  const columnDocs: Record<string, Record<string, ReadonlyArray<{ name: string; dataType?: string }>> | undefined> = {
    exactonline: EXACT_ONLINE_COLUMN_DOCS,
    // Odoo harvests its docs live from fields_get and ships no static column
    // list, so there is nothing to check against here.
    odoo: undefined,
  };

  it.each(catalogs)('known relationships for "%s" connect catalogued entities', (type, entities) => {
    const connector = getConnector(type);
    if (!connector.getKnownRelationships) return;
    // Pass the full catalog as "selected" so every declared relationship is
    // returned and validated.
    const rels = connector.getKnownRelationships(entities.map((e) => e.name));
    const errs = validateKnownRelationships(type, rels, entities, columnDocs[type]);
    expect(errs).toEqual([]);
  });

  it.each(catalogs)('star-schema template for "%s" (when shipped) passes template validation', (type, entities) => {
    const connector = getConnector(type);
    const template = connector.getStarSchemaTemplate?.();
    if (!template) return;
    const errs = validateStarSchemaTemplate(template, entities.map((e) => e.name));
    expect(errs).toEqual([]);
  });
});
