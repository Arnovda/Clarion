/**
 * CSV / delimited-text source connector.
 *
 * The cheapest possible second source, and for most customers the first one
 * that is not an ERP: a budget, a price list, a mapping someone maintains by
 * hand. Upload the file and it becomes a table Ask AI and dashboards query
 * like any other.
 *
 * Implements `SourceConnector` against bytes rather than an API:
 *   • testConnection — read the file and report HOW it was read
 *   • listEntities  — one entity, because one file is one table
 *   • sync          — turn the file into a warehouse table
 *   • describeEntities — hand the catalog the headings the user wrote
 *
 * Everything about turning rows into a table — column naming, dedupe, type
 * inference, the refusal on a partially-read file — is `../spreadsheet/
 * tabular`, shared with the Excel and SharePoint connectors. The only thing
 * this path adds is `../spreadsheet/csvReader`, which recovers the encoding,
 * the separator and the cell types a worksheet would have carried for free.
 *
 * TWO DIFFERENCES FROM THE EXCEL CONNECTOR, both following from the same rule
 * ("an entity is named by what identifies it WITHIN ITS SOURCE"):
 *
 * **One entity, not one per tab.** A workbook holds many sheets; a CSV holds
 * one table, so the source and the table are the same thing.
 *
 * **testConnection reports its READING, not just success.** For a workbook
 * "we opened it" is the whole answer. Here the answer is "we read this as
 * semicolon-separated Windows-1252 text, 4 columns, 812 rows" — because every
 * one of those was inferred, each can be wrong, and the wizard is the only
 * place the user can correct it before the data lands.
 */

import { BaseSourceConnector } from '../BaseSourceConnector';
import {
  CancellationError,
  type ConnectorConfig,
  type EntityDescriptor,
  type EntityDocs,
  type ProbeContext,
  type SourceConnector,
  type SyncContext,
  type SyncOptions,
  type SyncResult,
  type TestResult,
} from '../types';
import { SpreadsheetReadError } from '../spreadsheet/xlsxReader';
import { readCsv, type CsvEncoding, type CsvReadResult } from '../spreadsheet/csvReader';
import { assertSheetComplete, sanitiseEntityName, sheetToTable } from '../spreadsheet/tabular';
import {
  asCsvConfig,
  csvConfigSchema,
  DELIMITER_CHARS,
  delimiterLabel,
  MAX_FILE_BYTES,
  type CsvConfig,
} from './schema';

/**
 * File signatures that are definitely NOT delimited text. Catching them here
 * turns "no columns found" — which reads as a bug in Clarion — into a
 * sentence naming the actual mistake and the connector that handles it.
 */
const NOT_TEXT: ReadonlyArray<{ magic: number[]; advice: string }> = [
  { magic: [0x50, 0x4b, 0x03, 0x04], advice: 'This is an Excel workbook (.xlsx). Add it with the Excel file source instead.' },
  { magic: [0xd0, 0xcf, 0x11, 0xe0], advice: 'This is an old .xls workbook. Open it in Excel and use Save As → CSV, or → Excel Workbook (.xlsx) for the Excel file source.' },
  { magic: [0x25, 0x50, 0x44, 0x46], advice: 'This is a PDF. Clarion reads data files, not documents.' },
];

export class CsvConnector extends BaseSourceConnector implements SourceConnector {
  readonly type = 'csv';
  readonly displayName = 'CSV file';
  readonly configSchema = csvConfigSchema;

  /**
   * Empty on purpose, exactly as in the Excel connector: this connector
   * performs no network I/O. Under an empty list the shared HTTP client
   * refuses every request, so a call added here later fails loudly instead of
   * quietly reaching somewhere undeclared.
   */
  readonly egressAllowList: readonly string[] = [];

