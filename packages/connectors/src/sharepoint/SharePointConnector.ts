/**
 * SharePoint / OneDrive source connector.
 *
 * Implements `SourceConnector` for spreadsheets kept in a Microsoft 365
 * document library:
 *   • testConnection — sign in, resolve the site + library, count workbooks
 *   • listEntities  — one entity per WORKSHEET of every workbook found
 *   • sync          — download each workbook once, turn each selected sheet
 *                     into a warehouse table
 *   • describeEntities — hand the catalog the column headings the user wrote
 *
 * Structured to match `ExactOnlineConnector` deliberately: each public method
 * validates its config, builds its own `HttpClient` (no shared mutable state
 * between calls, so a previous tenant's bearer token can never leak into a new
 * request), and the per-entity loop isolates failures as warnings.
 *
 * TWO THINGS THIS CONNECTOR DOES DIFFERENTLY FROM THE API CONNECTORS, both
 * forced by what a document library is rather than by preference:
 *
 * 1. **The entity catalog is discovered, not curated.** Exact Online has 61
 *    entities that are the same for every customer. A library holds whatever
 *    the customer put there, so `listEntities` opens the workbooks and reads
 *    their tabs. That costs a download per file, which is why every traversal
 *    is capped in `graph.ts`.
 *
 * 2. **Nothing is incremental.** A worksheet has no per-row modification stamp
 *    and no reliable business key — a budget sheet's "row 14" is not an
 *    identity. So every sync replaces the whole table, which is both correct
 *    and what a user expects of a file: what the file says now is what the
 *    table holds now.
 *
 * `probeEntities` is deliberately NOT implemented. It exists so a wizard can
 * grey out entities the credential cannot reach — a real distinction for an
 * ERP where modules are licensed separately. Here, a file we could list is a
 * file we can read, so a probe would issue a download per entity to learn
 * nothing.
 */

import { BaseSourceConnector } from '../BaseSourceConnector';
import { HttpClient } from '../HttpClient';
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
import { sheetToTable } from '../spreadsheet/tabular';
import { asSharePointConfig, sharePointConfigSchema, type SharePointConfig } from './schema';
import { AuthRefreshError, getOrRefreshAccessToken, refreshAccessToken, sharePointOAuth } from './oauth';
import {
  downloadItem,
  GraphError,
  listWorkbooks,
  resolveDriveId,
  resolveSiteId,
  type DriveFile,
} from './graph';
import { entitiesForWorkbook, fileBaseName, type SharePointEntity } from './entities';
import { sanitiseEntityName } from '../spreadsheet/tabular';

export class SharePointConnector extends BaseSourceConnector implements SourceConnector {
  readonly type = 'sharepoint';
  readonly displayName = 'SharePoint';
  readonly configSchema = sharePointConfigSchema;
  readonly oauth = sharePointOAuth;

  /**
   * Every host this connector reaches, including the ones it reaches
   * INDIRECTLY. `/content` answers with a redirect to the tenant's own
   * SharePoint host or to Microsoft's file-delivery CDN, and a redirect is
   * still egress — a list naming only graph.microsoft.com would be a list
   * that lies to whoever provisions the network policy from it.
   */
  readonly egressAllowList: readonly string[] = [
    'login.microsoftonline.com',
    'graph.microsoft.com',
    '*.sharepoint.com',
    '*.sharepointonline.com',
    '*.svc.ms',
  ];

  // ─── testConnection ────────────────────────────────────────────────────
  async testConnection(rawConfig: ConnectorConfig, ctx: ProbeContext): Promise<TestResult> {
    this.validateConfig(rawConfig);
    const config = asSharePointConfig(rawConfig);

    let http: HttpClient;
    try {
      http = await this.client(config, ctx.log, ctx.onCredentialRotated);
    } catch (e) {
      if (e instanceof AuthRefreshError) return { ok: false, error: e.message };
      throw e;
    }

    try {
      const site = await resolveSiteId(http, config.siteUrl);
      const drive = await resolveDriveId(http, site.id, config.libraryName);
      const { files, truncated } = await listWorkbooks(http, drive.id, config.folderPath);
      return {
        ok: true,
        details: {
          ...(site.displayName ? { site: site.displayName } : {}),
          library: drive.name,
          ...(config.folderPath ? { folder: config.folderPath } : {}),
          spreadsheets: truncated ? `${files.length}+` : String(files.length),
        },
      };
    } catch (e) {
      // A Graph error here is almost always a wrong site URL or a missing
      // permission, and its message already says which. Anything else is
      // reported without detail rather than leaking an internal shape.
      if (e instanceof GraphError) return { ok: false, error: e.message };
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return { ok: false, error: `Signed in, but reading the library failed: ${msg}` };
    }
  }

