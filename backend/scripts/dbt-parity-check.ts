/**
 * dbt ↔ direct-DuckDB parity harness.
 *
 * Purpose: before flipping USE_DBT_TRANSFORMATIONS=true in production, prove
 * mechanically that the dbt path produces the same Parquet output as a
 * direct DuckDB execution of the same SQL.
 *
 * How it works (per shape):
 *   1. Writes one or more synthetic source Parquets into the warehouse.
 *   2. Runs every model in the shape's DAG two ways:
 *        (a) directly via duckdb-async (what the legacy runner does)
 *        (b) via a generated dbt project + POST /dbt/run to the ETL
 *      In both paths, preceding models are available as named views/tables
 *      so fact tables can resolve sibling refs.
 *   3. Reads the LAST model's Parquet from both engines, sorts them
 *      deterministically, diffs row-by-row.
 *
 * Not covered here (intentionally):
 *   - Incremental merge semantics — already end-to-end smoke-tested in
 *     Phase 2.2; adding a parity version would require hand-rolling
 *     delete+insert on the direct-DuckDB side, duplicating work.
 *   - Cross-product `{{ source('shared_dims', …) }}` — tested in Phase 2.3.
 *
 * Usage:
 *   cd backend && npx tsx scripts/dbt-parity-check.ts            # all shapes
 *   cd backend && npx tsx scripts/dbt-parity-check.ts dim_simple # one shape
 *
 * Requires:
 *   - docker compose up etl  (the ETL container must be reachable on $ETL_URL)
 *   - shared warehouse volume mounted at ./warehouse in the host
 */

import { Database } from 'duckdb-async';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const ETL_URL = process.env.ETL_URL || 'http://localhost:8000';
const HOST_WAREHOUSE = path.resolve(process.cwd(), '..', 'warehouse');
const ETL_WAREHOUSE = '/warehouse'; // path inside the ETL container

// ─────────────────────────────────────────────────────────────────────────────
// Shape definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One model in a shape's DAG.
 * `sql` is the EXACT SQL both engines run — bare table refs (no macros).
 * For the dbt path, the harness rewrites sibling refs into `{{ ref() }}`
 * so dbt can resolve the DAG; the direct path uses pre-created views.
 */
interface Model {
  name: string;
  sql: string;
}

