/**
 * P0-6 of the 2026-09-05 market-readiness assessment (v2): the sync did not
 * tell the truth about itself — a partially failed run was persisted as
 * `succeeded`, an empty response could wipe a table, and there was no full
 * re-sync (the only way to rebuild a table or drop rows deleted at the
 * source was to delete and recreate the connection).
 *
 * The writer half (empty batches preserve, `replace` overwrites) is pinned
 * in packages/connectors ParquetWriter.test.ts. This file pins the
 * orchestrator half that needs no worker: the partial-run summary, the
 * `full` / `entities` contract of POST /connections/:id/sync (validation,
 * cursor reset scoped to the entities in play, `mode` on the run row).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';
import { summariseFailedEntities } from '../orchestrator/SyncOrchestrator';

let token: string;
let tenantId: number;
let connectionId: number;

async function seedCursors() {
  const db = getTestDb();
  await db('entity_sync_cursors').where({ connection_id: connectionId }).del();
  await db('entity_sync_cursors').insert([
    { tenant_id: tenantId, connection_id: connectionId, entity_name: 'Accounts', cursor_type: 'timestamp', cursor_value: '2026-09-01T00:00:00Z', last_sync_at: new Date().toISOString() },
    { tenant_id: tenantId, connection_id: connectionId, entity_name: 'Items',    cursor_type: 'timestamp', cursor_value: '2026-09-01T00:00:00Z', last_sync_at: new Date().toISOString() },
  ]);
}

async function cursorNames(): Promise<string[]> {
  return (await getTestDb()('entity_sync_cursors').where({ connection_id: connectionId }).pluck('entity_name')).sort();
}

async function waitTerminal(syncRunId: number) {
  let row: { status: string } | undefined;
  for (let i = 0; i < 40; i++) {
    row = await getTestDb()('source_sync_runs').where({ id: syncRunId }).first();
    if (row && ['succeeded', 'partial', 'failed', 'cancelled'].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return row;
}

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'admin@truth.test', companyName: 'TruthCo' });
  token = admin.token; tenantId = admin.user.tenantId;
  const [conn] = await getTestDb()('connections').insert({
    tenant_id: tenantId, name: 'EO', type: 'duckdb', connector_type: 'exactonline',
    selected_entities: ['Accounts', 'Items'], config: JSON.stringify({}),
  }).returning('id');
  connectionId = Number((conn as { id?: number }).id ?? conn);
});

afterAll(async () => { await closeTestDb(); });

const sync = async (body: unknown) =>
  (await request()).post(`/api/connections/${connectionId}/sync`).set('Authorization', `Bearer ${token}`).send(body);

describe('summariseFailedEntities', () => {
  it('names the entities and their errors, and bounds the message', () => {
    const msg = summariseFailedEntities({ SalesInvoiceLines: 'HTTP 500 from /api', Items: 'timeout' }, 5);
    expect(msg).toBe('2 of 5 entities failed: SalesInvoiceLines (HTTP 500 from /api); Items (timeout)');
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`E${i}`, 'x'.repeat(400)]));
    const long = summariseFailedEntities(many, 20);
    expect(long.startsWith('9 of 20 entities failed:')).toBe(true);
    expect(long.endsWith('; and 4 more')).toBe(true);
    expect(long.length).toBeLessThan(1300);
  });
});

describe('POST /api/connections/:id/sync — full re-sync contract', () => {
  it('refuses an entity that is not in the selection', async () => {
    const res = await sync({ full: true, entities: ['Nope'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown entity/);
    // Nothing was queued.
    expect(await getTestDb()('source_sync_runs').where({ connection_id: connectionId })).toHaveLength(0);
  });

  it('rejects a malformed body', async () => {
    const res = await sync({ full: 'yes' });
    expect(res.status).toBe(400);
  });

  it('a full re-sync resets EVERY cursor and records mode=full on the run', async () => {
    await seedCursors();
    const res = await sync({ full: true });
    expect(res.status).toBe(202);
    const { syncRunId } = res.body.data as { syncRunId: number };
    expect(await cursorNames()).toEqual([]);
    const row = await waitTerminal(syncRunId);
    expect(row?.status).toBe('failed'); // no encrypted config here — the run fails fast, which is not what is under test
    const stored = await getTestDb()('source_sync_runs').where({ id: syncRunId }).first();
    expect(stored.mode).toBe('full');
  });

  it('a full re-sync of ONE entity resets only that cursor', async () => {
    await seedCursors();
    const res = await sync({ full: true, entities: ['Items'] });
    expect(res.status).toBe(202);
    expect(await cursorNames()).toEqual(['Accounts']);
    await waitTerminal((res.body.data as { syncRunId: number }).syncRunId);
  });

  it('an ordinary sync leaves the cursors alone and records mode=incremental', async () => {
    await seedCursors();
    const res = await sync({});
    expect(res.status).toBe(202);
    expect(await cursorNames()).toEqual(['Accounts', 'Items']);
    const { syncRunId } = res.body.data as { syncRunId: number };
    await waitTerminal(syncRunId);
    const stored = await getTestDb()('source_sync_runs').where({ id: syncRunId }).first();
    expect(stored.mode).toBe('incremental');
  });
});