  // ─── listEntities ──────────────────────────────────────────────────────
  async listEntities(rawConfig: ConnectorConfig, ctx: ProbeContext): Promise<EntityDescriptor[]> {
    this.validateConfig(rawConfig);
    const config = asSharePointConfig(rawConfig);
    const http = await this.client(config, ctx.log, ctx.onCredentialRotated);

    const { driveId, files } = await this.discover(http, config);
    const headerRow = config.headerRow ?? true;

    const entities: SharePointEntity[] = [];
    for (const file of files) {
      try {
        const workbook = await this.openWorkbook(http, driveId, file);
        entities.push(...entitiesForWorkbook(file, workbook, headerRow));
      } catch (e) {
        // One unreadable workbook (password-protected, corrupt, or an .xlsx
        // that is really something else) must not empty the picker. Skip it
        // and say so — the user can then see which file to look at.
        const msg = e instanceof Error ? e.message : String(e);
        ctx.log.warn(`skipping '${file.path}' — ${msg}`);
      }
    }
    return entities;
  }

  // ─── sync ──────────────────────────────────────────────────────────────
  async sync(rawConfig: ConnectorConfig, opts: SyncOptions, ctx: SyncContext): Promise<SyncResult> {
    this.validateConfig(rawConfig);
    const config = asSharePointConfig(rawConfig);

    if (opts.entities.length === 0) {
      return { rowCounts: {}, warnings: ['No worksheets selected — nothing to sync.'] };
    }

    const http = await this.client(config, ctx.log, ctx.onCredentialRotated);
    const headerRow = config.headerRow ?? true;
    const warnings: string[] = [];
    const rowCounts: Record<string, number> = {};

    const { driveId, files } = await this.discover(http, config);
    ctx.log.info('SharePoint sync starting', { files: files.length, requested: opts.entities.length });

    // One pass over the library, opening each workbook AT MOST ONCE and
    // writing every selected sheet inside it before moving on. A three-tab
    // workbook therefore costs one download, not three — which is the whole
    // reason discovery happens up front instead of per entity.
    const wanted = new Set(opts.entities);
    const seen = new Set<string>();

    for (const file of files) {
      ctx.cancellationToken.throwIfCancelled();
      // Skip the download entirely when nothing in this file was selected.
      // Names are derived from the file name, so this is decidable without
      // opening it.
      if (!fileMayHoldSelection(file, wanted)) continue;

      let workbook: XlsxWorkbook;
      try {
        workbook = await this.openWorkbook(http, driveId, file);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.log.warn(`could not open '${file.path}'`, { error: msg });
        warnings.push(`Could not open '${file.path}': ${msg}`);
        continue;
      }
      const candidates = entitiesForWorkbook(file, workbook, headerRow).filter((e) => wanted.has(e.name));
      if (candidates.length === 0) continue;
      for (const c of candidates) seen.add(c.name);

      for (const entity of candidates) {
        ctx.cancellationToken.throwIfCancelled();
        ctx.progress({ message: `Reading ${entity.displayName ?? entity.name}…` });
        try {
          const written = await this.syncOneSheet(entity, workbook, headerRow, ctx);
          rowCounts[entity.name] = written;
          if (written === 0) warnings.push(`Worksheet '${entity.displayName ?? entity.name}' is empty.`);
        } catch (err) {
          if (err instanceof CancellationError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log.warn(`worksheet '${entity.name}' failed — continuing`, { error: msg });
          warnings.push(`Worksheet '${entity.displayName ?? entity.name}' failed: ${msg}`);
          rowCounts[entity.name] = 0;
        }
      }
    }

    // A selection that no longer resolves means the file was renamed, moved or
    // deleted since the wizard ran. Saying so by name is the difference
    // between a user fixing it in a minute and a table that quietly stops
    // updating.
    for (const name of opts.entities) {
      if (!seen.has(name)) {
        warnings.push(
          `'${name}' was not found in the library any more — the file may have been renamed, moved or deleted.`,
        );
        rowCounts[name] = 0;
      }
    }

    return { rowCounts, warnings };
  }

  /** Turn one worksheet into one warehouse table. */
  private async syncOneSheet(
    entity: SharePointEntity,
    workbook: XlsxWorkbook,
    headerRow: boolean,
    ctx: SyncContext,
  ): Promise<number> {
    const sheet = workbook.sheets.find((s) => s.name === entity.sheetName);
    if (!sheet) throw new Error(`worksheet '${entity.sheetName}' is no longer in the workbook`);

    // The reader reports rather than obeys its row cap; a partial sheet must
    // never reach the warehouse, because the resulting table looks complete
    // and answers questions with wrong numbers.
    if (sheet.truncated) {
      throw new Error(
        `the worksheet has more rows than a spreadsheet source can carry. `
        + `Nothing was written, so no partial data is in your warehouse. `
        + `Split the sheet, or load this data from a database instead.`,
      );
    }

    const table = sheetToTable(sheet, { headerRow });
    if (table.columns.length === 0) {
      // An empty tab is written as an empty, schema-less table rather than
      // skipped, so the catalog shows it exists.
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
   * The workbook documents its own columns — the heading the user typed. That
   * heading is the DISPLAY NAME, and nothing more: `Bedrag (EUR)` tells the
   * catalog what to call `Bedrag_EUR`, and says nothing about what the column
   * means. So no `description` is emitted and the AI pass still runs for
   * meaning. Claiming a heading as documentation would put a fabricated
   * description at the trusted rung, which is worse than an honest AI draft.
   */
  async describeEntities(
    rawConfig: ConnectorConfig,
    selectedEntities: readonly string[],
    ctx: ProbeContext,
  ): Promise<EntityDocs[]> {
    this.validateConfig(rawConfig);
    const config = asSharePointConfig(rawConfig);
    const http = await this.client(config, ctx.log, ctx.onCredentialRotated);
    const headerRow = config.headerRow ?? true;
    const wanted = new Set(selectedEntities);

    const { driveId, files } = await this.discover(http, config);
    const out: EntityDocs[] = [];

    for (const file of files) {
      if (!fileMayHoldSelection(file, wanted)) continue;
      let workbook: XlsxWorkbook;
      try {
        workbook = await this.openWorkbook(http, driveId, file);
      } catch {
        continue; // Already reported during sync; docs are best-effort.
      }
      for (const entity of entitiesForWorkbook(file, workbook, headerRow)) {
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
            // Only worth carrying when sanitising actually changed something;
            // a displayName identical to the name is noise in the catalog.
            ...(c.sourceHeader && c.sourceHeader !== c.name ? { displayName: c.sourceHeader } : {}),
          })),
          provenance: 'declared',
        });
      }
    }
    return out;
  }

  // ─── internals ─────────────────────────────────────────────────────────

  /**
   * Build an authenticated Graph client.
   *
   * `onUnauthorised` re-refreshes mid-run: discovery plus a handful of large
   * downloads can outlive Microsoft's one-hour access token, and without this
   * the sync would fail on the last file of a long library.
   */
  private async client(
    config: SharePointConfig,
    log: ProbeContext['log'],
    onCredentialRotated?: (c: ConnectorConfig) => Promise<void>,
  ): Promise<HttpClient> {
    const accessToken = await getOrRefreshAccessToken(config, log, onCredentialRotated);
    let refreshToken = config.refreshToken;

    return new HttpClient({
      authHeader: `Bearer ${accessToken}`,
      log,
      egressAllowList: this.egressAllowList,
      maxRetries: 6,
      onUnauthorised: async () => {
        if (!refreshToken) return null;
        const r = await refreshAccessToken({
          directory: config.directory,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken,
          log,
        });
        refreshToken = r.newRefreshToken;
        if (onCredentialRotated) {
          await onCredentialRotated({
            ...config,
            refreshToken: r.newRefreshToken,
            accessToken: r.accessToken,
            accessTokenExpiresAt: Date.now() + r.expiresIn * 1000,
          } as unknown as ConnectorConfig);
        }
        return `Bearer ${r.accessToken}`;
      },
    });
  }

  /** Resolve site → library → workbook list. Shared by every public method. */
  private async discover(
    http: HttpClient,
    config: SharePointConfig,
  ): Promise<{ driveId: string; files: DriveFile[] }> {
    const site = await resolveSiteId(http, config.siteUrl);
    const drive = await resolveDriveId(http, site.id, config.libraryName);
    const { files } = await listWorkbooks(http, drive.id, config.folderPath);
    return { driveId: drive.id, files };
  }

  /**
   * Download and parse one workbook, translating reader errors for the user.
   *
   * Takes an already-resolved `driveId` rather than the config on purpose: the
   * site and library lookups are two Graph round trips, and re-doing them per
   * file would put 200 needless calls in front of a 100-file library.
   */
  private async openWorkbook(
    http: HttpClient,
    driveId: string,
    file: DriveFile,
  ): Promise<XlsxWorkbook> {
    const bytes = await downloadItem(http, driveId, file);
    try {
      return await readXlsx(bytes);
    } catch (e) {
      if (e instanceof SpreadsheetReadError) {
        throw new SpreadsheetReadError(`${file.path}: ${e.message}`);
      }
      throw e;
    }
  }
}

async function* emptyRows(): AsyncIterable<Record<string, unknown>> {
  // Intentionally yields nothing — the writer materialises an empty table.
}

/**
 * Could any selected entity live in this file? Entity names begin with the
 * sanitised file name, so this is answerable WITHOUT downloading the workbook
 * — which is what keeps a sync of two sheets out of a hundred-file library
 * from downloading a hundred files.
 *
 * Deliberately a prefix test rather than an exact one: the sheet half of the
 * name is unknown until the file is open. A false positive costs one needless
 * download; a false negative would silently skip a table the user selected,
 * so the test errs toward opening.
 */
function fileMayHoldSelection(file: DriveFile, wanted: ReadonlySet<string>): boolean {
  const prefix = `${sanitiseEntityName(fileBaseName(file.name)) ?? 'workbook'}__`;
  for (const name of wanted) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}
