/**
 * businessKeysFromCatalog — the projection the profiler reads instead of
 * guessing. The cases that matter are the two ways it could lie: claiming a
 * key for an entity that has none, and dropping one that exists.
 */
import { describe, expect, it } from 'vitest';
import { businessKeysFromCatalog } from './businessKeys';
import type { EntityDescriptor } from './types';

const entity = (name: string, businessKey?: string): EntityDescriptor => ({
  name,
  supportsIncremental: !!businessKey,
  ...(businessKey ? { businessKey } : {}),
});

describe('businessKeysFromCatalog', () => {
  it('projects the declared key per entity', () => {
    const out = businessKeysFromCatalog([entity('BankEntryLines', 'ID')], ['BankEntryLines']);
    expect(out).toEqual([{ entity: 'BankEntryLines', column: 'ID' }]);
  });

  it('OMITS an entity that declares no key — "does not say" is not "says none"', () => {
    const out = businessKeysFromCatalog(
      [entity('AgingReceivablesList'), entity('Accounts', 'ID')],
      ['AgingReceivablesList', 'Accounts'],
    );
    expect(out).toEqual([{ entity: 'Accounts', column: 'ID' }]);
  });

  it('filters to the entities the tenant actually selected', () => {
    const out = businessKeysFromCatalog(
      [entity('Accounts', 'ID'), entity('Payments', 'ID')],
      ['Accounts'],
    );
    expect(out.map((k) => k.entity)).toEqual(['Accounts']);
  });

  it('matches the selection case-insensitively — warehouse casing varies', () => {
    const out = businessKeysFromCatalog([entity('Accounts', 'ID')], ['accounts']);
    expect(out).toHaveLength(1);
  });

  it('treats an empty selection as "no filter", not "nothing selected"', () => {
    // Callers that do not track a selection (a re-profile of everything
    // already synced) must get the whole catalog, not silence.
    const out = businessKeysFromCatalog([entity('Accounts', 'ID')], []);
    expect(out).toHaveLength(1);
  });

  it('ignores a whitespace-only declaration rather than storing a blank key', () => {
    const out = businessKeysFromCatalog([entity('Accounts', '   ')], ['Accounts']);
    expect(out).toEqual([]);
  });
});
