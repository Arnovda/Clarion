/**
 * Tests for the explicit-column-schema ladder used by every EO entity
 * write: live $metadata → static vendor docs → auto-detect (warned).
 *
 * Regression guard for the JSON-columns bug (2026-07-20, recurred
 * 2026-07-22): when the ladder silently fell through to auto-detect,
 * all-NULL columns landed as JSON type in the warehouse and catalog.
 * No DuckDB dependency — pure resolution logic.
 */

import { describe, expect, it } from 'vitest';
import { resolveEntityColumns } from './ExactOnlineConnector';
import { parseODataMetadata } from './metadata';
import { EXACT_ONLINE_COLUMN_DOCS } from './docs';

const CSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx">
  <edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="2.0">
    <Schema Namespace="Exact.Web.Api.Models" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Account">
        <Key><PropertyRef Name="ID" /></Key>
        <Property Name="ID" Type="Edm.Guid" Nullable="false" />
        <Property Name="Name" Type="Edm.String" Nullable="true" />
        <Property Name="Modified" Type="Edm.DateTime" Nullable="true" />
        <Property Name="CreditLinePurchase" Type="Edm.Double" Nullable="true" />
      </EntityType>
    </Schema>
    <Schema Namespace="Default" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityContainer Name="ExactWebApi" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Accounts" EntityType="Exact.Web.Api.Models.Account" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const ACCOUNTS = { name: 'Accounts', apiPath: '/crm/Accounts' };

describe('resolveEntityColumns', () => {
  it('prefers live $metadata and maps Edm types to DuckDB types', () => {
    const md = parseODataMetadata(CSDL);
    const r = resolveEntityColumns(md, ACCOUNTS);
    expect(r.source).toBe('$metadata');
    const byName = new Map(r.columns!.map((c) => [c.name, c.sqlType]));
    expect(byName.get('ID')).toBe('UUID');
    expect(byName.get('Name')).toBe('VARCHAR');
    expect(byName.get('Modified')).toBe('TIMESTAMP');
    expect(byName.get('CreditLinePurchase')).toBe('DOUBLE');
  });

  it('falls back to vendor docs when $metadata is unavailable', () => {
    const r = resolveEntityColumns(null, ACCOUNTS);
    expect(r.source).toBe('vendor-docs');
    expect(r.columns!.length).toBe(EXACT_ONLINE_COLUMN_DOCS['Accounts'].length);
    // Spot-check a typed mapping straight from the docs data.
    const modified = r.columns!.find((c) => c.name === 'Modified');
    expect(modified?.sqlType).toBe('TIMESTAMP');
    // No JSON type can ever come out of the ladder.
    expect(r.columns!.every((c) => c.sqlType !== 'JSON')).toBe(true);
  });

  it('falls back to vendor docs when $metadata does not cover the entity', () => {
    const md = parseODataMetadata(CSDL); // only has Accounts
    const r = resolveEntityColumns(md, { name: 'Items', apiPath: '/logistics/Items' });
    expect(r.source).toBe('vendor-docs');
    expect(r.columns!.length).toBeGreaterThan(0);
  });

  it('reports auto-detect (no columns) only when neither source covers the entity', () => {
    const r = resolveEntityColumns(null, { name: 'NotARealEntity', apiPath: '/x/NotARealEntity' });
    expect(r.source).toBe('auto-detect');
    expect(r.columns).toBeUndefined();
  });

  it('every catalog entity is covered by the docs fallback (no silent auto-detect)', async () => {
    const { EXACT_ONLINE_ENTITIES } = await import('./entities');
    const uncovered = EXACT_ONLINE_ENTITIES
      .filter((e) => resolveEntityColumns(null, e).source === 'auto-detect')
      .map((e) => e.name);
    expect(uncovered).toEqual([]);
  });
});
