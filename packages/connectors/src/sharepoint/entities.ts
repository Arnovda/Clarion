/**
 * Entity naming for spreadsheet sources.
 *
 * A SharePoint library has no fixed entity catalog the way Exact Online does —
 * the entities ARE whatever workbooks the customer keeps there, so they are
 * derived at discovery time rather than curated in this file. What IS fixed,
 * and what lives here, is the RULE that turns a file plus a worksheet into a
 * stable warehouse table name.
 *
 * **Every entity name carries both the file and the sheet, even when the
 * workbook has only one sheet.** Shortening single-sheet workbooks to just the
 * file name reads better and is a trap: the day someone adds a second tab, the
 * existing entity would have to be renamed, the connection's saved selection
 * would no longer match, and the already-synced table would be orphaned in the
 * warehouse next to a new one. A slightly uglier name that never moves is
 * worth more than a pretty one that does.
 */

import type { EntityDescriptor } from '../types';
import { sanitiseEntityName } from '../spreadsheet/tabular';
import type { XlsxWorkbook } from '../spreadsheet/xlsxReader';
import { sheetToTable } from '../spreadsheet/tabular';
import type { DriveFile } from './graph';

export interface SharePointEntity extends EntityDescriptor {
  /** Graph drive-item id of the workbook this sheet lives in. */
  fileId: string;
  /** Path below the library root, for display. */
  filePath: string;
  /** Worksheet name exactly as Excel holds it. */
  sheetName: string;
}

const MAX_NAME = 128;

/** Strip the extension from a workbook file name. */
export function fileBaseName(fileName: string): string {
  return fileName.replace(/\.(xlsx|xlsm)$/i, '');
}

/**
 * Build the warehouse table name for one worksheet.
 *
 * Both halves are sanitised separately and then joined with a double
 * underscore, so the separator survives (sanitising the joined string would
 * collapse it) and the boundary between file and sheet stays readable.
 */
export function entityNameFor(fileName: string, sheetName: string): string {
  const file = sanitiseEntityName(fileBaseName(fileName)) ?? 'workbook';
  const sheet = sanitiseEntityName(sheetName) ?? 'sheet';
  return `${file}__${sheet}`.slice(0, MAX_NAME);
}

/**
 * Describe every worksheet of one workbook as an entity.
 *
 * The description is measured, not guessed — it reports the shape the sync
 * would actually produce, which is what makes the wizard's picker useful
 * ("34 rows, 6 columns" tells you whether you grabbed the right tab).
 * Worksheets that hold nothing are still listed, marked as empty, because a
 * silently missing tab looks like the connector failed to see the file.
 */
export function entitiesForWorkbook(
  file: DriveFile,
  workbook: XlsxWorkbook,
  headerRow: boolean,
): SharePointEntity[] {
  const out: SharePointEntity[] = [];
  const used = new Set<string>();
  for (const sheet of workbook.sheets) {
    let name = entityNameFor(file.name, sheet.name);
    // Two sheets whose names sanitise alike would otherwise become one table
    // and the second would silently overwrite the first.
    let n = 2;
    while (used.has(name.toLowerCase())) {
      name = `${entityNameFor(file.name, sheet.name)}_${n}`.slice(0, MAX_NAME);
      n += 1;
    }
    used.add(name.toLowerCase());

    const table = sheetToTable(sheet, { headerRow });
    const description = table.columns.length === 0
      ? `Empty worksheet '${sheet.name}' in ${file.path}.`
      : `Worksheet '${sheet.name}' in ${file.path} — ${table.rows.length} rows, ${table.columns.length} columns.`;

    out.push({
      name,
      displayName: `${fileBaseName(file.name)} · ${sheet.name}`,
      category: file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : 'Documents',
      description,
      estimatedRowCount: table.rows.length,
      // A spreadsheet has no per-row modification stamp, so there is nothing
      // to build a cursor on. Declaring one without a business key to merge on
      // is the single most destructive mistake in this framework — the writer
      // would overwrite the table with each delta while the cursor advanced.
      supportsIncremental: false,
      fileId: file.id,
      filePath: file.path,
      sheetName: sheet.name,
    });
  }
  return out;
}
