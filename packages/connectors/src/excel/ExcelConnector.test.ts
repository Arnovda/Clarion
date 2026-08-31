/**
 * Excel connector tests.
 *
 * Everything runs against real .xlsx bytes from the fixture builder and a
 * stub warehouse writer, so the assertions are about what would actually land
 * in the warehouse rather than about the connector's internal shape.
 */

import { describe, expect, it, vi } from 'vitest';
import { validateEntityCatalog } from '../conformance';
import { createNoopLogger } from '../logging';
import { createCancellationToken } from '../BaseSourceConnector';
import { buildXlsxFixture } from '../spreadsheet/__fixtures__/xlsxFixture';
import { assertSheetComplete, SheetTooLargeError } from '../spreadsheet/tabular';
import type { SyncContext, TableWriteResult, WarehouseWriter } from '../types';
import { ExcelConnector } from './ExcelConnector';
import { MAX_BASE64_LENGTH } from './schema';

const log = createNoopLogger();
const probeCtx = { log };

function b64(sheets: Parameters<typeof buildXlsxFixture>[0]): string {
  return Buffer.from(buildXlsxFixture(sheets)).toString('base64');
}

const BUDGET = [
  {
    name: 'Overzicht',
    rows: [
      ['Klant', 'Bedrag (EUR)', 'Actief'],
      ['Acme', 1200, true],
      ['Globex', 800, false],
    ] as (string | number | boolean | null)[][],
  },
  { name: 'Leeg', rows: [] as (string | number | boolean | null)[][] },
];

function config(over: Record<string, unknown> = {}) {
  return { filename: 'Budget 2026.xlsx', fileContent: b64(BUDGET), ...over };
}

/** Records what the connector would have written, without touching DuckDB. */
function stubWriter() {
  const written: Array<{ table: string; rows: Record<string, unknown>[]; columns?: readonly { name: string; sqlType: string }[] }> = [];
  const writer: WarehouseWriter = {
    async writeTable(tableName, rows, opts): Promise<TableWriteResult> {
      const collected: Record<string, unknown>[] = [];
      for await (const r of rows) collected.push(r);
      written.push({ table: tableName, rows: collected, columns: opts?.columns });
      return { rowsWritten: collected.length, bytesWritten: 0, warehousePath: `${tableName}/data.parquet` };
    },
  };
  return { writer, written };
}

function syncCtx(writer: WarehouseWriter): SyncContext {
  return {
    tenantId: '1',
    connectionId: '1',
    warehouseWriter: writer,
    log,
    progress: vi.fn(),
    cancellationToken: createCancellationToken(),
  };
}

describe('testConnection', () => {
  it('reports what is in the workbook', async () => {
    const res = await new ExcelConnector().testConnection(config(), probeCtx);
    expect(res.ok).toBe(true);
    expect(res.details).toMatchObject({ file: 'Budget 2026.xlsx', worksheets: '2' });
  });

  it('names the real problem when the file is not an xlsx', async () => {
    // The commonest mistake by far: a CSV or an old .xls renamed. Catching it
    // in the wizard is the whole reason this method does real work.
    const notXlsx = Buffer.from('Klant,Bedrag\nAcme,100').toString('base64');
    const res = await new ExcelConnector().testConnection(config({ fileContent: notXlsx }), probeCtx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not an \.xlsx workbook/i);
    expect(res.error).toContain('Budget 2026.xlsx');
  });

  it('rejects an empty upload', async () => {
    const res = await new ExcelConnector().testConnection(config({ fileContent: 'AA==' }), probeCtx);
    expect(res.ok).toBe(false);
  });

  it('refuses a config missing the file', async () => {
    await expect(
      new ExcelConnector().testConnection({ filename: 'x.xlsx' }, probeCtx),
    ).rejects.toThrow(/Config validation failed/);
  });
});

describe('listEntities', () => {
  it('returns one entity per worksheet, named by sheet', async () => {
    // The source IS one file, so the sheet name alone identifies the table —
    // and re-uploading a renamed file then keeps the existing tables.
    const entities = await new ExcelConnector().listEntities(config(), probeCtx);
    expect(entities.map((e) => e.name)).toEqual(['Overzicht', 'Leeg']);
    expect(entities[0].description).toContain('2 rows, 3 columns');
  });

  it('lists an empty tab rather than hiding it', async () => {
    const entities = await new ExcelConnector().listEntities(config(), probeCtx);
    expect(entities[1].description).toContain('Empty worksheet');
  });

  it('never declares incremental sync', async () => {
    for (const e of await new ExcelConnector().listEntities(config(), probeCtx)) {
      expect(e.supportsIncremental).toBe(false);
      expect(e.incrementalCursor).toBeUndefined();
    }
  });

  it('keeps two tabs whose names sanitise alike as two tables', async () => {
    const content = b64([
      { name: 'Q1 2026', rows: [['a'], [1]] },
      { name: 'Q1/2026', rows: [['b'], [2]] },
    ]);
    const entities = await new ExcelConnector().listEntities(config({ fileContent: content }), probeCtx);
    expect(new Set(entities.map((e) => e.name)).size).toBe(2);
  });

  it('passes the framework entity invariants, which the static gate cannot check', async () => {
    const entities = await new ExcelConnector().listEntities(config(), probeCtx);
    expect(validateEntityCatalog('excel', entities)).toEqual([]);
  });
});