  // ─── testConnection ────────────────────────────────────────────────────
  async testConnection(rawConfig: ConnectorConfig, ctx: ProbeContext): Promise<TestResult> {
    this.validateConfig(rawConfig);
    const config = asCsvConfig(rawConfig);

    let read: CsvReadResult;
    try {
      read = this.open(config);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not read this file.' };
    }

    const table = sheetToTable(read.sheet, { headerRow: config.headerRow ?? true });
    ctx.log.info('file read', {
      delimiter: read.delimiter,
      encoding: read.encoding,
      columns: table.columns.length,
      rows: table.rows.length,
    });

    if (table.columns.length === 0) {
      return { ok: false, error: `${config.filename} has no columns Clarion could read.` };
    }
    // Everything here was INFERRED, so the details are the point of the test,
    // not decoration: this is where a user catches a wrong separator.
    return {
      ok: true,
      details: {
        file: config.filename,
        table: this.entityName(config),
        separator: delimiterLabel(read.delimiter),
        encoding: read.encoding,
        columns: String(table.columns.length),
        rows: String(table.rows.length),
        ...(read.sheet.truncated ? { warning: 'more rows than a file source can carry' } : {}),
      },
    };
  }

  // ─── listEntities ──────────────────────────────────────────────────────
  async listEntities(rawConfig: ConnectorConfig, _ctx: ProbeContext): Promise<EntityDescriptor[]> {
    this.validateConfig(rawConfig);
    const config = asCsvConfig(rawConfig);
    const read = this.open(config);
    const table = sheetToTable(read.sheet, { headerRow: config.headerRow ?? true });

    return [{
      name: this.entityName(config),
      displayName: config.tableName?.trim() || config.filename,
      category: 'Files',
      description: table.columns.length === 0
        ? `${config.filename} — no readable columns.`
        : `${config.filename} — ${table.rows.length} rows, ${table.columns.length} columns, `
          + `${delimiterLabel(read.delimiter)}-separated.`,
      estimatedRowCount: table.rows.length,
      // A file has no per-row modification stamp and no reliable business key,
      // so there is nothing to build a cursor on. Declaring one without a key
      // to merge on would make the writer overwrite the whole table with each
      // delta while the cursor advanced. Re-uploading is the refresh.
      supportsIncremental: false,
    }];
  }

  // ─── sync ──────────────────────────────────────────────────────────────
  async sync(rawConfig: ConnectorConfig, opts: SyncOptions, ctx: SyncContext): Promise<SyncResult> {
    this.validateConfig(rawConfig);
    const config = asCsvConfig(rawConfig);

    if (opts.entities.length === 0) {
      return { rowCounts: {}, warnings: ['Nothing selected — nothing to sync.'] };
    }

    const name = this.entityName(config);
    const warnings: string[] = [];
    const rowCounts: Record<string, number> = {};

    // A selection naming something else means the file was replaced by one
    // saved under a different name. Saying so is what lets the user fix it.
    for (const requested of opts.entities) {
      if (requested !== name) {
        warnings.push(`'${requested}' is not part of ${config.filename} any more — it is now called '${name}'.`);
        rowCounts[requested] = 0;
      }
    }
    if (!opts.entities.includes(name)) return { rowCounts, warnings };

    ctx.cancellationToken.throwIfCancelled();
    ctx.progress({ message: `Reading ${config.filename}…` });

    try {
      rowCounts[name] = await this.writeFile(config, name, ctx);
      if (rowCounts[name] === 0) warnings.push(`${config.filename} has no data rows.`);
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.warn('file failed', { error: msg });
      warnings.push(`${config.filename} failed: ${msg}`);
      rowCounts[name] = 0;
    }

    return { rowCounts, warnings };
  }

  /** Turn the file into one warehouse table. */
  private async writeFile(config: CsvConfig, name: string, ctx: SyncContext): Promise<number> {
    const read = this.open(config);

    // Throws before anything is written when the reader hit its ceiling. A
    // partial table looks complete, so this must be a refusal, not a warning.
    assertSheetComplete(read.sheet);

    const table = sheetToTable(read.sheet, { headerRow: config.headerRow ?? true });
    if (table.columns.length === 0) {
      // Written as an empty table rather than skipped, so the catalog shows
      // the source exists and the user can see we did look at it.
      await ctx.warehouseWriter.writeTable(name, emptyRows());
      return 0;
    }

    const columns = table.columns.map((c) => ({ name: c.name, sqlType: c.sqlType }));
    const rows = table.rows;
    async function* iterate(): AsyncIterable<Record<string, unknown>> {
      for (const r of rows) yield r;
    }

    const result = await ctx.warehouseWriter.writeTable(name, iterate(), { columns });
    ctx.log.info(`${name} written`, {
      rows: result.rowsWritten,
      columns: columns.length,
      bytes: result.bytesWritten,
      separator: read.delimiter,
      encoding: read.encoding,
    });
    return result.rowsWritten;
  }

