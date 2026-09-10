/**
 * `BaseSourceConnector.writeEntityInChunks` — the resumable-load mechanism
 * (phase 2, B3), pinned on a fake writer so every rule is a unit test:
 * chunk boundaries, the checkpoint after each chunk, the time budget's
 * clean stop, the one-row lookahead, and the no-merge-key fallback.
 */
import { describe, expect, it } from 'vitest';
import { BaseSourceConnector, createCancellationToken } from './BaseSourceConnector';
import type { SyncContext, TableWriteResult, WarehouseWriter, WriteTableOptions } from './types';
import { createNoopLogger } from './logging';

class Probe extends BaseSourceConnector {
  readonly type = 'probe';
  readonly displayName = 'Probe';
  readonly configSchema = { type: 'object' as const, properties: {} };
  readonly egressAllowList = [] as const;
  async testConnection() { return { ok: true }; }
  async listEntities() { return []; }
  async sync() { return { rowCounts: {}, warnings: [] }; }
  static chunks = BaseSourceConnector['writeEntityInChunks'];
}

interface Call { rows: Array<Record<string, unknown>>; opts?: WriteTableOptions }

function fakeWriter(): WarehouseWriter & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async writeTable(_t, rows, opts) {
      const collected: Array<Record<string, unknown>> = [];
      for await (const r of rows) collected.push(r);
      calls.push({ rows: collected, opts });
      const total = calls.reduce((n, c) => n + c.rows.length, 0);
      const res: TableWriteResult = { rowsWritten: collected.length, bytesWritten: total * 10, warehousePath: 'x', rowsTotal: total };
      return res;
    },
  };
}

function ctxWith(writer: WarehouseWriter, extra: Partial<SyncContext> = {}): SyncContext {
  return {
    tenantId: 't', connectionId: 'c', warehouseWriter: writer, log: createNoopLogger(), progress: () => undefined,
    cancellationToken: createCancellationToken(), ...extra,
  };
}

async function* rowsFrom(n: number, start = 1): AsyncIterable<Record<string, unknown>> {
  for (let i = start; i < start + n; i++) yield { ID: i, Modified: `2026-09-10T00:00:${String(i).padStart(2, '0')}` };
}

describe('writeEntityInChunks', () => {
  it('flushes every chunkRows rows and checkpoints the highest cursor written so far', async () => {
    const writer = fakeWriter();
    const checkpoints: Array<{ value: string; rowsSoFar: number }> = [];
    const ctx = ctxWith(writer, { onEntityCheckpoint: (c) => { checkpoints.push({ value: c.cursor.value, rowsSoFar: c.rowsSoFar }); } });
    const r = await Probe.chunks({
      entity: 'E', rows: rowsFrom(7), ctx, writeOpts: { mergeKey: 'ID', replace: true }, chunkRows: 3,
      checkpoint: { type: 'timestamp', cursorOf: (row) => row.Modified as string },
    });
    expect(writer.calls.map((c) => c.rows.length)).toEqual([3, 3, 1]);
    // The first chunk keeps the caller's options; later chunks always merge.
    expect(writer.calls[0].opts).toEqual({ mergeKey: 'ID', replace: true });
    expect(writer.calls[1].opts).toEqual({ mergeKey: 'ID', replace: false });
    expect(checkpoints).toEqual([
      { value: '2026-09-10T00:00:03', rowsSoFar: 3 },
      { value: '2026-09-10T00:00:06', rowsSoFar: 6 },
      { value: '2026-09-10T00:00:07', rowsSoFar: 7 },
    ]);
    expect(r).toMatchObject({ rowsWritten: 7, rowsTotal: 7, maxCursorSeen: '2026-09-10T00:00:07', stoppedForBudget: false });
  });

  it('an exact multiple of the chunk size does not cost an extra empty merge (one-row lookahead)', async () => {
    const writer = fakeWriter();
    await Probe.chunks({ entity: 'E', rows: rowsFrom(6), ctx: ctxWith(writer), writeOpts: { mergeKey: 'ID' }, chunkRows: 3 });
    expect(writer.calls.map((c) => c.rows.length)).toEqual([3, 3]);
  });

  it('an empty source is exactly one empty write (the writer decides preserve / empty parquet)', async () => {
    const writer = fakeWriter();
    const r = await Probe.chunks({ entity: 'E', rows: rowsFrom(0), ctx: ctxWith(writer), writeOpts: { mergeKey: 'ID' }, chunkRows: 3 });
    expect(writer.calls.map((c) => c.rows.length)).toEqual([0]);
    expect(r.rowsWritten).toBe(0);
  });

  it('without a merge key there is one write however many rows arrive', async () => {
    const writer = fakeWriter();
    await Probe.chunks({ entity: 'E', rows: rowsFrom(10), ctx: ctxWith(writer), writeOpts: { columns: [{ name: 'ID', sqlType: 'BIGINT' }] }, chunkRows: 2 });
    expect(writer.calls.map((c) => c.rows.length)).toEqual([10]);
  });

  it('the time budget stops the entity cleanly: what was fetched is flushed and checkpointed, the source iterator is closed', async () => {
    const writer = fakeWriter();
    let pulled = 0;
    let closed = false;
    const source: AsyncIterable<Record<string, unknown>> = {
      [Symbol.asyncIterator]() {
        return {
          async next() { pulled += 1; return { done: false, value: { ID: pulled, Modified: `2026-09-10T00:00:${String(pulled).padStart(2, '0')}` } }; },
          async return() { closed = true; return { done: true, value: undefined }; },
        };
      },
    };
    let ticks = 0;
    const checkpoints: string[] = [];
    const ctx = ctxWith(writer, {
      // Out of time after four rows.
      timeBudget: { shouldStop: () => (ticks += 1) > 4, remainingMs: () => 0 },
      onEntityCheckpoint: (c) => { checkpoints.push(c.cursor.value); },
    });
    const r = await Probe.chunks({
      entity: 'E', rows: source, ctx, writeOpts: { mergeKey: 'ID' }, chunkRows: 100,
      checkpoint: { type: 'timestamp', cursorOf: (row) => row.Modified as string },
    });
    expect(r.stoppedForBudget).toBe(true);
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0].rows.length).toBeGreaterThan(0);
    expect(writer.calls[0].rows.length).toBeLessThan(10);
    expect(checkpoints).toEqual([r.maxCursorSeen]);
    expect(closed).toBe(true);
  });

  it('a budget that is already spent still writes at least one row per chunk, never a zero-row merge', async () => {
    const writer = fakeWriter();
    const ctx = ctxWith(writer, { timeBudget: { shouldStop: () => true, remainingMs: () => 0 } });
    const r = await Probe.chunks({ entity: 'E', rows: rowsFrom(5), ctx, writeOpts: { mergeKey: 'ID' }, chunkRows: 100 });
    expect(writer.calls.map((c) => c.rows.length)).toEqual([1]);
    expect(r.stoppedForBudget).toBe(true);
  });
});
