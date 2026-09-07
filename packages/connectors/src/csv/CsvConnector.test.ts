/**
 * CSV connector tests.
 *
 * Everything runs against real file bytes and a stub warehouse writer, so the
 * assertions are about what would actually land in the warehouse rather than
 * about the connector's internal shape.
 */

import { describe, expect, it, vi } from 'vitest';
import { validateEntityCatalog } from '../conformance';
import { createNoopLogger } from '../logging';
import { createCancellationToken } from '../BaseSourceConnector';
import type { SyncContext, TableWriteResult, WarehouseWriter } from '../types';
import { CsvConnector } from './CsvConnector';
import { MAX_BASE64_LENGTH } from './schema';

const log = createNoopLogger();
const probeCtx = { log };

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
function b64bytes(...vals: number[]): string {
  return Buffer.from(Uint8Array.from(vals)).toString('base64');
}

const SALES = [
  'Klant;Bedrag;Datum',
  'Acme;1.234,56;07/09/2026',
  'Globex;900,00;08/09/2026',
].join('\n');

function config(over: Record<string, unknown> = {}) {
  return { filename: 'Verkoop 2026.csv', fileContent: b64(SALES), ...over };
}

/** Records what the connector would have written, without touching DuckDB. */
function stubWriter() {
  const written: Array<{
    table: string;
    rows: Record<string, unknown>[];
    columns?: readonly { name: string; sqlType: string }[];
  }> = [];
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
  it('reports how the file was read, not merely that it was', async () => {
    // Every one of these was inferred and every one can be wrong. The wizard
    // is the only place the user gets to correct it before the data lands.
    const res = await new CsvConnector().testConnection(config(), probeCtx);
    expect(res.ok).toBe(true);
    expect(res.details).toMatchObject({
      file: 'Verkoop 2026.csv',
      table: 'Verkoop_2026',
      separator: 'semicolon',
      encoding: 'utf-8',
      columns: '3',
      rows: '2',
    });
  });

  it('reports the Windows code page when that is what the bytes are', async () => {
    // Excel's plain "CSV (comma delimited)" export on a Western European
    // Windows. `Café` decoded as UTF-8 is a hard failure.
    const bytes = b64bytes(0x4e, 0x61, 0x61, 0x6d, 0x0a, 0x43, 0x61, 0x66, 0xe9);
    const res = await new CsvConnector().testConnection(config({ fileContent: bytes }), probeCtx);
    expect(res.ok).toBe(true);
    expect(res.details).toMatchObject({ encoding: 'windows-1252' });
  });

  it('names the right connector when the file is really a workbook', async () => {
    // The commonest mistake here, and the message has to name the fix rather
    // than report a parse failure.
    const xlsx = b64bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
    const res = await new CsvConnector().testConnection(config({ fileContent: xlsx }), probeCtx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Excel file source/);
  });

  it('names an old .xls for what it is', async () => {
    const xls = b64bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1);
    const res = await new CsvConnector().testConnection(config({ fileContent: xls }), probeCtx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/old \.xls/);
  });

  it('rejects a file with nothing readable in it', async () => {
    const res = await new CsvConnector().testConnection(config({ fileContent: b64('   \n  ') }), probeCtx);
    expect(res.ok).toBe(false);
  });

  it('names UTF-16 saved without a byte-order mark', async () => {
    // Every second byte is zero, so this is not text at all — and the fix is a
    // re-save, not anything the user can do in Clarion.
    const utf16 = b64bytes(0x61, 0x00, 0x2c, 0x00, 0x62, 0x00);
    const res = await new CsvConnector().testConnection(config({ fileContent: utf16 }), probeCtx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/CSV UTF-8/);
  });

  it('refuses a config missing the file', async () => {
    await expect(
      new CsvConnector().testConnection({ filename: 'x.csv' }, probeCtx),
    ).rejects.toThrow(/Config validation failed/);
  });

  it('honours a separator the user pinned over the one it would have guessed', async () => {
    const res = await new CsvConnector().testConnection(config({ delimiter: 'comma' }), probeCtx);
    // Forced onto commas, a semicolon file splits on the decimal separator
    // instead — three columns become two, mangled. Which is the point of
    // reporting the reading: this is visible in the wizard, before the sync.
    expect(res.details).toMatchObject({ separator: 'comma', columns: '2' });
  });
});

describe('listEntities', () => {
  it('returns one entity, because one file is one table', async () => {
    const entities = await new CsvConnector().listEntities(config(), probeCtx);
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe('Verkoop_2026');
    expect(entities[0].description).toContain('2 rows, 3 columns');
  });

  it('lets the user pin the table name so a re-upload does not orphan it', async () => {
    // Uploading `Verkoop 2026 v2.csv` over the original would otherwise rename
    // the table and strand every dashboard built on it.
    const entities = await new CsvConnector().listEntities(
      config({ tableName: 'Verkoop' }), probeCtx,
    );
    expect(entities[0].name).toBe('Verkoop');
  });

  it('never declares incremental sync', async () => {
    // A file has no per-row modification stamp and no business key, so a
    // cursor would make the writer wipe the table on every delta.
    const [e] = await new CsvConnector().listEntities(config(), probeCtx);
    expect(e.supportsIncremental).toBe(false);
    expect(e.incrementalCursor).toBeUndefined();
  });

  it('passes the framework entity invariants, which the static gate cannot check', async () => {
    const entities = await new CsvConnector().listEntities(config(), probeCtx);
    expect(validateEntityCatalog('csv', entities)).toEqual([]);
  });
});

