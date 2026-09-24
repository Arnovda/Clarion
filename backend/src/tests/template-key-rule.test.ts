/**
 * The connector templates, as the backend instantiates them, pass the same
 * key rule an AI design must pass (validateBusMatrix → keys.ts, strict): every
 * lookup key is clarion_key and every fact key hashes the same entity. The
 * connector package pins this on the template; this pins it on what the
 * bus-matrix flow actually persists.
 */
import { describe, it, expect } from 'vitest';
import { getConnector } from '@databridge/connectors';
import { tryBuildBusMatrixFromTemplate } from '../services/starSchemaTemplates';
import { validateBusMatrix } from '../services/busMatrixBuilder';

describe.each(['exactonline', 'odoo'])('%s template → bus matrix', (type) => {
  it('passes validation, keys included, with every entity synced', () => {
    const template = getConnector(type)!.getStarSchemaTemplate!()!;
    const entities = [...new Set([...template.dimensions, ...template.facts].flatMap((t) => t.sourceEntities))];
    const built = tryBuildBusMatrixFromTemplate(type, entities);
    expect(built).not.toBeNull();
    expect(built!.templateVersion).toBe(2);
    expect(validateBusMatrix(built!.busMatrix)).toEqual([]);
    const keyCols = built!.busMatrix.conformed_dimensions.flatMap((d) => d.columns.filter((c) => c.column_role === 'surrogate_key'));
    expect(keyCols.length).toBe(built!.busMatrix.conformed_dimensions.length);
    expect(keyCols.every((c) => c.data_type === 'BIGINT')).toBe(true);
  });
});
