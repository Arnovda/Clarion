/**
 * Excel-file source connector.
 *
 * The simplest connector in the framework, and the one a business user is
 * most likely to reach for: upload a workbook, pick the tabs you want, and
 * each becomes a table Ask AI and dashboards can query like any other.
 *
 * Implements `SourceConnector` against bytes rather than an API:
 *   • testConnection — parse the workbook and report what is in it
 *   • listEntities  — one entity per worksheet
 *   • sync          — turn each selected worksheet into a warehouse table
 *   • describeEntities — hand the catalog the column headings the user wrote
 *
 * The worksheet-to-table rules are NOT implemented here. They live in
 * `../spreadsheet/tabular`, shared with the SharePoint connector, so the same
 * workbook lands identically whether it was uploaded or read out of a
 * document library. A user who moves their budget file into SharePoint should
 * not get differently-shaped tables for it.
 *
 * NAMING DIFFERS FROM THE SHAREPOINT CONNECTOR, AND THE DIFFERENCE IS THE
 * RULE BEING APPLIED CONSISTENTLY RATHER THAN AN INCONSISTENCY. The rule is:
 * an entity is named by what identifies the sheet WITHIN ITS SOURCE. A
 * SharePoint library holds many workbooks, so there the name needs the file
 * too. Here the source IS one file, so the sheet name alone identifies it —
 * and that is also the more robust choice, because uploading a corrected
 * `Budget 2026 v2.xlsx` over `Budget 2026.xlsx` then keeps the existing
 * tables instead of orphaning them behind a set of renamed ones.
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
import { readXlsx, SpreadsheetReadError, type XlsxWorkbook } from '../spreadsheet/xlsxReader';
import { assertSheetComplete, sanitiseEntityName, sheetToTable } from '../spreadsheet/tabular';
import { asExcelConfig, excelConfigSchema, MAX_FILE_BYTES, type ExcelConfig } from './schema';

/** Every .xlsx / .xlsm is a zip, and every zip starts with these four bytes. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export class ExcelConnector extends BaseSourceConnector implements SourceConnector {
  readonly type = 'excel';
  readonly displayName = 'Excel file';
  readonly configSchema = excelConfigSchema;

  /**
   * Empty on purpose, and it is a declaration rather than an omission: this
   * connector performs no network I/O whatsoever. The file is already inside
   * Clarion by the time any of these methods run. Under an empty list the
   * shared HTTP client refuses every request, so if this connector ever grows
   * a call it will fail loudly on the first one instead of quietly reaching
   * somewhere undeclared.
   */
  readonly egressAllowList: readonly string[] = [];

  // ─── testConnection ────────────────────────────────────────────────────
  /**
   * "Test connection" for a file means "can we actually read this?". Answering
   * it here, in the wizard, is the whole point: the alternative is a user
   * discovering at sync time that they uploaded a .xlsb, a CSV renamed to
   * .xlsx, or a password-protected workbook.
   */
  async testConnection(rawConfig: ConnectorConfig, ctx: ProbeContext): Promise<TestResult> {
    this.validateConfig(rawConfig);
    const config = asExcelConfig(rawConfig);

    let workbook: XlsxWorkbook;
    try {
      workbook = await this.open(config);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not read this file.' };
    }

    const readable = workbook.sheets.filter((s) => s.rows.length > 0).length;
    ctx.log.info('workbook opened', { sheets: workbook.sheets.length, withData: readable });
    return {
      ok: true,
      details: {
        file: config.filename,
        worksheets: String(workbook.sheets.length),
        ...(readable !== workbook.sheets.length ? { withData: String(readable) } : {}),
      },
    };
  }

  // ─── listEntities ──────────────────────────────────────────────────────
  async listEntities(rawConfig: ConnectorConfig, _ctx: ProbeContext): Promise<EntityDescriptor[]> {
    this.validateConfig(rawConfig);
    const config = asExcelConfig(rawConfig);
    const workbook = await this.open(config);
    return this.describeSheets(workbook, config.headerRow ?? true);
  }

  // ─── sync ──────────────────────────────────────────────────────────────
  async sync(rawConfig: ConnectorConfig, opts: SyncOptions, ctx: SyncContext): Promise<SyncResult> {
    this.validateConfig(rawConfig);
    const config = asExcelConfig(rawConfig);

    if (opts.entities.length === 0) {
      return { rowCounts: {}, warnings: ['No worksheets selected — nothing to sync.'] };
    }

    const headerRow = config.headerRow ?? true;
    const workbook = await this.open(config);
    const entities = this.describeSheets(workbook, headerRow);
    const byName = new Map(entities.map((e) => [e.name, e]));

    const warnings: string[] = [];
    const rowCounts: Record<string, number> = {};

    for (const name of opts.entities) {
      ctx.cancellationToken.throwIfCancelled();
      const entity = byName.get(name);
      if (!entity) {
        // The workbook was re-uploaded without this tab. Naming it is what
        // lets the user fix it; a silent zero-row table would not.
        warnings.push(`'${name}' is not a worksheet in ${config.filename} any more — it may have been renamed or removed.`);
        rowCounts[name] = 0;
        continue;
      }

      ctx.progress({ message: `Reading ${entity.sheetName}…` });
      try {
        rowCounts[name] = await this.syncOneSheet(entity, workbook, headerRow, ctx);
        if (rowCounts[name] === 0) warnings.push(`Worksheet '${entity.sheetName}' is empty.`);
      } catch (err) {
        if (err instanceof CancellationError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log.warn(`worksheet '${name}' failed — continuing`, { error: msg });
        warnings.push(`Worksheet '${entity.sheetName}' failed: ${msg}`);
        rowCounts[name] = 0;
      }
    }

    return { rowCounts, warnings };
  }

  /** Turn one worksheet into one warehouse table. */
  private async syncOneSheet(
    entity: ExcelEntity,
    workbook: XlsxWorkbook,
    headerRow: boolean,
    ctx: SyncContext,
  ): Promise<number> {
    const sheet = workbook.sheets.find((s) => s.name === entity.sheetName);
    if (!sheet) throw new Error(`worksheet '${entity.sheetName}' is no longer in the workbook`);

    // Throws before anything is written when the reader hit its row ceiling.
    assertSheetComplete(sheet);

    const table = sheetToTable(sheet, { headerRow });
    if (table.columns.length === 0) {
      // Written as an empty table rather than skipped, so the catalog shows
      // the tab exists and the user can see we did look at it.
      await ctx.warehouseWriter.writeTable(entity.name, emptyRows());
      return 0;
    }

    const columns = table.columns.map((c) => ({ name: c.name, sqlType: c.sqlType }));
    const rows = table.rows;
    async function* iterate(): AsyncIterable<Record<string, unknown>> {
      for (const r of rows) yield r;
    }

    const result = await ctx.warehouseWriter.writeTable(entity.name, iterate(), { columns });
    ctx.log.info(`${entity.name} written`, {
      rows: result.rowsWritten,
      columns: columns.length,
      bytes: result.bytesWritten,
    });
    return result.rowsWritten;
  }

  // ─── describeEntities ──────────────────────────────────────────────────
  /**
   * The workbook documents its own column NAMES — the heading the user typed —
   * and nothing else. So the heading becomes the display name (`Bedrag (EUR)`
   * for the column stored as `Bedrag_EUR`) and no `description` is emitted:
   * the AI pass still fills in meaning. Passing a heading off as documentation
   * would put a fabricated description at the trusted rung, which is worse
   * than an honest AI draft.
   */
  async describeEntities(
    rawConfig: ConnectorConfig,
    selectedEntities: readonly string[],
    _ctx: ProbeContext,
  ): Promise<EntityDocs[]> {
    this.validateConfig(rawConfig);
    const config = asExcelConfig(rawConfig);
    const headerRow = config.headerRow ?? true;
    const workbook = await this.open(config);
    const wanted = new Set(selectedEntities);

    const out: EntityDocs[] = [];
    for (const entity of this.describeSheets(workbook, headerRow)) {
      if (!wanted.has(entity.name)) continue;
      const sheet = workbook.sheets.find((s) => s.name === entity.sheetName);
      if (!sheet) continue;
      const table = sheetToTable(sheet, { headerRow });
      out.push({
        entityName: entity.name,
        displayName: entity.displayName,
        description: entity.description,
        columns: table.columns.map((c) => ({
          name: c.name,
          // Only carried when sanitising actually changed something; a display
          // name identical to the column name is noise in the catalog.
          ...(c.sourceHeader && c.sourceHeader !== c.name ? { displayName: c.sourceHeader } : {}),
        })),
        provenance: 'declared',
      });
    }
    return out;
  }

  // ─── internals ─────────────────────────────────────────────────────────

  /**
   * Decode and parse the configured workbook.
   *
   * Checks the zip signature before handing the bytes to the reader so the
   * common mistakes — a CSV or an old .xls renamed to .xlsx — produce a
   * sentence the user can act on instead of a parser error.
   */
  private async open(config: ExcelConfig): Promise<XlsxWorkbook> {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(config.fileContent, 'base64');
    } catch {
      throw new SpreadsheetReadError('The uploaded file could not be decoded. Upload it again.');
    }
    if (bytes.length === 0) {
      throw new SpreadsheetReadError('The uploaded file is empty.');
    }
    if (bytes.length > MAX_FILE_BYTES) {
      throw new SpreadsheetReadError(
        `${config.filename} is ${Math.round(bytes.length / 1024 / 1024)} MB, over the `
        + `${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit for a spreadsheet source. `
        + 'Split the file, or load this data from a database instead.',
      );
    }
    if (!ZIP_MAGIC.every((b, i) => bytes[i] === b)) {
      throw new SpreadsheetReadError(
        `${config.filename} is not an .xlsx workbook. Older .xls files and .csv files renamed to .xlsx `
        + 'cannot be read — open it in Excel and use Save As → Excel Workbook (.xlsx).',
      );
    }
    // Copy into a standalone ArrayBuffer: a Buffer is a view onto a shared
    // pool, and handing the reader the whole pool would corrupt every offset.
    const ab = new ArrayBuffer(bytes.length);
    new Uint8Array(ab).set(bytes);
    return readXlsx(ab);
  }

  /** One entity per worksheet, named by sheet and described by measured shape. */
  private describeSheets(workbook: XlsxWorkbook, headerRow: boolean): ExcelEntity[] {
    const out: ExcelEntity[] = [];
    const used = new Set<string>();
    workbook.sheets.forEach((sheet, i) => {
      let name = sanitiseEntityName(sheet.name) ?? `sheet_${i + 1}`;
      // Two tabs whose names sanitise alike would otherwise become one table,
      // and the second would silently overwrite the first.
      let n = 2;
      const base = name;
      while (used.has(name.toLowerCase())) {
        name = `${base}_${n}`;
        n += 1;
      }
      used.add(name.toLowerCase());

      const table = sheetToTable(sheet, { headerRow });
      out.push({
        name,
        displayName: sheet.name,
        category: 'Worksheets',
        description: table.columns.length === 0
          ? `Empty worksheet '${sheet.name}'.`
          : `Worksheet '${sheet.name}' — ${table.rows.length} rows, ${table.columns.length} columns.`,
        estimatedRowCount: table.rows.length,
        // A worksheet has no per-row modification stamp and no reliable
        // business key, so there is nothing to build a cursor on. Declaring
        // one without a key to merge on would make the writer overwrite the
        // whole table with each delta while the cursor advanced.
        supportsIncremental: false,
        sheetName: sheet.name,
      });
    });
    return out;
  }
}

/** An entity plus the worksheet it came from. */
export interface ExcelEntity extends EntityDescriptor {
  sheetName: string;
}

async function* emptyRows(): AsyncIterable<Record<string, unknown>> {
  // Intentionally yields nothing — the writer materialises an empty table.
}
