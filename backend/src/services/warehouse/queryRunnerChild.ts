/**
 * Query runner — CHILD process entrypoint.
 *
 * Runs DuckDB in its own OS process so the parent can do the one thing it can
 * never do in-process: actually STOP a query. A `Promise.race` timeout frees the
 * caller but leaves the query burning CPU and holding its concurrency permit for
 * its real duration; `kill(SIGKILL)` on a child ends it for real.
 *
 * It also contains the two failure modes that today take the whole API down for
 * every tenant: a DuckDB OOM (its docs note some operators bypass
 * `memory_limit`) and a native crash on a corrupt file. Here they kill one
 * runner, and the parent respawns.
 *
 * Protocol (JSON over the Node IPC channel — one in-flight query per child):
 *   parent → child  { type: 'init',  spec }        one-shot, first message
 *   child  → parent { type: 'ready' } | { type: 'init_error', message }
 *   parent → child  { type: 'query', id, sql }
 *   child  → parent { type: 'result', id, rows } | { type: 'error', id, message }
 *
 * BigInt is converted to Number here because it cannot cross JSON — the same
 * conversion the in-process path does after `db.all()`.
 */

import { Database } from 'duckdb-async';
import path from 'path';
import { setupDuckDBForWarehouse, createScanView, capResultRows, isAzurePath } from './index';

export interface RunnerSpec {
  warehousePath: string;
  isAzure: boolean;
  /** table name → absolute path/URI. Pre-resolved by the parent so the child
   *  never has to reimplement path logic (and can't disagree with it). */
  tablePaths: Array<[string, string]>;
  /** table name → schema name, for namespaced (notebook-style) sessions. */
  tableSchemas: Array<[string, string]>;
}

type ParentMessage =
  | { type: 'init'; spec: RunnerSpec }
  | { type: 'query'; id: number; sql: string };

let db: Database | null = null;

function send(msg: unknown): void {
  if (process.send) process.send(msg);
}

async function init(spec: RunnerSpec): Promise<void> {
  db = await Database.create(':memory:');
  await setupDuckDBForWarehouse(db, spec.isAzure);

  const schemas = new Map(spec.tableSchemas);
  const registeredSchemas = new Set<string>();

  for (const [tableName, tPath] of spec.tablePaths) {
    const schema = schemas.get(tableName);
    try {
      if (schema) {
        await db.exec(`CREATE SCHEMA IF NOT EXISTS "${schema.replace(/"/g, '""')}";`);
        registeredSchemas.add(schema);
      }
      const resolved = isAzurePath(tPath) ? tPath : path.resolve(tPath).replace(/\\/g, '/');
      await createScanView(db, tableName, resolved, schema ? { schema } : undefined);
    } catch {
      // Same policy as the in-process path: a table that fails to register is
      // skipped, not fatal — the query referencing it will fail on its own.
    }
  }

  if (registeredSchemas.size > 0) {
    const schemaList = [...registeredSchemas].map((s) => s.replace(/'/g, "''")).join(',');
    try {
      await db.exec(`SET search_path = '${schemaList}';`);
    } catch {
      /* non-fatal */
    }
  }
}

function normaliseRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    return out;
  });
}

process.on('message', (msg: ParentMessage) => {
  void (async () => {
    if (msg.type === 'init') {
      try {
        await init(msg.spec);
        send({ type: 'ready' });
      } catch (err) {
        send({ type: 'init_error', message: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      }
      return;
    }

    if (msg.type === 'query') {
      if (!db) {
        send({ type: 'error', id: msg.id, message: 'Runner not initialised' });
        return;
      }
      try {
        const raw = (await db.all(capResultRows(msg.sql))) as Record<string, unknown>[];
        send({ type: 'result', id: msg.id, rows: normaliseRows(raw) });
      } catch (err) {
        send({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
      }
    }
  })();
});

// If the parent goes away, don't linger holding a DuckDB session.
process.on('disconnect', () => process.exit(0));
