/**
 * Ingestion chain, phase 2 (docs/backlog/ingestion-chain-assessment.md §7):
 * resumable loads (B3), per-entity state (B6), soft delete + reconcile (B2)
 * on the orchestrator side, and the pipeline gate's reading of an unfinished
 * load. The writer half is pinned in packages/connectors (ParquetWriter,
 * writeEntityInChunks, ExactOnlineConnector phase-2 suites).
 *
 * The orchestrator is driven end to end through a FAKE job launcher that
 * emits the worker's events in-process: the persistence of a checkpoint on
 * arrival, the continuation run, the refusal to continue without progress
 * and the read of prior cursors are all real database round trips.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Database } from 'duckdb-async';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { LocalFileWarehouseWriter } from '@databridge/connectors';
import type { WorkerEvent } from '@databridge/connectors';
import { request, registerUser } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';
import {
  handleWorkerEvent,
  persistEntityCursor,
  persistEntityState,
  planContinuation,
  setJobLauncher,
  triggerSync,
} from '../orchestrator/SyncOrchestrator';
import { LocalProcessJobLauncher, type JobHandle, type JobLauncher, type JobSpec } from '../orchestrator/JobLauncher';
import { encryptCredentials } from '../utils/crypto';
import { unfinishedLoadAsPartial } from '../services/busMatrixOrchestrator';
import { createScanView } from '../services/warehouse/views';
import { listSourceTables } from '../services/tableCatalog';

let token: string;
let tenantId: number;
let connectionId: number;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'admin@phase2.test', companyName: 'Phase2Co' });
  token = admin.token; tenantId = admin.user.tenantId;
  const [conn] = await getTestDb()('connections').insert({
    tenant_id: tenantId, name: 'EO', type: 'duckdb', connector_type: 'exactonline',
    selected_entities: ['Accounts', 'Items'], config: JSON.stringify({}),
    connector_config_encrypted: encryptCredentials(JSON.stringify({ baseUrl: 'https://start.exactonline.nl', division: '1', clientId: 'x', clientSecret: 'y', refreshToken: 'z' })),
  }).returning('id');
  connectionId = Number((conn as { id?: number }).id ?? conn);
});

afterAll(async () => {
  setJobLauncher(new LocalProcessJobLauncher());
  await closeTestDb();
});

const cursorRow = async (entity: string) =>
  getTestDb()('entity_sync_cursors').where({ connection_id: connectionId, entity_name: entity }).first();

async function waitTerminal(syncRunId: number) {
  let row: { status: string } | undefined;
  for (let i = 0; i < 60; i++) {
    row = await getTestDb()('source_sync_runs').where({ id: syncRunId }).first();
    if (row && ['succeeded', 'partial', 'failed', 'cancelled'].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return row;
}

// ─── Pure rules ───────────────────────────────────────────────────────────
describe('planContinuation', () => {
  it('continues an unfinished load that made progress', () => {
    expect(planContinuation({ incomplete: ['TransactionLines'], depth: 3, progressed: true })).toEqual({ continue: true });
  });
  it('has nothing to continue when every entity finished', () => {
    expect(planContinuation({ incomplete: [], depth: 0, progressed: true }).continue).toBe(false);
  });
  it('gives up after the chain cap, saying so', () => {
    const p = planContinuation({ incomplete: ['A'], depth: 24, progressed: true, maxDepth: 24 });
    expect(p.continue).toBe(false);
    expect(p.reason).toMatch(/did not finish after 25 runs/);
  });
  it('refuses to chain a run that made no progress — a source that yields nothing is a fault, not a big table', () => {
    const p = planContinuation({ incomplete: ['A'], depth: 1, progressed: false });
    expect(p.continue).toBe(false);
    expect(p.reason).toMatch(/no progress/);
  });
});

describe("handleWorkerEvent — the two per-entity events and the result's incomplete set", () => {
  it('dispatches a checkpoint and a completion to their hooks, and collects incomplete entities from the result', () => {
    const rowCounts: Record<string, number> = {};
    const incompleteEntities: Record<string, { reason: 'time_budget'; rowsSoFar: number }> = {};
    const seen: string[] = [];
    const base = {
      rowCounts, warnings: [] as string[], failedEntities: {}, cursorsOut: {}, incompleteEntities,
      onLogLine: () => undefined, onCredentialRotated: () => undefined, onError: () => undefined,
      onEntityCheckpoint: (e: { entity: string }) => { seen.push(`checkpoint:${e.entity}`); },
      onEntityComplete: (e: { entity: string }) => { seen.push(`complete:${e.entity}`); },
    };
    handleWorkerEvent({ ...base, event: { type: 'entity_checkpoint', ts: 't', entity: 'A', cursor: { type: 'timestamp', value: '2026-01-01T00:00:00' }, rowsSoFar: 50 } });
    handleWorkerEvent({ ...base, event: { type: 'entity_complete', ts: 't', entity: 'B', rowsWritten: 7, bytesWritten: 1, rowsTotal: 7 } });
    handleWorkerEvent({ ...base, event: { type: 'result', ts: 't', rowCounts: { B: 7 }, warnings: [], incompleteEntities: { A: { reason: 'time_budget', rowsSoFar: 50 } } } });
    expect(seen).toEqual(['checkpoint:A', 'complete:B']);
    expect(rowCounts).toEqual({ A: 50, B: 7 });
    expect(incompleteEntities).toEqual({ A: { reason: 'time_budget', rowsSoFar: 50 } });
  });
});

describe('unfinishedLoadAsPartial (the pipeline gate)', () => {
  it('reads a succeeded run with incomplete entities as partial, naming them', () => {
    const r = unfinishedLoadAsPartial({ status: 'succeeded', error_message: null, incomplete_entities: { TransactionLines: { reason: 'time_budget', rowsSoFar: 1 } } });
    expect(r.status).toBe('partial');
    expect(r.error_message).toMatch(/TransactionLines/);
    expect(unfinishedLoadAsPartial({ status: 'succeeded', error_message: null, incomplete_entities: null })).toEqual({ status: 'succeeded', error_message: null });
    expect(unfinishedLoadAsPartial({ status: 'failed', error_message: 'x' })).toEqual({ status: 'failed', error_message: 'x' });
  });
});

// ─── Per-entity persistence (B3 + B6) ─────────────────────────────────────
describe('persistEntityCursor / persistEntityState', () => {
  it('a checkpoint lands as an incomplete cursor; the completion turns it into success with the row count', async () => {
    const c1 = { type: 'timestamp' as const, value: '2026-09-01T00:00:00Z' };
    expect(await persistEntityCursor({ tenantId, connectionId, entityName: 'Accounts', cursor: c1, status: 'incomplete', rowsSynced: 100 })).toBe('persisted');
    let row = await cursorRow('Accounts');
    expect(row).toMatchObject({ cursor_value: c1.value, last_status: 'incomplete', rows_synced_last: '100' });

    // Same value re-reported (a chunk that re-pulled the boundary) is a quiet no-op.
    expect(await persistEntityCursor({ tenantId, connectionId, entityName: 'Accounts', cursor: c1, status: 'incomplete', rowsSynced: 100 })).toBe('persisted');
    // Backwards is refused and stays loud.
    expect(await persistEntityCursor({ tenantId, connectionId, entityName: 'Accounts', cursor: { type: 'timestamp', value: '2026-08-01T00:00:00Z' }, status: 'success' })).toBe('non-advancing');
    expect(await persistEntityCursor({ tenantId, connectionId, entityName: 'Accounts', cursor: { type: 'timestamp', value: 'yesterday' }, status: 'success' })).toBe('malformed');

    const c2 = { type: 'timestamp' as const, value: '2026-09-02T00:00:00Z' };
    expect(await persistEntityCursor({ tenantId, connectionId, entityName: 'Accounts', cursor: c2, status: 'success', rowsSynced: 250, rowsTotal: 12000 })).toBe('persisted');
    row = await cursorRow('Accounts');
    expect(row).toMatchObject({ cursor_value: c2.value, last_status: 'success', rows_synced_last: '250', rows_total: '12000', last_error: null });
  });

  it('a state row needs no cursor, and a failure keeps the cursor it had', async () => {
    await persistEntityState({ tenantId, connectionId, entityName: 'Items', status: 'success', rowsSynced: 3, rowsTotal: 3 });
    let row = await cursorRow('Items');
    expect(row).toMatchObject({ cursor_type: null, cursor_value: null, last_status: 'success', rows_total: '3' });

    await persistEntityState({ tenantId, connectionId, entityName: 'Accounts', status: 'failed', error: 'HTTP 503 from EO (refresh_token=secret_abc)' });
    row = await cursorRow('Accounts');
    expect(row.cursor_value).toBe('2026-09-02T00:00:00Z');
    expect(row.last_status).toBe('failed');
    expect(row.last_error).toMatch(/HTTP 503/);
    expect(row.last_error).not.toMatch(/secret_abc/);
  });

  it('the catalog shows the rows the table holds, from the entity state', async () => {
    await getTestDb()('connections').where({ id: connectionId }).update({ warehouse_path: '/tmp/phase2-warehouse' });
    const tables = await listSourceTables(tenantId, connectionId);
    expect(tables.find((t) => t.tableName === 'Accounts')?.rowCount).toBe(12000);
    expect(tables.find((t) => t.tableName === 'Items')?.rowCount).toBe(3);
  });
});

// ─── The route: reconcile is a mode, not a flag on a full re-sync ──────────
describe('POST /api/connections/:id/sync — reconcile', () => {
  const sync = async (body: unknown) =>
    (await request()).post(`/api/connections/${connectionId}/sync`).set('Authorization', `Bearer ${token}`).send(body);

  it('refuses reconcile together with a full re-sync', async () => {
    const res = await sync({ full: true, reconcile: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be combined/);
  });

  it('records mode=reconcile and leaves every cursor alone', async () => {
    const before = await cursorRow('Accounts');
    const res = await sync({ reconcile: true });
    expect(res.status).toBe(202);
    const run = await waitTerminal(res.body.data.syncRunId);
    expect(run).toBeDefined();
    const row = await getTestDb()('source_sync_runs').where({ id: res.body.data.syncRunId }).first();
    expect(row.mode).toBe('reconcile');
    expect((await cursorRow('Accounts')).cursor_value).toBe(before.cursor_value);
  });
});

// ─── The orchestrator end to end, through a fake worker ───────────────────
class FakeLauncher implements JobLauncher {
  specs: JobSpec[] = [];
  constructor(private readonly script: (spec: JobSpec, runIndex: number) => WorkerEvent[]) {}
  launch(spec: JobSpec, onEvent: (e: WorkerEvent) => void): JobHandle {
    this.specs.push(spec);
    const events = this.script(spec, this.specs.length - 1);
    const done = new Promise<{ exitCode: number }>((resolve) => {
      setTimeout(() => {
        for (const e of events) onEvent(e);
        resolve({ exitCode: 0 });
      }, 20);
    });
    return { done, cancel: () => undefined };
  }
}

const ts = () => new Date().toISOString();

describe('a load stopped at its time budget resumes in a continuation run', () => {
  it('persists the checkpoint on arrival, queues one continuation for the unfinished entities from their cursors, and finishes', async () => {
    await getTestDb()('entity_sync_cursors').where({ connection_id: connectionId }).del();
    await getTestDb()('source_sync_runs').where({ connection_id: connectionId }).del();
    const launcher = new FakeLauncher((spec, runIndex) => {
      if (runIndex === 0) {
        return [
          { type: 'started', ts: ts() },
          { type: 'entity_complete', ts: ts(), entity: 'Items', rowsWritten: 5, bytesWritten: 100, rowsTotal: 5, cursor: { type: 'timestamp', value: '2026-09-05T00:00:00' } },
          { type: 'entity_checkpoint', ts: ts(), entity: 'Accounts', cursor: { type: 'timestamp', value: '2026-09-01T00:00:00' }, rowsSoFar: 50000 },
          { type: 'entity_checkpoint', ts: ts(), entity: 'Accounts', cursor: { type: 'timestamp', value: '2026-09-03T00:00:00' }, rowsSoFar: 100000 },
          { type: 'result', ts: ts(), rowCounts: { Items: 5, Accounts: 100000 }, warnings: [], cursors: { Items: { type: 'timestamp', value: '2026-09-05T00:00:00' } },
            incompleteEntities: { Accounts: { reason: 'time_budget', rowsSoFar: 100000, cursor: { type: 'timestamp', value: '2026-09-03T00:00:00' } } } },
        ];
      }
      return [
        { type: 'started', ts: ts() },
        { type: 'entity_complete', ts: ts(), entity: 'Accounts', rowsWritten: 0, bytesWritten: 100, rowsTotal: 120000, cursor: { type: 'timestamp', value: '2026-09-04T00:00:00' } },
        { type: 'result', ts: ts(), rowCounts: { Accounts: 0 }, warnings: [], cursors: { Accounts: { type: 'timestamp', value: '2026-09-04T00:00:00' } } },
      ];
    });
    setJobLauncher(launcher);

    const first = await triggerSync({ connectionId, tenantId });
    expect(first.started).toBe(true);
    const run1 = await waitTerminal(first.syncRunId);
    expect(run1?.status).toBe('succeeded');
    const row1 = await getTestDb()('source_sync_runs').where({ id: first.syncRunId }).first();
    expect(Object.keys(row1.incomplete_entities ?? {})).toEqual(['Accounts']);
    expect(JSON.stringify(row1.warnings)).toMatch(/continues in a follow-up run/);
    // The first launch carried a deadline the worker can budget against.
    expect(Date.parse(launcher.specs[0].deadlineAt ?? '')).toBeGreaterThan(Date.now());

    // The continuation: same connection, only the unfinished entity, resumed
    // from the checkpoint the first run persisted on arrival.
    for (let i = 0; i < 50 && launcher.specs.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    expect(launcher.specs).toHaveLength(2);
    expect(launcher.specs[1].entities).toEqual(['Accounts']);
    // Every cursor of the connection rides along (the connector uses the
    // ones in scope); the unfinished entity's is the CHECKPOINT, not the
    // value it started from.
    expect(launcher.specs[1].cursors?.Accounts).toEqual({ type: 'timestamp', value: '2026-09-03T00:00:00' });
    expect(launcher.specs[1].fullResync).toBe(false);
    const run2Row = await getTestDb()('source_sync_runs').where({ resumed_from_run_id: first.syncRunId }).first();
    expect(run2Row).toBeDefined();
    const run2 = await waitTerminal(run2Row.id);
    expect(run2?.status).toBe('succeeded');
    expect((await getTestDb()('source_sync_runs').where({ id: run2Row.id }).first()).incomplete_entities).toBeNull();
    // No third run: the load is done.
    await new Promise((r) => setTimeout(r, 300));
    expect(launcher.specs).toHaveLength(2);

    // Per-entity state: Items finished in run 1, Accounts in run 2.
    expect(await cursorRow('Items')).toMatchObject({ last_status: 'success', cursor_value: '2026-09-05T00:00:00', rows_total: '5' });
    expect(await cursorRow('Accounts')).toMatchObject({ last_status: 'success', cursor_value: '2026-09-04T00:00:00', rows_total: '120000' });
  });

  it('a stop with NO progress is a partial run that says why, and nothing is queued', async () => {
    await getTestDb()('source_sync_runs').where({ connection_id: connectionId }).del();
    const launcher = new FakeLauncher(() => [
      { type: 'started', ts: ts() },
      { type: 'result', ts: ts(), rowCounts: {}, warnings: [],
        incompleteEntities: { Accounts: { reason: 'time_budget', rowsSoFar: 0 }, Items: { reason: 'time_budget', rowsSoFar: 0 } } },
    ]);
    setJobLauncher(launcher);
    const first = await triggerSync({ connectionId, tenantId });
    const run = await waitTerminal(first.syncRunId);
    expect(run?.status).toBe('partial');
    const row = await getTestDb()('source_sync_runs').where({ id: first.syncRunId }).first();
    expect(row.error_message).toMatch(/no progress/);
    await new Promise((r) => setTimeout(r, 300));
    expect(launcher.specs).toHaveLength(1);
    expect(await getTestDb()('source_sync_runs').where({ resumed_from_run_id: first.syncRunId }).first()).toBeUndefined();
    expect((await cursorRow('Accounts')).last_status).toBe('incomplete');
  });

  it('a state-only cursor row is not handed to the worker as a watermark', async () => {
    await getTestDb()('source_sync_runs').where({ connection_id: connectionId }).del();
    await getTestDb()('entity_sync_cursors').where({ connection_id: connectionId }).del();
    await persistEntityState({ tenantId, connectionId, entityName: 'Items', status: 'success', rowsTotal: 9 });
    await persistEntityCursor({ tenantId, connectionId, entityName: 'Accounts', cursor: { type: 'timestamp', value: '2026-09-06T00:00:00' }, status: 'success' });
    const launcher = new FakeLauncher(() => [{ type: 'started', ts: ts() }, { type: 'result', ts: ts(), rowCounts: {}, warnings: [] }]);
    setJobLauncher(launcher);
    const first = await triggerSync({ connectionId, tenantId });
    await waitTerminal(first.syncRunId);
    expect(launcher.specs[0].cursors).toEqual({ Accounts: { type: 'timestamp', value: '2026-09-06T00:00:00' } });
  });
});

// ─── The read side hides soft-deleted rows and the technical columns ───────
describe('createScanView over a soft-delete table', () => {
  it('hides deleted rows and the _clarion_* columns; a legacy file reads as before', async () => {
    const root = path.join(os.tmpdir(), `phase2-views-${randomUUID()}`);
    await fs.mkdir(root, { recursive: true });
    try {
      const writer = new LocalFileWarehouseWriter(root);
      async function* rows() { yield { ID: 1, Name: 'a' }; yield { ID: 2, Name: 'b' }; yield { ID: 3, Name: 'c' }; }
      await writer.writeTable('Accounts', rows(), { mergeKey: 'ID' });
      await writer.reconcileKeys('Accounts', 'ID', (async function* () { yield 1; yield 3; })());
      // A file from before the columns existed.
      await fs.mkdir(path.join(root, 'Legacy'), { recursive: true });
      const db = await Database.create(':memory:');
      try {
        const p = path.join(root, 'Legacy', 'data.parquet').replace(/'/g, "''");
        await db.all(`COPY (SELECT * FROM (VALUES (1, 'x'), (2, 'y')) t(ID, Name)) TO '${p}' (FORMAT parquet)`);
        await createScanView(db, 'accounts_v', path.join(root, 'Accounts'));
        await createScanView(db, 'legacy_v', path.join(root, 'Legacy'));
        const cols = (await db.all(`DESCRIBE accounts_v`) as Array<{ column_name: string }>).map((c) => c.column_name);
        expect(cols).toEqual(['ID', 'Name']);
        const ids = (await db.all(`SELECT ID FROM accounts_v ORDER BY ID`) as Array<{ ID: bigint }>).map((r) => Number(r.ID));
        expect(ids).toEqual([1, 3]);
        const legacy = (await db.all(`SELECT ID FROM legacy_v ORDER BY ID`) as Array<{ ID: number }>).map((r) => Number(r.ID));
        expect(legacy).toEqual([1, 2]);
      } finally {
        await db.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
