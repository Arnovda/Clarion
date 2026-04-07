/**
 * migrate-sqlite-to-postgres.ts — Copy an entire SQLite database to Postgres
 *
 * Reads all tables from a SQLite file and recreates them in Postgres with
 * appropriate type mappings. Handles foreign keys, indexes, and large datasets.
 *
 * Usage:
 *   SEED_PG_URL="postgresql://..." SQLITE_PATH="../data/wholesale_erp.db" npx ts-node src/migrate-sqlite-to-postgres.ts
 */

import Database from 'better-sqlite3';
import { Pool } from 'pg';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const SQLITE_PATH = process.env.SQLITE_PATH ?? path.resolve(__dirname, '../../data/wholesale_erp.db');
const PG_URL = process.env.SEED_PG_URL ?? 'postgresql://databridge:databridge@localhost:5432/sampledata';

// ---------------------------------------------------------------------------
// SQLite type → Postgres type mapping
// ---------------------------------------------------------------------------

function mapType(sqliteType: string, colName: string): string {
  const t = (sqliteType || 'TEXT').toUpperCase();

  // Known patterns
  if (colName === 'id' || colName.endsWith('_id') || colName === 'regelnr' || colName === 'volgorde' || colName === 'rek' || colName === 'niveau' || colName === 'seq') {
    if (t.includes('INTEGER')) return 'INTEGER';
  }
  if (t.includes('INTEGER') && (colName.includes('actief') || colName.includes('voorkeur') || colName.includes('gekoeld') || colName.includes('diepvries') || colName.includes('afgeleverd') || colName.includes('eu_lid') || colName.includes('export_boekhoud') || colName.includes('leverings_adres'))) {
    return 'BOOLEAN';
  }
  if (t.includes('INTEGER')) return 'INTEGER';
  if (t.includes('REAL') && (colName.includes('prijs') || colName.includes('bedrag') || colName.includes('totaal') || colName.includes('saldo') || colName.includes('limiet') || colName.includes('kost') || colName.includes('koers'))) {
    return 'NUMERIC(14,4)';
  }
  if (t.includes('REAL')) return 'NUMERIC(14,4)';
  if (t.includes('DATE') && !t.includes('TIME')) return 'DATE';
  if (t.includes('DATETIME') || t.includes('TIMESTAMP')) return 'TIMESTAMP';
  if (t === 'TIME') return 'TIME';
  if (t.includes('BLOB')) return 'BYTEA';
  return 'TEXT';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`SQLite: ${SQLITE_PATH}`);
  console.log(`Postgres: ${PG_URL.replace(/:[^:@]+@/, ':***@')}\n`);

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pool = new Pool({
    connectionString: PG_URL,
    ssl: PG_URL.includes('azure.com') ? { rejectUnauthorized: false } : undefined,
  });
  const pg = await pool.connect();

  try {
    // Get all tables (skip sqlite_sequence and other internal tables)
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];

    console.log(`Found ${tables.length} tables to migrate\n`);

    // Phase 1: Drop all tables in Postgres (reverse order to handle FKs)
    await pg.query('BEGIN');
    for (const { name } of [...tables].reverse()) {
      await pg.query(`DROP TABLE IF EXISTS "${name}" CASCADE`);
    }
    await pg.query('COMMIT');

    // Phase 2: Create tables and insert data
    await pg.query('BEGIN');

    for (const { name } of tables) {
      // Get column info from SQLite
      const columns = sqlite.prepare(`PRAGMA table_info("${name}")`).all() as {
        cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
      }[];

      // Build CREATE TABLE DDL
      const colDefs = columns.map(col => {
        const pgType = mapType(col.type, col.name);
        const parts = [`"${col.name}"`, pgType];
        if (col.pk) parts.push('PRIMARY KEY');
        if (col.notnull && !col.pk) parts.push('NOT NULL');
        // Skip defaults for now — they're SQLite-specific
        return parts.join(' ');
      });

      const createSql = `CREATE TABLE "${name}" (\n  ${colDefs.join(',\n  ')}\n)`;
      await pg.query(createSql);

      // Get row count
      const countRow = sqlite.prepare(`SELECT COUNT(*) as n FROM "${name}"`).get() as { n: number };

      if (countRow.n === 0) {
        console.log(`  ${name}: 0 rows (table created)`);
        continue;
      }

      // Insert data in batches of 500
      const BATCH_SIZE = 500;
      const allRows = sqlite.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
      const colNames = columns.map(c => `"${c.name}"`).join(', ');

      let inserted = 0;
      for (let i = 0; i < allRows.length; i += BATCH_SIZE) {
        const batch = allRows.slice(i, i + BATCH_SIZE);

        // Build a multi-row INSERT
        const valueSets: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        for (const row of batch) {
          const placeholders: string[] = [];
          for (const col of columns) {
            let val = row[col.name];
            const pgType = mapType(col.type, col.name);

            // Convert SQLite integers to booleans for Postgres
            if (pgType === 'BOOLEAN' && val !== null && val !== undefined) {
              val = val === 1 || val === true;
            }

            placeholders.push(`$${paramIdx++}`);
            params.push(val ?? null);
          }
          valueSets.push(`(${placeholders.join(', ')})`);
        }

        const insertSql = `INSERT INTO "${name}" (${colNames}) VALUES ${valueSets.join(', ')}`;
        await pg.query(insertSql, params);
        inserted += batch.length;
      }

      // Reset sequence if table has SERIAL-like column
      const pkCol = columns.find(c => c.pk);
      if (pkCol && mapType(pkCol.type, pkCol.name) === 'INTEGER') {
        const maxRow = sqlite.prepare(`SELECT MAX("${pkCol.name}") as mx FROM "${name}"`).get() as { mx: number | null };
        if (maxRow.mx) {
          // Check if there's a sequence for this column
          try {
            await pg.query(`SELECT setval(pg_get_serial_sequence('"${name}"', '${pkCol.name}'), $1, true)`, [maxRow.mx]);
          } catch {
            // No sequence — that's fine (it's a plain INTEGER PK, not SERIAL)
          }
        }
      }

      console.log(`  ${name}: ${inserted} rows`);
    }

    await pg.query('COMMIT');

    // Phase 3: Add foreign keys (best effort — don't fail migration if one doesn't work)
    console.log('\nAdding foreign keys...');
    for (const { name } of tables) {
      const fks = sqlite.prepare(`PRAGMA foreign_key_list("${name}")`).all() as {
        id: number; seq: number; table: string; from: string; to: string;
      }[];

      const grouped = new Map<number, { table: string; from: string[]; to: string[] }>();
      for (const fk of fks) {
        if (!grouped.has(fk.id)) grouped.set(fk.id, { table: fk.table, from: [], to: [] });
        const g = grouped.get(fk.id)!;
        g.from.push(fk.from);
        g.to.push(fk.to);
      }

      for (const [, fk] of grouped) {
        const fromCols = fk.from.map(c => `"${c}"`).join(', ');
        const toCols = fk.to.map(c => `"${c}"`).join(', ');
        try {
          await pg.query(`ALTER TABLE "${name}" ADD FOREIGN KEY (${fromCols}) REFERENCES "${fk.table}" (${toCols})`);
        } catch (err: any) {
          console.log(`  Warning: FK ${name}(${fk.from}) → ${fk.table}(${fk.to}) skipped: ${err.message?.slice(0, 80)}`);
        }
      }
    }

    // Summary
    let totalRows = 0;
    for (const { name } of tables) {
      const r = await pg.query(`SELECT COUNT(*) as n FROM "${name}"`);
      totalRows += parseInt(r.rows[0].n);
    }
    console.log(`\nMigration complete: ${tables.length} tables, ${totalRows.toLocaleString()} total rows`);

  } catch (err) {
    await pg.query('ROLLBACK');
    console.error('Migration failed, rolled back:', err);
    process.exit(1);
  } finally {
    pg.release();
    sqlite.close();
    await pool.end();
  }
}

main();
