/**
 * The soft-delete firewall has no bypass.
 *
 * Ingestion phase 2 (B2) made deletes SOFT: a row the source no longer has is
 * marked with `_clarion_deleted`, never removed. Every reader is protected by
 * ONE rule — `parquetSelect` in services/warehouse/views.ts — and the failure
 * mode when a read escapes it is the worst this platform has: no error, a
 * rendered dashboard, a wrong total.
 *
 * Two escapes existed and are pinned closed here:
 *   1. `createScanView`'s `*.parquet` glob fallbacks (local and Azure)
 *      registered the file raw, so any table not written under the
 *      `data.parquet` convention served its tombstones.
 *   2. The dbt transformation engine built its source views as hook SQL that
 *      ran in dbt's own DuckDB process, where the rule could not be applied.
 *      Its entry point refused from 2026-09-10 and the engine was deleted on
 *      2026-09-20 — there is no second door left to pin.
 *
 * The structural half of the same guarantee is the `warehouse-scan` ratchet
 * (backend/scripts/lint-warehouse-scan.ts), which fails the merge on a new
 * raw scan. These tests prove the behaviour; the ratchet stops it coming back.
 */
import { describe, it, expect } from 'vitest';
import { Database } from 'duckdb-async';
import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DELETED_COL, SYNCED_AT_COL } from '@databridge/connectors';
import { createScanView } from '../services/warehouse';
import { runProductTransformation } from '../services/transformationRunner';

/**
 * Write `<dir>/<name>.parquet` carrying the phase-2 columns. Deliberately NOT
 * `data.parquet`: this is the glob fallback's territory, which is the branch
 * that used to bypass the firewall.
 */
async function writePart(
  db: Database,
  dir: string,
  name: string,
  rows: Array<{ id: number; label: string; deleted: boolean }>,
): Promise<void> {
  const values = rows
    .map((r) => `(${r.id}, '${r.label}', TIMESTAMPTZ '2026-09-10 00:00:00+00', ${r.deleted})`)
    .join(', ');
  const p = path.join(dir, `${name}.parquet`).replace(/'/g, "''");
  await db.all(
    `COPY (SELECT * FROM (VALUES ${values}) t(id, label, "${SYNCED_AT_COL}", "${DELETED_COL}")) ` +
    `TO '${p}' (FORMAT parquet)`,
  );
}

describe('createScanView — the *.parquet glob fallback', () => {
  it('hides deleted rows and the _clarion_* columns across every part file', async () => {
    const root = path.join(os.tmpdir(), `firewall-${randomUUID()}`);
    const dir = path.join(root, 'Accounts');
    await fs.mkdir(dir, { recursive: true });
    const db = await Database.create(':memory:');
    try {
      // Two parts, so the test also proves the glob still UNIONS them — a fix
      // that quietly narrowed the view to one file would pass a single-part
      // test while losing rows.
      await writePart(db, dir, 'part-0', [
        { id: 1, label: 'a', deleted: false },
        { id: 2, label: 'b', deleted: true },
      ]);
      await writePart(db, dir, 'part-1', [
        { id: 3, label: 'c', deleted: false },
        { id: 4, label: 'd', deleted: true },
      ]);

      await createScanView(db, 'accounts_v', dir);

      const cols = (await db.all('DESCRIBE accounts_v') as Array<{ column_name: string }>)
        .map((c) => c.column_name);
      expect(cols).toEqual(['id', 'label']);

      const ids = (await db.all('SELECT id FROM accounts_v ORDER BY id') as Array<{ id: bigint }>)
        .map((r) => Number(r.id));
      expect(ids).toEqual([1, 3]);
    } finally {
      await db.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a legacy part file — no _clarion_* columns — exactly as it was', async () => {
    const root = path.join(os.tmpdir(), `firewall-legacy-${randomUUID()}`);
    const dir = path.join(root, 'Legacy');
    await fs.mkdir(dir, { recursive: true });
    const db = await Database.create(':memory:');
    try {
      const p = path.join(dir, 'part-0.parquet').replace(/'/g, "''");
      await db.all(`COPY (SELECT * FROM (VALUES (1, 'x'), (2, 'y')) t(id, label)) TO '${p}' (FORMAT parquet)`);
      await createScanView(db, 'legacy_v', dir);
      const ids = (await db.all('SELECT id FROM legacy_v ORDER BY id') as Array<{ id: bigint }>)
        .map((r) => Number(r.id));
      expect(ids).toEqual([1, 2]);
    } finally {
      await db.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
