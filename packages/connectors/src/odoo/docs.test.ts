/**
 * Odoo `describeEntities` tests (DuckDB-free).
 *
 *   • `buildEntityDocs` / `odooFieldRole` — pure, no I/O.
 *   • `describeEntities` wiring against a mocked JSON-2 API (nock): per-model
 *     harvest, graceful skip of a failing model, unknown-entity filtering.
 *
 * Rate limiting disabled (env) so the 1 req/sec pacing doesn't slow the suite.
 */

process.env.HTTP_CLIENT_RATE_LIMIT_DISABLED = '1';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import { OdooConnector, buildEntityDocs } from './OdooConnector';
import { ENTITIES_BY_NAME, odooFieldRole } from './entities';
import { createNoopLogger } from '../logging';
import type { ProbeContext } from '../types';
import type { OdooFieldMeta } from './transport';

const BASE = 'https://test.odoo.com';
const config = { url: BASE, db: 'demo', username: 'me@x.com', apiKey: 'secret' };
const probeCtx: ProbeContext = { log: createNoopLogger() };

const partner = ENTITIES_BY_NAME.get('res_partner')!;

beforeAll(() => { nock.disableNetConnect(); });
afterEach(() => { nock.cleanAll(); });
afterAll(() => { nock.enableNetConnect(); });

// ─── odooFieldRole ──────────────────────────────────────────────────────────
describe('odooFieldRole', () => {
  it('maps monetary and float to measure', () => {
    expect(odooFieldRole('amount_total', 'monetary')).toBe('measure');
    expect(odooFieldRole('qty', 'float')).toBe('measure');
  });
  it('maps categorical types to dimension', () => {
    expect(odooFieldRole('partner_id', 'many2one')).toBe('dimension');
    expect(odooFieldRole('state', 'selection')).toBe('dimension');
    expect(odooFieldRole('name', 'char')).toBe('dimension');
    expect(odooFieldRole('active', 'boolean')).toBe('dimension');
    expect(odooFieldRole('date_order', 'datetime')).toBe('dimension');
  });
  it('gives no hint for ambiguous types and for id', () => {
    expect(odooFieldRole('sequence', 'integer')).toBeUndefined();
    expect(odooFieldRole('note', 'text')).toBeUndefined();
    expect(odooFieldRole('id', 'integer')).toBeUndefined();
  });
});

// ─── buildEntityDocs ────────────────────────────────────────────────────────
describe('buildEntityDocs', () => {
  const meta: Record<string, OdooFieldMeta> = {
    id:           { type: 'integer',  string: 'ID' },
    name:         { type: 'char',     string: 'Name', help: false },
    credit_limit: { type: 'monetary', string: 'Credit Limit', help: 'Credit limit specific to this partner.' },
    company_id:   { type: 'many2one', string: 'Company', relation: 'res.company' },
    user_id:      { type: 'many2one', string: 'Salesperson', relation: 'res.users', help: 'The internal user in charge of this contact.' },
    write_date:   { type: 'datetime', string: 'Last Updated on' },
    line_ids:     { type: 'one2many', string: 'Lines', relation: 'account.move.line' },
  };
  const selected = new Set(['res_partner', 'res_company']);

  it('uses vendor help text verbatim as the description, with label + role', () => {
    const docs = buildEntityDocs(partner, meta, selected);
    const credit = docs.columns.find((c) => c.name === 'credit_limit')!;
    expect(credit.description).toBe('Credit limit specific to this partner.');
    expect(credit.displayName).toBe('Credit Limit');
    expect(credit.role).toBe('measure');
  });

  it('treats false/missing help as undocumented so the AI fills the gap', () => {
    const docs = buildEntityDocs(partner, meta, selected);
    const name = docs.columns.find((c) => c.name === 'name')!;
    expect(name.description).toBeUndefined();
    expect(name.displayName).toBe('Name');
  });

  it('synthesises a description for a many2one without help, from label + relation', () => {
    const docs = buildEntityDocs(partner, meta, selected);
    const company = docs.columns.find((c) => c.name === 'company_id')!;
    expect(company.description).toBe('Company — references res_company.');
  });

  it('prefers vendor help on a many2one and falls back to the model name for unallowlisted relations', () => {
    const docs = buildEntityDocs(partner, meta, selected);
    const user = docs.columns.find((c) => c.name === 'user_id')!;
    expect(user.description).toBe('The internal user in charge of this contact.');

    const noHelp: Record<string, OdooFieldMeta> = {
      user_id: { type: 'many2one', string: 'Salesperson', relation: 'res.users' },
    };
    const docs2 = buildEntityDocs(partner, noHelp, selected);
    const user2 = docs2.columns.find((c) => c.name === 'user_id')!;
    expect(user2.description).toBe('Salesperson — references res.users.');
  });

  it('emits declared relationships only for selected, allowlisted targets', () => {
    const docs = buildEntityDocs(partner, meta, selected);
    expect(docs.relationships).toEqual([
      {
        fromTable: 'res_partner',
        fromColumn: 'company_id',
        toTable: 'res_company',
        toColumn: 'id',
        type: 'many_to_one',
        description: 'Company.',
      },
    ]);

    const docsSolo = buildEntityDocs(partner, meta, new Set(['res_partner']));
    expect(docsSolo.relationships).toEqual([]);
  });

  it('excludes non-ingestible fields from the docs', () => {
    const docs = buildEntityDocs(partner, meta, selected);
    expect(docs.columns.map((c) => c.name)).not.toContain('line_ids');
  });

  it('carries the curated entity description + displayName at declared provenance', () => {
    const docs = buildEntityDocs(partner, meta, selected);
    expect(docs.entityName).toBe('res_partner');
    expect(docs.displayName).toBe('Contacts / partners');
    expect(docs.description).toMatch(/Customers, vendors and contacts/);
    expect(docs.provenance).toBe('declared');
  });
});

// ─── describeEntities wiring (mocked JSON-2) ────────────────────────────────
describe('OdooConnector.describeEntities', () => {
  it('harvests docs per selected entity, skipping failing models and unknown names', async () => {
    const connector = new OdooConnector();
    nock(BASE).post('/json/2/res.users/search_count').reply(200, 1); // transport verify
    nock(BASE).post('/json/2/res.partner/fields_get').reply(200, {
      id:   { type: 'integer', string: 'ID' },
      name: { type: 'char', string: 'Name', help: 'The full name of the contact.' },
      write_date: { type: 'datetime', string: 'Last Updated on' },
    });
    // 403 is not retried by HttpClient (unlike 5xx), so the skip is immediate.
    nock(BASE).post('/json/2/res.company/fields_get').reply(403);

    const docs = await connector.describeEntities(
      config,
      ['res_partner', 'res_company', 'not_a_real_entity'],
      probeCtx,
    );

    expect(docs).toHaveLength(1);
    expect(docs[0].entityName).toBe('res_partner');
    const name = docs[0].columns.find((c) => c.name === 'name')!;
    expect(name.description).toBe('The full name of the contact.');
  });

  it('returns empty for no selected entities without touching the network', async () => {
    const connector = new OdooConnector();
    const docs = await connector.describeEntities(config, [], probeCtx);
    expect(docs).toEqual([]);
  });
});
