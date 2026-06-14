/**
 * Odoo connector tests (DuckDB-free).
 *
 *   • Pure helpers (flatten / field selection / type mapping) — no I/O.
 *   • testConnection + probeEntities against a mocked JSON-2 API (nock).
 *
 * The end-to-end sync test (which writes real Parquet via the DuckDB-backed
 * warehouse writer and reads it back) lives in `OdooConnector.sync.test.ts`
 * so this file stays runnable in environments without a DuckDB native binary.
 *
 * Rate limiting is disabled for the suite (env) so the 1 req/sec pacing
 * doesn't make tests sleep.
 */

process.env.HTTP_CLIENT_RATE_LIMIT_DISABLED = '1';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import {
  OdooConnector,
  flattenRow,
  ingestibleFields,
  buildColumnSchema,
} from './OdooConnector';
import { createNoopLogger } from '../logging';
import type { ProbeContext } from '../types';

const BASE = 'https://test.odoo.com';
const config = { url: BASE, db: 'demo', username: 'me@x.com', apiKey: 'secret' };
const probeCtx: ProbeContext = { log: createNoopLogger() };

beforeAll(() => { nock.disableNetConnect(); });
afterEach(() => { nock.cleanAll(); });
afterAll(() => { nock.enableNetConnect(); });

// ─── Pure helpers ─────────────────────────────────────────────────────────
describe('flattenRow', () => {
  it('flattens many2one [id, label] to the id', () => {
    expect(flattenRow({ partner_id: [5, 'Acme'] }, new Set())).toEqual({ partner_id: 5 });
  });
  it('maps false on a non-boolean field to null', () => {
    expect(flattenRow({ name: false }, new Set())).toEqual({ name: null });
  });
  it('keeps false on a boolean field', () => {
    expect(flattenRow({ active: false }, new Set(['active']))).toEqual({ active: false });
  });
  it('passes scalars and non-pair arrays through', () => {
    expect(flattenRow({ n: 3, tags: [1, 2, 3] }, new Set())).toEqual({ n: 3, tags: [1, 2, 3] });
  });
});

describe('ingestibleFields', () => {
  it('keeps scalars + many2one, drops relational/binary/technical', () => {
    const meta = {
      id: { type: 'integer' },
      name: { type: 'char' },
      active: { type: 'boolean' },
      partner_id: { type: 'many2one' },
      write_date: { type: 'datetime' },
      tag_ids: { type: 'many2many' },
      line_ids: { type: 'one2many' },
      image_1920: { type: 'binary' },
      message_ids: { type: 'one2many' },
      __last_update: { type: 'datetime' },
    };
    const keep = ingestibleFields(meta).sort();
    expect(keep).toEqual(['active', 'id', 'name', 'partner_id', 'write_date']);
  });
  it('guarantees id even if absent from a sparse fields_get', () => {
    expect(ingestibleFields({ name: { type: 'char' } })).toContain('id');
  });
});

describe('buildColumnSchema', () => {
  it('maps Odoo types to stable DuckDB types', () => {
    const meta = {
      id: { type: 'integer' },
      amount: { type: 'monetary' },
      qty: { type: 'float' },
      partner_id: { type: 'many2one' },
      active: { type: 'boolean' },
      day: { type: 'date' },
      write_date: { type: 'datetime' },
      label: { type: 'char' },
    };
    const cols = Object.fromEntries(
      buildColumnSchema(['id', 'amount', 'qty', 'partner_id', 'active', 'day', 'write_date', 'label'], meta)
        .map((c) => [c.name, c.sqlType]),
    );
    expect(cols).toEqual({
      id: 'BIGINT',
      amount: 'DECIMAL(18,4)',
      qty: 'DOUBLE',
      partner_id: 'BIGINT',
      active: 'BOOLEAN',
      day: 'DATE',
      write_date: 'TIMESTAMP',
      label: 'VARCHAR',
    });
  });
});

// ─── testConnection (JSON-2) ───────────────────────────────────────────────
describe('testConnection', () => {
  it('succeeds when the API key is accepted', async () => {
    nock(BASE).post('/json/2/res.users/search_count').reply(200, '1', { 'content-type': 'application/json' });
    const res = await new OdooConnector().testConnection(config, probeCtx);
    expect(res.ok).toBe(true);
    expect(res.details?.transport).toBe('JSON-2');
  });

  it('fails clearly on a rejected key', async () => {
    nock(BASE).post('/json/2/res.users/search_count').reply(401, { error: 'unauthorized' });
    const res = await new OdooConnector().testConnection(config, probeCtx);
    expect(res.ok).toBe(false);
    expect(res.error?.toLowerCase()).toContain('key');
  });
});

// ─── probeEntities ─────────────────────────────────────────────────────────
describe('probeEntities', () => {
  it('marks present models available and missing ones not_found', async () => {
    // verify() + every model probe go through search_count. Return a count for
    // all, but 404 specifically for stock.valuation.layer (the v19-removed one).
    nock(BASE)
      .post('/json/2/stock.valuation.layer/search_count')
      .reply(404, { error: 'not found' });
    nock(BASE)
      .persist()
      .post(/\/json\/2\/.+\/search_count/)
      .reply(200, '7', { 'content-type': 'application/json' });

    const out = await new OdooConnector().probeEntities(config, probeCtx);
    const byName = Object.fromEntries(out.map((r) => [r.name, r]));
    expect(byName['res_partner'].state).toBe('available');
    expect(byName['res_partner'].rowCountSample).toBe(7);
    expect(byName['stock_valuation_layer'].state).toBe('not_found');
  });
});