describe('sync', () => {
  it('writes the sheet with an explicit, inferred column schema', async () => {
    const { writer, written } = stubWriter();
    const res = await new ExcelConnector().sync(config(), { entities: ['Overzicht'] }, syncCtx(writer));

    expect(res.rowCounts).toEqual({ Overzicht: 2 });
    expect(written).toHaveLength(1);
    expect(written[0].table).toBe('Overzicht');
    expect(written[0].columns).toEqual([
      { name: 'Klant', sqlType: 'VARCHAR' },
      { name: 'Bedrag_EUR', sqlType: 'BIGINT' },
      { name: 'Actief', sqlType: 'BOOLEAN' },
    ]);
    expect(written[0].rows).toEqual([
      { Klant: 'Acme', Bedrag_EUR: 1200, Actief: true },
      { Klant: 'Globex', Bedrag_EUR: 800, Actief: false },
    ]);
  });

  it('writes an empty tab as an empty table rather than skipping it', async () => {
    const { writer, written } = stubWriter();
    const res = await new ExcelConnector().sync(config(), { entities: ['Leeg'] }, syncCtx(writer));
    expect(res.rowCounts).toEqual({ Leeg: 0 });
    expect(written.map((w) => w.table)).toEqual(['Leeg']);
    expect(res.warnings.join(' ')).toMatch(/empty/i);
  });

  it('names a worksheet that has disappeared instead of silently writing nothing', async () => {
    const { writer, written } = stubWriter();
    const res = await new ExcelConnector().sync(config(), { entities: ['Weg'] }, syncCtx(writer));
    expect(written).toHaveLength(0);
    expect(res.rowCounts).toEqual({ Weg: 0 });
    expect(res.warnings.join(' ')).toMatch(/renamed or removed/);
  });

  it('syncs the tabs asked for and no others', async () => {
    const { writer, written } = stubWriter();
    await new ExcelConnector().sync(config(), { entities: ['Overzicht'] }, syncCtx(writer));
    expect(written.map((w) => w.table)).toEqual(['Overzicht']);
  });

  it('does nothing when no worksheet was selected', async () => {
    const { writer, written } = stubWriter();
    const res = await new ExcelConnector().sync(config(), { entities: [] }, syncCtx(writer));
    expect(written).toHaveLength(0);
    expect(res.warnings).toHaveLength(1);
  });
});

describe('the truncation guard', () => {
  it('refuses a partially-read sheet before anything is written', () => {
    // The single most important rule in the spreadsheet path: a partial table
    // looks complete, so every answer built on it is quietly wrong.
    expect(() => assertSheetComplete({ name: 'S', rows: [[1]], truncated: true }))
      .toThrow(SheetTooLargeError);
    expect(() => assertSheetComplete({ name: 'S', rows: [[1]], truncated: true }))
      .toThrow(/Nothing was written/);
  });

  it('passes a sheet that was read in full', () => {
    expect(() => assertSheetComplete({ name: 'S', rows: [[1]], truncated: false })).not.toThrow();
  });
});

describe('describeEntities', () => {
  it('hands the catalog the heading the user typed, and no invented description', async () => {
    const docs = await new ExcelConnector().describeEntities(config(), ['Overzicht'], probeCtx);
    expect(docs).toHaveLength(1);
    const cols = docs[0].columns;
    expect(cols.find((c) => c.name === 'Bedrag_EUR')?.displayName).toBe('Bedrag (EUR)');
    // A heading is a name, not documentation — claiming otherwise would put a
    // fabricated description at the trusted rung.
    expect(cols.every((c) => c.description === undefined)).toBe(true);
    expect(docs[0].provenance).toBe('declared');
  });

  it('omits a display name identical to the column name', async () => {
    const docs = await new ExcelConnector().describeEntities(config(), ['Overzicht'], probeCtx);
    expect(docs[0].columns.find((c) => c.name === 'Klant')?.displayName).toBeUndefined();
  });
});

describe('connector surface', () => {
  const c = new ExcelConnector();

  it('declares that it reaches no network at all', () => {
    // Not an omission: an empty list makes the shared HTTP client refuse every
    // request, so a future call added here fails loudly rather than quietly.
    expect(c.egressAllowList).toEqual([]);
  });

  it('caps the upload in the units the validator measures', () => {
    // ~15 MB of file. Stated in base64 length because that is what maxLength
    // actually bounds.
    expect(MAX_BASE64_LENGTH).toBe(Math.ceil((15 * 1024 * 1024) / 3) * 4);
  });

  it('has no OAuth handshake', () => {
    expect(c.oauth).toBeUndefined();
  });
});
