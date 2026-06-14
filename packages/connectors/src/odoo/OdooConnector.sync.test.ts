/**
 * Odoo connector — end-to-end sync test.
 *
 * Drives a full sync against a mocked JSON-2 API (nock), writing real Parquet
 * through LocalFileWarehouseWriter, then reads it back with DuckDB to prove:
 *   • many2one [id, label] flattens to the integer id
 *   • Odoo's `false` empty-sentinel becomes NULL on non-boolean fields
 *   • a real boolean `false` is preserved
 *   • the explicit column schema yields stable typed columns (BIGINT id)
 *   • the incremental cursor advances to max(write_date)
 *
 * Requires a DuckDB native binary. In environments where DuckDB can't be built
 * (e.g. a Node version without a prebuilt), this file's import of
 * LocalFileWarehouseWriter will fail to load — run it in CI / the real backend
 * image where DuckDB is available (the rest of the connector's behaviour is
 * covered DuckDB-free in OdooConnector.test.ts).
 */

process.env.HTTP_CLIENT_RATE_LIMIT_DISABLED = '1';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Database } from 'duckdb-async';
import { OdooConnector } from './OdooConnector';
import { LocalFileWarehouseWriter } from '../ParquetWriter';
import { createCancellationToken } from '../BaseSourceConnector';
import { createNoopLogger } from '../logging';
import type { SyncContext } from '../types';

const BASE = 'https://test.odoo.com';
const config = { url: BASE, db: 'demo', username: 'me@x.com', apiKey: 'secret' };

beforeAll(() => { nock.disableNetConnect(); });
afterEach(() => { nock.cleanAll(); });
afterAll(() => { nock.enableNetConnect(); });

describe('sync (end-to-end, Parquet readback)', () => {
  it('writes flattened, correctly-typed rows and advances the cursor', async () => {
    const root = path.join(os.tmpdir(), `odoo-test-${randomUUID()}`);
    fs.mkdirSync(root, { recursive: true });

    const fieldsMeta = {
      id: { type: 'integer', store: true },
      name: { type: 'char', store: true },
      active: { type: 'boolean', store: true },
      company_id: { type: 'many2one', store: true },
      rate: { type: 'float', store: true },
      write_date: { type: 'datetime', store: true },
      message_ids: { type: 'one2many', store: false },
    };
    const rows = [
      { id: 1, name: 'Euro', active: true, company_id: false, rate: 1.0, write_date: '2026-01-02 10:00:00' },
      { id: 2, name: false, active: false, company_id: [5, 'Acme'], rate: 0.85, write_date: '2026-01-03 11:00:00' },
    ];

    nock(BASE).post('/json/2/res.users/search_count').reply(200, '1', { 'content-type': 'application/json' });
    nock(BASE).post('/json/2/res.currency/fields_get').reply(200, fieldsMeta);
    nock(BASE).post('/json/2/res.currency/search_read').reply(200, rows);

    const writer = new LocalFileWarehouseWriter(root);
    const ctx: SyncContext = {
      tenantId: 't1',
      connectionId: 'c1',
      warehouseWriter: writer,
      log: createNoopLogger(),
      progress: () => {},
      cancellationToken: createCancellationToken(),
      onCredentialRotated: async () => {},
    };

    const result = await new OdooConnector().sync(config, { entities: ['res_currency'], cursors: {} }, ctx);

    expect(result.rowCounts.res_currency).toBe(2);
    expect(result.cursors?.res_currency).toEqual({ type: 'timestamp', value: '2026-01-03 11:00:00' });

    const db = await Database.create(':memory:');
    try {
      const file = path.join(root, 'res_currency', 'data.parquet').replace(/'/g, "''");
      const out = await db.all(`SELECT id, name, active, company_id, rate FROM read_parquet('${file}') ORDER BY id`);
      expect(out).toHaveLength(2);
      expect(Number(out[0].id)).toBe(1);
      expect(out[0].company_id).toBeNull();         // false → null on many2one
      expect(out[0].active).toBe(true);
      expect(Number(out[1].id)).toBe(2);
      expect(out[1].name).toBeNull();               // false → null on char
      expect(Number(out[1].company_id)).toBe(5);    // many2one → id (BIGINT)
      expect(out[1].active).toBe(false);            // boolean false preserved
    } finally {
      await db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