describe('sync', () => {
  it('writes the file with an explicit, inferred column schema', async () => {
    const { writer, written } = stubWriter();
    const res = await new CsvConnector().sync(config(), { entities: ['Verkoop_2026'] }, syncCtx(writer));

    expect(res.rowCounts).toEqual({ Verkoop_2026: 2 });
    expect(written).toHaveLength(1);
    expect(written[0].columns).toEqual([
      { name: 'Klant', sqlType: 'VARCHAR' },
      { name: 'Bedrag', sqlType: 'DOUBLE' },
      { name: 'Datum', sqlType: 'DATE' },
    ]);
    expect(written[0].rows).toEqual([
      { Klant: 'Acme', Bedrag: 1234.56, Datum: '2026-09-07' },
      { Klant: 'Globex', Bedrag: 900, Datum: '2026-09-08' },
    ]);
  });

  it('writes a header-only file as an empty table rather than skipping it', async () => {
    const { writer, written } = stubWriter();
    const res = await new CsvConnector().sync(
      config({ fileContent: b64('Klant;Bedrag') }),
      { entities: ['Verkoop_2026'] },
      syncCtx(writer),
    );
    expect(res.rowCounts).toEqual({ Verkoop_2026: 0 });
    expect(written.map((w) => w.table)).toEqual(['Verkoop_2026']);
    expect(res.warnings.join(' ')).toMatch(/no data rows/);
  });

  it('says the table was renamed instead of silently writing nothing', async () => {
    const { writer, written } = stubWriter();
    const res = await new CsvConnector().sync(config(), { entities: ['Oud'] }, syncCtx(writer));
    expect(written).toHaveLength(0);
    expect(res.rowCounts).toEqual({ Oud: 0 });
    expect(res.warnings.join(' ')).toMatch(/now called 'Verkoop_2026'/);
  });

  it('does nothing when nothing was selected', async () => {
    const { writer, written } = stubWriter();
    const res = await new CsvConnector().sync(config(), { entities: [] }, syncCtx(writer));
    expect(written).toHaveLength(0);
    expect(res.warnings).toHaveLength(1);
  });

  it('reports a failure as a warning rather than failing the whole run', async () => {
    const { writer, written } = stubWriter();
    const res = await new CsvConnector().sync(
      config({ fileContent: b64('   ') }),
      { entities: ['Verkoop_2026'] },
      syncCtx(writer),
    );
    expect(written).toHaveLength(0);
    expect(res.rowCounts).toEqual({ Verkoop_2026: 0 });
    expect(res.warnings.join(' ')).toMatch(/failed/);
  });
});

describe('describeEntities', () => {
  it('hands the catalog the heading the user typed, and no invented description', async () => {
    const content = b64('Bedrag (EUR);Klant\n1.234,56;Acme');
    const docs = await new CsvConnector().describeEntities(
      config({ fileContent: content }), ['Verkoop_2026'], probeCtx,
    );
    expect(docs).toHaveLength(1);
    const cols = docs[0].columns;
    expect(cols.find((c) => c.name === 'Bedrag_EUR')?.displayName).toBe('Bedrag (EUR)');
    // A heading is a name, not documentation — claiming otherwise would put a
    // fabricated description at the trusted rung.
    expect(cols.every((c) => c.description === undefined)).toBe(true);
    expect(docs[0].provenance).toBe('declared');
  });

  it('omits a display name identical to the column name', async () => {
    const docs = await new CsvConnector().describeEntities(config(), ['Verkoop_2026'], probeCtx);
    expect(docs[0].columns.find((c) => c.name === 'Klant')?.displayName).toBeUndefined();
  });

  it('says nothing about an entity that was not selected', async () => {
    expect(await new CsvConnector().describeEntities(config(), ['Anders'], probeCtx)).toEqual([]);
  });
});

describe('connector surface', () => {
  const c = new CsvConnector();

  it('declares that it reaches no network at all', () => {
    // Not an omission: an empty list makes the shared HTTP client refuse every
    // request, so a future call added here fails loudly rather than quietly.
    expect(c.egressAllowList).toEqual([]);
  });

  it('caps the upload in the units the validator measures', () => {
    expect(MAX_BASE64_LENGTH).toBe(Math.ceil((15 * 1024 * 1024) / 3) * 4);
  });

  it('has no OAuth handshake', () => {
    expect(c.oauth).toBeUndefined();
  });
});
