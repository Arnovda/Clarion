/**
 * Self-registers the Excel-file connector when this module is imported.
 * The package entry point (`../index.ts`) imports this file for the side effect.
 */

import { registerConnector } from '../registry';
import { ExcelConnector } from './ExcelConnector';

export { ExcelConnector, type ExcelEntity } from './ExcelConnector';
export { excelConfigSchema, asExcelConfig, MAX_BASE64_LENGTH, MAX_FILE_BYTES, type ExcelConfig } from './schema';

registerConnector(ExcelConnector);
