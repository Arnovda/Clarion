/**
 * Smoke tests for the registry.
 *
 * Importing the package entry point (`./index`) triggers self-registration
 * of every connector via side-effect imports — no explicit `register()`
 * call needed. These tests cover that wire-up + the registry's basic API.
 */

import { describe, expect, it } from 'vitest';
import { _clearRegistryForTests, getConnector, listConnectorCatalog, listConnectorTypes, registerConnector } from './registry';
import './exactonline'; // re-register after clears (idempotent thanks to module-cache)
import { ExactOnlineConnector } from './exactonline/ExactOnlineConnector';

describe('registry — happy path (after package import)', () => {
  it('ExactOnline is registered', () => {
    const types = listConnectorTypes();
    expect(types).toContain('exactonline');

    const c = getConnector('exactonline');
    expect(c.type).toBe('exactonline');
    expect(c.displayName).toBe('Exact Online');
    expect(c.egressAllowList.length).toBeGreaterThan(0);
  });

  it('listConnectorCatalog returns wizard-facing metadata', () => {
    const catalog = listConnectorCatalog();
    const eo = catalog.find((c) => c.type === 'exactonline');
    expect(eo).toBeDefined();
    expect(eo?.configSchema).toBeDefined();
    expect(eo?.egressAllowList).toContain('*.exactonline.nl');
  });

  it('returns a fresh instance each call (no shared mutable state)', () => {
    const a = getConnector('exactonline');
    const b = getConnector('exactonline');
    expect(a).not.toBe(b);
    expect(a.type).toBe(b.type);
  });
});

describe('registry — error paths', () => {
  it('throws on unknown types', () => {
    expect(() => getConnector('does-not-exist')).toThrow(/unknown connector type/i);
  });

  it('clear-and-re-register works in isolation', () => {
    _clearRegistryForTests();
    expect(listConnectorTypes()).toEqual([]);
    registerConnector(ExactOnlineConnector);
    expect(listConnectorTypes()).toEqual(['exactonline']);
  });

  it('warns on duplicate registration but does not throw', () => {
    // First registration already happened via import; second is the duplicate.
    expect(() => registerConnector(ExactOnlineConnector)).not.toThrow();
  });
});