interface Shape {
  name: string;
  description: string;
  /** Each key becomes a Parquet file that both engines can SELECT FROM by its (extensionless) name. */
  sources: { [tableName: string]: string /* SELECT that materialises the source */ };
  /** DAG of models. Later models can reference earlier ones by name. */
  models: Model[];
  /** Name of the model whose output is diffed. Default: last model in `models`. */
  compareModel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test shapes
// ─────────────────────────────────────────────────────────────────────────────

const SHAPES: Record<string, Shape> = {
  dim_simple: {
    name: 'dim_simple',
    description: 'Single dimension, single source table. Baseline.',
    sources: {
      customers: `
        SELECT * FROM (VALUES
          (1, 'Alice',    500.0),
          (2, 'Bob',     1500.0),
          (3, 'Carol',    800.0),
          (4, 'Dan',     2500.0),
          (5, 'Eve',     3000.0)
        ) AS t(customer_id, name, total_revenue)
      `,
    },
    models: [
      {
        name: 'dim_customer',
        sql: `
          SELECT
            ROW_NUMBER() OVER (ORDER BY customer_id) AS customer_key,
            customer_id,
            name,
            CASE WHEN total_revenue > 1000 THEN 'Gold' ELSE 'Silver' END AS tier
          FROM customers
        `,
      },
    ],
  },

  nulls_and_types: {
    name: 'nulls_and_types',
    description: 'NULL handling + type coercion edge cases. Common silent-divergence source.',
    sources: {
      messy_records: `
        SELECT * FROM (VALUES
          (1,    'Alice',   '100.50', '2024-01-15'),
          (2,    NULL,      '',        NULL),
          (3,    '  Bob  ', 'null',    '2024-03-22'),
          (4,    'Carol',   NULL,      '2024-05-01'),
          (NULL, 'Unknown', '99.99',   '2024-06-10')
        ) AS t(id, name, amount_str, date_str)
      `,
    },
    models: [
      {
        name: 'clean_records',
        sql: `
          SELECT
            COALESCE(id, -1)                                    AS id,
            NULLIF(TRIM(name), '')                              AS name_clean,
            TRY_CAST(NULLIF(TRIM(amount_str), '') AS DOUBLE)    AS amount,
            TRY_CAST(NULLIF(TRIM(date_str), '') AS DATE)        AS event_date
          FROM messy_records
        `,
      },
    ],
  },

  fact_with_join: {
    name: 'fact_with_join',
    description: 'Dim + fact with a JOIN between them. Exercises {{ ref() }} resolution + DAG order.',
    sources: {
      customers: `
        SELECT * FROM (VALUES
          (1, 'Alice'),
          (2, 'Bob'),
          (3, 'Carol')
        ) AS t(customer_id, name)
      `,
      orders: `
        SELECT * FROM (VALUES
          (101, 1, 50.0),
          (102, 2, 75.5),
          (103, 1, 120.0),
          (104, 3, 10.25),
          (105, 2, 200.0),
          (106, 99, 1.0)      -- orphan: no matching customer
        ) AS t(order_id, customer_id, amount)
      `,
    },
    models: [
      {
        name: 'dim_customer',
        sql: `
          SELECT
            ROW_NUMBER() OVER (ORDER BY customer_id) AS customer_key,
            customer_id,
            name
          FROM customers
        `,
      },
      {
        name: 'fact_orders',
        sql: `
          SELECT
            o.order_id,
            COALESCE(dc.customer_key, -1) AS customer_key,
            o.amount
          FROM orders o
          LEFT JOIN dim_customer dc ON dc.customer_id = o.customer_id
        `,
      },
    ],
    compareModel: 'fact_orders',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const shapeArg = process.argv[2];
  const toRun: string[] = shapeArg
    ? [shapeArg]
    : Object.keys(SHAPES);

  if (shapeArg && !SHAPES[shapeArg]) {
    console.error(`Unknown shape: ${shapeArg}. Known: ${Object.keys(SHAPES).join(', ')}`);
    process.exit(1);
  }

  let failures = 0;
  for (const name of toRun) {
    console.log('');
    console.log(`━━━ ${name} ━━━`);
    const shape = SHAPES[name];
    console.log(`    ${shape.description}`);
    try {
      const ok = await runShape(shape);
      if (!ok) failures++;
    } catch (err) {
      failures++;
      console.error(`[parity] ${name}: harness crashed —`, err instanceof Error ? err.message : err);
    }
  }

  console.log('');
  console.log(`━━━ SUMMARY ━━━`);
  console.log(`  shapes run:   ${toRun.length}`);
  console.log(`  passed:       ${toRun.length - failures}`);
  console.log(`  failed:       ${failures}`);
  process.exit(failures === 0 ? 0 : 2);
}

async function runShape(shape: Shape): Promise<boolean> {
  const runId = `parity_${shape.name}_${Date.now()}`;
  const hostWorkDir = path.join(HOST_WAREHOUSE, '_parity', runId);
  const etlWorkDir = `${ETL_WAREHOUSE}/_parity/${runId}`;

  const compareName = shape.compareModel ?? shape.models[shape.models.length - 1].name;

  // Host paths
  const hostSrcDir    = path.join(hostWorkDir, 'source');
  const hostOutADir   = path.join(hostWorkDir, 'out_direct');
  const hostOutBRoot  = path.join(hostWorkDir, 'out_dbt');
  fs.mkdirSync(hostSrcDir,   { recursive: true });
  fs.mkdirSync(hostOutADir,  { recursive: true });
  fs.mkdirSync(hostOutBRoot, { recursive: true });

  // 1. Seed source Parquets (shared by both engines).
  const sourcePaths: Record<string, { host: string; etl: string }> = {};
  {
    const db = await Database.create(':memory:');
    try {
      for (const [tableName, selectSql] of Object.entries(shape.sources)) {
        const hostPath = path.join(hostSrcDir, `${tableName}.parquet`);
        const etlPath  = `${etlWorkDir}/source/${tableName}.parquet`;
        await db.exec(`COPY (${selectSql}) TO '${escapePath(hostPath)}' (FORMAT PARQUET);`);
        sourcePaths[tableName] = { host: hostPath, etl: etlPath };
      }
    } finally {
      await db.close();
    }
  }
  console.log(`[parity] seeded ${Object.keys(sourcePaths).length} source parquet(s)`);

  // 2a. Engine A: direct DuckDB — build every model in sequence, write final output.
  const hostOutA = path.join(hostOutADir, `${compareName}.parquet`);
  await runDirect(shape, sourcePaths, hostOutADir);
  if (!fs.existsSync(hostOutA)) {
    console.error(`[parity] direct output not found: ${hostOutA}`);
    return false;
  }
  console.log(`[parity] engine A (direct): ${path.basename(hostOutA)}`);

  // 2b. Engine B: dbt via ETL.
  await runViaDbt(shape, runId, sourcePaths, hostOutBRoot, etlWorkDir);
  const hostOutB = path.join(hostOutBRoot, compareName, 'data.parquet');
  if (!fs.existsSync(hostOutB)) {
    console.error(`[parity] dbt output not found: ${hostOutB}`);
    return false;
  }
  console.log(`[parity] engine B (dbt):    ${compareName}/data.parquet`);

  // 3. Diff the two outputs row-by-row.
  const diff = await diffParquets(hostOutA, hostOutB);
  if (diff.ok) {
    console.log(`[parity] PASS — ${diff.rowCount} rows match exactly`);
    cleanup(hostWorkDir);
    return true;
  } else {
    console.error(`[parity] FAIL — ${diff.message}`);
    console.error(`         outputs preserved at: ${hostWorkDir}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine A — direct DuckDB
// ─────────────────────────────────────────────────────────────────────────────

async function runDirect(
  shape: Shape,
  sourcePaths: Record<string, { host: string; etl: string }>,
  outDir: string,
): Promise<void> {
  const db = await Database.create(':memory:');
  try {
    // Register every source as a view so bare `FROM customers` resolves.
    for (const [tableName, p] of Object.entries(sourcePaths)) {
      await db.exec(
        `CREATE OR REPLACE VIEW "${tableName}" AS SELECT * FROM read_parquet('${escapePath(p.host)}');`,
      );
    }

    for (const model of shape.models) {
      const outPath = path.join(outDir, `${model.name}.parquet`);
      // COPY (model.sql) TO ...  — same SQL text, no rewriting.
      await db.exec(`COPY (${model.sql}) TO '${escapePath(outPath)}' (FORMAT PARQUET);`);
      // Register as a view so later models can join to it by bare name.
      await db.exec(
        `CREATE OR REPLACE VIEW "${model.name}" AS SELECT * FROM read_parquet('${escapePath(outPath)}');`,
      );
    }
  } finally {
    await db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine B — dbt via ETL
// ─────────────────────────────────────────────────────────────────────────────

async function runViaDbt(
  shape: Shape,
  runId: string,
  sourcePaths: Record<string, { host: string; etl: string }>,
  hostOutRoot: string,
  etlProjectDir: string,
): Promise<void> {
  const hostProjectDir = path.join(HOST_WAREHOUSE, '_parity', runId);
  const modelsDir = path.join(hostProjectDir, 'models');
  const stateDir  = path.join(hostProjectDir, '_state');
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.mkdirSync(stateDir,  { recursive: true });

  // on-run-start: expose every source parquet as a bare-name view so
  // unmodified source refs (e.g. `FROM customers`) resolve. Same shim the
  // real dbtProjectBuilder uses.
  const hookLines = Object.entries(sourcePaths).map(([tableName, p]) =>
    `CREATE OR REPLACE VIEW "${tableName}" AS SELECT * FROM read_parquet('${p.etl}')`,
  );

  fs.writeFileSync(
    path.join(hostProjectDir, 'dbt_project.yml'),
    [
      `name: 'parity'`,
      `version: '1.0.0'`,
      `config-version: 2`,
      `profile: 'parity'`,
      ``,
      `model-paths: ["models"]`,
      `target-path: "target"`,
      `clean-targets: ["target"]`,
      ``,
      `on-run-start:`,
      ...hookLines.map((l) => `  - "${l.replace(/"/g, '\\"')}"`),
      ``,
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(hostProjectDir, 'profiles.yml'),
    [
      `parity:`,
      `  target: dev`,
      `  outputs:`,
      `    dev:`,
      `      type: duckdb`,
      `      path: '${etlProjectDir}/_state/state.duckdb'`,
      ``,
    ].join('\n'),
  );

  const siblingNames = new Set(shape.models.map((m) => m.name));
  const etlOutDir = `${etlProjectDir}/out_dbt`;

  for (const model of shape.models) {
    const outputParquet = `${etlOutDir}/${model.name}/data.parquet`;
    // dbt's external materializer won't mkdir -p; create the per-model dir
    // from the host side (shared volume) before dbt writes into it.
    fs.mkdirSync(path.join(hostOutRoot, model.name), { recursive: true });
    // Rewrite sibling refs into `{{ ref('x') }}` so dbt orders the DAG.
    // Source refs (customers, orders, …) stay bare and resolve via the
    // on-run-start view — matches real dbtProjectBuilder behaviour.
    const rewrittenSql = rewriteSiblingRefs(model.sql, siblingNames);
    fs.writeFileSync(
      path.join(modelsDir, `${model.name}.sql`),
      `{{ config(materialized='external', location='${outputParquet}') }}\n\n${rewrittenSql}\n`,
    );
  }

  const res = await axios.post(
    `${ETL_URL}/dbt/run`,
    { project_dir: etlProjectDir, target: 'dev' },
    { timeout: 5 * 60 * 1000 },
  );
  const data = res.data as {
    ok: boolean;
    stdout?: string;
    stderr?: string;
    summary?: Record<string, number>;
  };
  if (!data.ok) {
    const tail = (s: string | undefined) => (s ?? '').split('\n').slice(-20).join('\n');
    throw new Error(
      `dbt run failed\n--- stdout (last 20 lines) ---\n${tail(data.stdout)}\n--- stderr ---\n${tail(data.stderr)}`,
    );
  }
  if (!data.summary || data.summary.failed > 0) {
    throw new Error(`dbt run produced failures: ${JSON.stringify(data.summary)}`);
  }
  void hostOutRoot; // signal that the Parquet should already be on disk
}

/** Replace bare `FROM x` / `JOIN x` with `{{ ref('x') }}` for every sibling model. */
function rewriteSiblingRefs(sql: string, siblings: Set<string>): string {
  let out = sql;
  for (const name of siblings) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`\\b(FROM|JOIN)\\s+${esc}\\b(?!\\.)`, 'gi'),
      (_m, kw) => `${kw.toUpperCase()} {{ ref('${name}') }}`,
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parquet diff
// ─────────────────────────────────────────────────────────────────────────────

async function diffParquets(a: string, b: string): Promise<{ ok: true; rowCount: number } | { ok: false; message: string }> {
  const db = await Database.create(':memory:');
  try {
    const aCols = await db.all(`DESCRIBE SELECT * FROM read_parquet('${escapePath(a)}')`) as Array<{ column_name: string; column_type: string }>;
    const bCols = await db.all(`DESCRIBE SELECT * FROM read_parquet('${escapePath(b)}')`) as Array<{ column_name: string; column_type: string }>;

    const schemaA = aCols.map((c) => `${c.column_name}:${c.column_type}`).sort().join(',');
    const schemaB = bCols.map((c) => `${c.column_name}:${c.column_type}`).sort().join(',');
    if (schemaA !== schemaB) {
      return { ok: false, message: `schema mismatch\n  A: ${schemaA}\n  B: ${schemaB}` };
    }

    const colList = aCols.map((c) => `"${c.column_name}"`).join(', ');
    const orderBy = aCols.map((c) => `"${c.column_name}"`).join(', ');

    const countsA = Number(((await db.all(`SELECT COUNT(*) AS n FROM read_parquet('${escapePath(a)}')`))[0] as { n: bigint | number }).n);
    const countsB = Number(((await db.all(`SELECT COUNT(*) AS n FROM read_parquet('${escapePath(b)}')`))[0] as { n: bigint | number }).n);
    if (countsA !== countsB) {
      return { ok: false, message: `row count mismatch: A=${countsA} B=${countsB}` };
    }

    // Full row-by-row diff. EXCEPT ALL in both directions catches any row
    // that appears in one and not the other, accounting for duplicates.
    const diffQ = `
      SELECT 'only_in_A' AS side, * FROM (
        SELECT ${colList} FROM read_parquet('${escapePath(a)}')
        EXCEPT ALL
        SELECT ${colList} FROM read_parquet('${escapePath(b)}')
      )
      UNION ALL
      SELECT 'only_in_B' AS side, * FROM (
        SELECT ${colList} FROM read_parquet('${escapePath(b)}')
        EXCEPT ALL
        SELECT ${colList} FROM read_parquet('${escapePath(a)}')
      )
      ORDER BY side, ${orderBy}
      LIMIT 20
    `;
    const diffRows = await db.all(diffQ) as Array<Record<string, unknown>>;
    if (diffRows.length > 0) {
      const sample = diffRows.map((r) => JSON.stringify(r)).join('\n  ');
      return { ok: false, message: `row diff found (showing up to 20):\n  ${sample}` };
    }

    return { ok: true, rowCount: countsA };
  } finally {
    await db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function escapePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/'/g, "''");
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

main().catch((err) => {
  console.error('[parity] harness crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
