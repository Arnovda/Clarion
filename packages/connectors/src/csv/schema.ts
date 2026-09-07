/**
 * JSON Schema for the CSV / delimited-text connector config.
 *
 * Shares the Excel connector's shape and its reasoning: the "credential" is
 * the data itself, so the file rides in the config as base64 rather than in a
 * separate store. See `../excel/schema.ts` for why — the platform decrypts a
 * connector config in five places, and a file store would need a hydration
 * step added to each.
 *
 * What differs is the three optional fields below, and they exist because a
 * CSV file, unlike a workbook, does not say what it is. A worksheet cell
 * carries its type, its encoding and its column boundary; a CSV carries none
 * of the three. Clarion detects all three and reports what it found, and
 * these fields are the override for the file where detection is wrong.
 */

import type { JSONSchema7 } from 'json-schema';

/** Same ~15 MB ceiling as the Excel upload, stated as base64 length. */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_BASE64_LENGTH = Math.ceil(MAX_FILE_BYTES / 3) * 4;

/** Wizard-visible separator names, mapped to characters by the connector. */
export const DELIMITER_CHOICES = ['auto', 'comma', 'semicolon', 'tab', 'pipe'] as const;
export type DelimiterChoice = (typeof DELIMITER_CHOICES)[number];

export const ENCODING_CHOICES = ['auto', 'utf-8', 'windows-1252'] as const;
export type EncodingChoice = (typeof ENCODING_CHOICES)[number];

export const csvConfigSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://clarion.local/schemas/connectors/csv.json',
  type: 'object',
  required: ['filename', 'fileContent'],
  additionalProperties: false,
  properties: {
    filename: {
      type: 'string',
      title: 'File name',
      description: 'The file you uploaded. Shown in the catalog so you can tell sources apart.',
      minLength: 1,
      maxLength: 255,
    },
    fileContent: {
      type: 'string',
      title: 'CSV file',
      description:
        'Upload a .csv or .txt file. Encrypted at rest, like every other source credential. '
        + 'To refresh the data later, upload a new version of the file and sync again.',
      contentEncoding: 'base64',
      contentMediaType: 'text/csv',
      minLength: 1,
      maxLength: MAX_BASE64_LENGTH,
    } as JSONSchema7,
    tableName: {
      type: 'string',
      title: 'Table name',
      description:
        'What this data is called in the catalog and in answers. Defaults to the file name. '
        + 'Worth setting if you expect to upload later versions under a different file name — '
        + 'the table is named once and keeps that name.',
      maxLength: 128,
    },
    headerRow: {
      type: 'boolean',
      title: 'First row contains column names',
      description:
        'Almost always true. Turn it off for files that start straight into data — '
        + 'columns are then named by position.',
      default: true,
    },
    delimiter: {
      type: 'string',
      title: 'Column separator',
      description:
        'Leave on auto unless the preview looks wrong. Excel writes semicolons in Belgian, '
        + 'French and Dutch locales, because the comma is the decimal separator there.',
      enum: [...DELIMITER_CHOICES],
      default: 'auto',
    },
    encoding: {
      type: 'string',
      title: 'Text encoding',
      description:
        'Leave on auto unless accented characters look wrong. Excel\'s plain "CSV (comma '
        + 'delimited)" export writes Windows-1252; "CSV UTF-8" writes UTF-8.',
      enum: [...ENCODING_CHOICES],
      default: 'auto',
    },
  },
};

export interface CsvConfig {
  filename: string;
  /** The file, base64-encoded. */
  fileContent: string;
  tableName?: string;
  headerRow?: boolean;
  delimiter?: DelimiterChoice;
  encoding?: EncodingChoice;
}

/** Narrowing helper — assumes the config has already been validated. */
export function asCsvConfig(raw: Record<string, unknown>): CsvConfig {
  return raw as unknown as CsvConfig;
}

/** Wizard choice → the character the reader splits on. */
export const DELIMITER_CHARS: Record<Exclude<DelimiterChoice, 'auto'>, string> = {
  comma: ',',
  semicolon: ';',
  tab: '\t',
  pipe: '|',
};

/** The character back to its name, for messages the user reads. */
export function delimiterLabel(ch: string): string {
  const found = (Object.keys(DELIMITER_CHARS) as Exclude<DelimiterChoice, 'auto'>[])
    .find((k) => DELIMITER_CHARS[k] === ch);
  return found ?? ch;
}
