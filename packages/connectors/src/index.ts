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

// ─── Registry ─────────────────────────────────────────────────────────────
export {
  registerConnector,
  getConnector,
  listConnectorTypes,
  listConnectorCatalog,
  type ConnectorCatalogEntry,
} from './registry';

// ─── Self-register all connectors (side-effect imports) ───────────────────
// Adding a new connector: add an `import './<vendor>';` line below.
// Each connector subfolder's index.ts calls `registerConnector(...)` on import.
import './exactonline';
import './odoo';
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
