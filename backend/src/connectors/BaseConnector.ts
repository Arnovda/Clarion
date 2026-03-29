export interface ColumnInfo {
  name: string;
  type: string;
  sampleValues: unknown[];
}

export interface TableInfo {
  tableName: string;
  columns: ColumnInfo[];
}

export interface SchemaResult {
  tables: TableInfo[];
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export abstract class BaseConnector {
  abstract connect(): Promise<void>;
  abstract testConnection(): Promise<{ ok: boolean; message: string }>;
  abstract introspectSchema(): Promise<SchemaResult>;
  abstract executeQuery(sql: string): Promise<QueryResult>;
  abstract disconnect(): void;
}
