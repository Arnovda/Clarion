import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { BaseConnector, SchemaResult, QueryResult, TableInfo, ColumnInfo, FkCandidate } from './BaseConnector';

export class SqliteConnector extends BaseConnector {
  private readonly filePath: string;
  private db: Database.Database | null = null;

  constructor(filePath: string) {
    super();
    this.filePath = path.resolve(filePath);
  }

  async connect(): Promise<void> {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`SQLite file not found: ${this.filePath}`);
    }
    // readonly: true — DataBridge never writes to the source database
    this.db = new Database(this.filePath, { readonly: true });
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      if (!fs.existsSync(this.filePath)) {
        return { ok: false, message: `File not found: ${this.filePath}` };
      }
      const db = new Database(this.filePath, { readonly: true });
      db.prepare('SELECT 1').get();
      db.close();
      return { ok: true, message: 'Connection successful' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, message };
    }
  }

  async introspectSchema(): Promise<SchemaResult> {
    const db = this.requireDb();

    // Get all user-defined tables (exclude SQLite internal tables)
    const tableRows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>;

    const tables: TableInfo[] = [];

    for (const { name: tableName } of tableRows) {
      // Get column info via PRAGMA
      const pragmaRows = db
        .prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`)
        .all() as Array<{ name: string; type: string }>;

      const columns: ColumnInfo[] = [];

      for (const col of pragmaRows) {
        // Sample up to 5 distinct non-null values for this column
        let sampleValues: unknown[] = [];
        try {
          const samples = db
            .prepare(
              `SELECT DISTINCT ${JSON.stringify(col.name)} AS val
               FROM ${JSON.stringify(tableName)}
               WHERE ${JSON.stringify(col.name)} IS NOT NULL
               LIMIT 5`,
            )
            .all() as Array<{ val: unknown }>;
          sampleValues = samples.map((r) => r.val);
        } catch {
          // Column sampling is best-effort; don't fail introspection
        }

        columns.push({
          name: col.name,
          type: col.type || 'TEXT',
          sampleValues,
        });
      }

      tables.push({ tableName, columns });
    }

    // ── FK detection (engine-agnostic layers live in BaseConnector) ─────────
    const { candidates: fkCandidates, classifications: tableClassifications } = await this.detectForeignKeys(tables);

    return { tables, fkCandidates, tableClassifications };
  }

  /**
   * SQLite-specific: read declared FKs via PRAGMA foreign_key_list.
   * Other connectors override this with their engine's equivalent
   * (e.g. information_schema for Postgres/MySQL).
   */
  async introspectDeclaredFks(tables: TableInfo[]): Promise<FkCandidate[]> {
    const db = this.requireDb();
    const declared: FkCandidate[] = [];
    for (const table of tables) {
      try {
        const fks = db
          .prepare(`PRAGMA foreign_key_list(${JSON.stringify(table.tableName)})`)
          .all() as Array<{ table: string; from: string; to: string }>;
        for (const fk of fks) {
          declared.push({
            fromTable: table.tableName,
            fromColumn: fk.from,
            toTable: fk.table,
            toColumn: fk.to,
            source: 'declared',
            confidence: 1.0,
          });
        }
      } catch { /* PRAGMA may fail on views or virtual tables */ }
    }
    return declared;
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    const db = this.requireDb();
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    return { rows, rowCount: rows.length };
  }

  disconnect(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error('SqliteConnector: call connect() before using the connector');
    }
    return this.db;
  }
}
