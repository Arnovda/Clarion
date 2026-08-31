/**
 * Public entry point for `@databridge/connectors`.
 *
 * Both the backend (for in-process testConnection / listEntities) and the
 * sync-worker container (for sync execution) import from here. The contract
 * is identical on both sides; only which methods are called differs.
 */

// ─── Types (the contract) ─────────────────────────────────────────────────
export type {
  SourceConnector,
  OAuthSpec,
  ConnectorConfig,
  EntityDescriptor,
  ColumnDoc,
  EntityDocs,
  KnownRelationship,
  ProbeContext,
  SyncOptions,
  SyncContext,
  SyncResult,
  TestResult,
  WarehouseWriter,
  TableWriteResult,
  Logger,
  ProgressMsg,
  CancellationToken,
} from './types';

export { CancellationError } from './types';

// ─── Star-schema templates (deterministic modelling) ──────────────────────
export {
  instantiateStarSchemaTemplate,
  validateStarSchemaTemplate,
  type StarSchemaTemplate,
  type TemplateColumn,
  type TemplateDimension,
  type TemplateFact,
  type TemplateProduct,
  type TemplateRelationship,
  type TemplateKpi,
} from './starSchema';

// ─── Spreadsheet core (shared by every file-backed connector) ─────────────
export {
  readXlsx,
  SpreadsheetReadError,
  XLSX_DEFAULT_MAX_COLS,
  XLSX_DEFAULT_MAX_ROWS,
  type XlsxCellValue,
  type XlsxSheet,
  type XlsxWorkbook,
} from './spreadsheet/xlsxReader';
export {
  coerceCell,
  deriveColumnNames,
  inferSqlType,
  sanitiseEntityName,
  sanitiseIdentifier,
  sheetToTable,
  type SheetTable,
  type TabularColumn,
} from './spreadsheet/tabular';

// ─── Registry ─────────────────────────────────────────────────────────────
export {
  registerConnector,
  getConnector,
  listConnectorTypes,
  listConnectorCatalog,
  type ConnectorCatalogEntry,
} from './registry';

export {
  validateConnectorConfig,
  type ConfigValidationResult,
} from './configValidation';

// ─── Self-register all connectors (side-effect imports) ───────────────────
// Adding a new connector: add an `import './<vendor>';` line below.
// Each connector subfolder's index.ts calls `registerConnector(...)` on import.
import './exactonline';
import './odoo';
import './sharepoint';
// import './netsuite';     // future
// import './quickbooks';   // future
// import './airbyte';      // future

// ─── Base class ───────────────────────────────────────────────────────────
export {
  BaseSourceConnector,
  ConfigValidationError,
  createCancellationToken,
} from './BaseSourceConnector';

// ─── HTTP ─────────────────────────────────────────────────────────────────
export {
  HttpClient,
  HttpError,
  type HttpClientOptions,
  type HttpRequest,
  type HttpResponse,
} from './HttpClient';

// ─── Logging ──────────────────────────────────────────────────────────────
export {
  createStdoutLogger,
  createAdapterLogger,
  createNoopLogger,
  redact,
  redactFields,
} from './logging';

// ─── Warehouse writers ────────────────────────────────────────────────────
export { LocalFileWarehouseWriter } from './ParquetWriter';
export { BlobSasWarehouseWriter } from './BlobSasWarehouseWriter';

// ─── IPC (worker ↔ orchestrator) ──────────────────────────────────────────
export {
  emit as emitWorkerEvent,
  isWorkerEvent,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_CANCELLED,
  type WorkerEvent,
} from './ipc';
