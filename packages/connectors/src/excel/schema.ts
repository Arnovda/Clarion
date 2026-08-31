/**
 * JSON Schema for the Excel-file connector config.
 *
 * Unlike every other connector, the "credential" here is the data itself:
 * there is no remote system to authenticate against, so the config carries
 * the workbook. That has three consequences worth stating plainly, because
 * they look surprising next to the API connectors.
 *
 * **The bytes live in the config, deliberately.** The alternative — a separate
 * file store, with the sync path resolving a handle to a readable URL — is
 * the textbook shape, and it was rejected here for a specific reason: the
 * platform decrypts a connector config in five different places (sync launch,
 * profiling, three connection routes), and a hydration step would have to be
 * added to each. Missing one produces a connector that fails deep inside a
 * sync with a confusing error. Carrying the bytes as an ordinary config field
 * means every one of those five paths already works, unchanged. The cost is a
 * larger encrypted row, which Postgres handles by compressing it out of line.
 *
 * **It is capped at roughly 15 MB.** Not an arbitrary number: the reader
 * materialises a sheet before the connector streams it, and the sync worker
 * runs with 1 GiB. A spreadsheet past this size is a database pretending to
 * be a file, and the refusal says so rather than failing on memory later.
 *
 * **Re-uploading is how you refresh.** A file has no API to re-read, so a
 * sync re-materialises whatever the config holds. Uploading a new version of
 * the workbook and syncing again is the update path, and it is idempotent.
 */

import type { JSONSchema7 } from 'json-schema';

/**
 * ~15 MB of file, expressed as its base64 length. Base64 costs 4 characters
 * per 3 bytes, so the ceiling is stated in the units the validator actually
 * measures rather than in bytes the user would have to convert.
 */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_BASE64_LENGTH = Math.ceil(MAX_FILE_BYTES / 3) * 4;

export const excelConfigSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://clarion.local/schemas/connectors/excel.json',
  type: 'object',
  required: ['filename', 'fileContent'],
  additionalProperties: false,
  properties: {
    filename: {
      type: 'string',
      title: 'File name',
      description: 'The workbook you uploaded. Shown in the catalog so you can tell sources apart.',
      minLength: 1,
      maxLength: 255,
    },
    fileContent: {
      type: 'string',
      title: 'Excel file',
      description: 'Upload an .xlsx or .xlsm workbook. Encrypted at rest, like every other source credential.',
      // Draft-07's standard way to say "this string is a base64-encoded file".
      // The wizard renders any property carrying these two keywords as a file
      // picker, so the connector needs no bespoke frontend code.
      contentEncoding: 'base64',
      contentMediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      minLength: 1,
      maxLength: MAX_BASE64_LENGTH,
    } as JSONSchema7,
    headerRow: {
      type: 'boolean',
      title: 'First row contains column names',
      description:
        'Almost always true. Turn it off for sheets that start straight into data — '
        + 'columns are then named by position.',
      default: true,
    },
  },
};

/** Strongly-typed config shape that mirrors the schema above. */
export interface ExcelConfig {
  filename: string;
  /** The workbook, base64-encoded. */
  fileContent: string;
  headerRow?: boolean;
}

/** Narrowing helper — assumes the config has already been validated. */
export function asExcelConfig(raw: Record<string, unknown>): ExcelConfig {
  return raw as unknown as ExcelConfig;
}
