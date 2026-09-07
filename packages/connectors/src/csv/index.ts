/**
 * Self-registers the CSV-file connector when this module is imported.
 * The package entry point (`../index.ts`) imports this file for the side effect.
 */

import { registerConnector } from '../registry';
import { CsvConnector } from './CsvConnector';

export { CsvConnector } from './CsvConnector';
export {
  csvConfigSchema,
  asCsvConfig,
  DELIMITER_CHARS,
  DELIMITER_CHOICES,
  ENCODING_CHOICES,
  MAX_BASE64_LENGTH,
  MAX_FILE_BYTES,
  type CsvConfig,
  type DelimiterChoice,
  type EncodingChoice,
} from './schema';

registerConnector(CsvConnector);