  // ─── describeEntities ──────────────────────────────────────────────────
  /**
   * The file documents its own column NAMES and nothing else, so the heading
   * becomes the display name (`Bedrag (EUR)` for the column stored as
   * `Bedrag_EUR`) and no `description` is emitted — the AI pass still fills in
   * meaning. Passing a heading off as documentation would put a fabricated
   * description at the trusted rung, which is worse than an honest AI draft.
   */
  async describeEntities(
    rawConfig: ConnectorConfig,
    selectedEntities: readonly string[],
    _ctx: ProbeContext,
  ): Promise<EntityDocs[]> {
    this.validateConfig(rawConfig);
    const config = asCsvConfig(rawConfig);
    const name = this.entityName(config);
    if (!selectedEntities.includes(name)) return [];

    const read = this.open(config);
    const table = sheetToTable(read.sheet, { headerRow: config.headerRow ?? true });
    return [{
      entityName: name,
      displayName: config.tableName?.trim() || config.filename,
      description: `Uploaded file ${config.filename}.`,
      columns: table.columns.map((c) => ({
        name: c.name,
        // Only carried when sanitising actually changed something; a display
        // name identical to the column name is noise in the catalog.
        ...(c.sourceHeader && c.sourceHeader !== c.name ? { displayName: c.sourceHeader } : {}),
      })),
      provenance: 'declared',
    }];
  }

  // ─── internals ─────────────────────────────────────────────────────────

  /**
   * The table this source produces.
   *
   * Derived from the file name unless the user pinned one. The pin matters
   * because re-uploading `Sales v2.csv` over `Sales.csv` would otherwise
   * rename the table and orphan everything built on the old name — the same
   * trade-off the Excel connector resolves by naming tables after sheets.
   */
  private entityName(config: CsvConfig): string {
    const pinned = config.tableName?.trim();
    if (pinned) return sanitiseEntityName(pinned) ?? 'data';
    const stem = config.filename.replace(/\.[A-Za-z0-9]{1,8}$/, '');
    return sanitiseEntityName(stem) ?? 'data';
  }

  /**
   * Decode and read the configured file.
   *
   * Checks for the file types people most often upload here by mistake, so
   * "a workbook renamed to .csv" produces a sentence naming the right
   * connector rather than a parse failure.
   */
  private open(config: CsvConfig): CsvReadResult {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(config.fileContent, 'base64');
    } catch {
      throw new SpreadsheetReadError('The uploaded file could not be decoded. Upload it again.');
    }
    if (bytes.length === 0) throw new SpreadsheetReadError('The uploaded file is empty.');
    if (bytes.length > MAX_FILE_BYTES) {
      throw new SpreadsheetReadError(
        `${config.filename} is ${Math.round(bytes.length / 1024 / 1024)} MB, over the `
        + `${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit for a file source. `
        + 'Split the file, or load this data from a database instead.',
      );
    }
    for (const { magic, advice } of NOT_TEXT) {
      if (magic.every((b, i) => bytes[i] === b)) {
        throw new SpreadsheetReadError(`${config.filename} is not a text file. ${advice}`);
      }
    }

    // Copy into a standalone ArrayBuffer: a Buffer is a view onto a shared
    // pool, and handing the reader the whole pool would corrupt every offset.
    const ab = new ArrayBuffer(bytes.length);
    new Uint8Array(ab).set(bytes);

    const choice = config.delimiter;
    return readCsv(ab, {
      name: this.entityName(config),
      headerRow: config.headerRow ?? true,
      ...(choice && choice !== 'auto' ? { delimiter: DELIMITER_CHARS[choice] } : {}),
      ...(config.encoding && config.encoding !== 'auto'
        ? { encoding: config.encoding as CsvEncoding }
        : {}),
    });
  }
}

async function* emptyRows(): AsyncIterable<Record<string, unknown>> {
  // Intentionally yields nothing — the writer materialises an empty table.
}
