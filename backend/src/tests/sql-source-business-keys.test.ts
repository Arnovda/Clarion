/**
 * A SQL source declares its primary key, and the profiler must use it.
 *
 * The platform reads declared business keys through two channels, and which
 * one a connector uses is a property of how its catalog is known:
 *
 *   • `getBusinessKeys()` — synchronous, config-free. Right for an API
 *     connector, whose entities are the same for every customer, so the key is
 *     a compile-time constant.
 *   • `EntityDocs.businessKey` — async, carries the config. The only channel
 *     available to a source whose catalog is INTROSPECTED, because the key
 *     lives in the customer's own schema.
 *
 * Getting this wrong is invisible: nothing errors, the profiler just guesses
 * the key from the data and the quality scores quietly measure the wrong
 * column — which is how a `Created` timestamp came to identify a bank
 * statement line on Exact Online's BankEntryLines.
 */

import { describe, expect, it } from 'vitest';
import { getConnector, listConnectorTypes } from '@databridge/connectors';
import { declaredBusinessKeys } from '../services/declaredBusinessKeys';

const SQL_CONNECTORS = ['postgres', 'mysql', 'mssql'];

describe('SQL connectors — the business-key channel', () => {
  it('registers all three', () => {
    for (const t of SQL_CONNECTORS) expect(listConnectorTypes()).toContain(t);
  });

  it('does not pretend to answer the synchronous accessor', () => {
    // A dynamically-introspected source cannot know its keys without a
    // connection. Implementing `getBusinessKeys()` anyway could only return
    // something invented, at the rung where nothing downstream questions it.
    for (const t of SQL_CONNECTORS) {
      expect(getConnector(t).getBusinessKeys).toBeUndefined();
      expect(declaredBusinessKeys(t).size).toBe(0);
    }
  });

  it('declares the key on the docs channel instead', () => {
    // `describeEntities` is async and receives the config, so it can
    // introspect. This is the contract the profiler overlays onto the static
    // map — see `SchemaProfiler`'s `declaredBks`.
    for (const t of SQL_CONNECTORS) {
      expect(typeof getConnector(t).describeEntities).toBe('function');
    }
  });

  it('ships no star-schema template, so the AI designer runs', () => {
    // A customer's own database has no universal fact/dimension design, unlike
    // a vendor schema every tenant shares. Returning null is what selects the
    // AI path; returning a template would impose a shape nobody asked for.
    for (const t of SQL_CONNECTORS) {
      expect(getConnector(t).getStarSchemaTemplate?.()).toBeNull();
    }
  });

  it('declares no HTTP egress, because a database driver makes none', () => {
    // An empty list means "this connector makes no HTTP calls" — not "no
    // policy". `HttpClient` refuses everything under it, so a connector that
    // did reach out would fail loudly rather than bypass the allow-list.
    for (const t of SQL_CONNECTORS) {
      expect(getConnector(t).egressAllowList).toEqual([]);
    }
  });

  it('leaves the legacy static catalogs working', () => {
    // The overlay must not have broken the channel the API connectors use.
    expect(declaredBusinessKeys('exactonline').size).toBeGreaterThan(0);
    expect(declaredBusinessKeys('odoo').size).toBeGreaterThan(0);
  });
});
