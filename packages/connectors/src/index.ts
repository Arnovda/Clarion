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
  TimeBudget,
  EntityCheckpoint,
  EntityCompletion,
  IncompleteEntity,
} from './types';

export { CancellationError } from './types';

// ─── Column types (the platform's rule for "could these be one key?") ─────
export { typeClass, typesJoinable, type TypeClass } from './columnTypes';

// ─── Business keys (declared by the source, not guessed from the data) ────
export { businessKeysFromCatalog, type EntityBusinessKey } from './businessKeys';

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
  readCsv,
  decodeCsvBytes,
  parseDelimited,
  sniffDelimiter,
  CSV_DELIMITERS,
  type CsvDelimiter,
  type CsvEncoding,
  type CsvReadResult,
  type ReadCsvOptions,
} from './spreadsheet/csvReader';
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
  assertSheetComplete,
  SheetTooLargeError,
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
import './csv';
import './excel';
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
// The soft-delete columns every source table carries (phase 2, B2) — the
// backend's view registration hides deleted rows and these columns by name.
export { TECHNICAL_COLUMNS, DELETED_COL, SYNCED_AT_COL } from './parquetOps';
// The worker's DuckDB guardrails (the backend has a mirrored copy; the
// percentage rule is exported so both sides can be tested to agree).
export { pickVisibleMemory, resolveMemoryLimit, visibleMemoryBytes } from './duckdbGuardrails';

// ─── IPC (worker ↔ orchestrator) ──────────────────────────────────────────
export {
  emit as emitWorkerEvent,
  isWorkerEvent,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_CANCELLED,
  type WorkerEvent,
} from './ipc';
