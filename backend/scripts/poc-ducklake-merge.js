#!/usr/bin/env node
/*
 * Phase-2 PoC (2026-09-10): DuckLake MERGE vs the single-file parquet rewrite,
 * kept as the evidence behind docs/backlog/ingestion-chain-assessment.md §9.
 *
 * Run from backend/ (needs its duckdb binding and a local Postgres):
 *   sudo -u postgres psql -c "CREATE DATABASE poc_lake OWNER databridge"
 *   NODE_PATH=./node_modules ROWS=3000000 DELTA=10000 MEM=1200MB POC_DIR=/tmp/poc node scripts/poc-ducklake-merge.js
 * Synthetic data only — nothing here touches a tenant.
 */
const duckdb = require('duckdb');
const fs = require('fs');
const path = require('path');

const ROWS = Number(process.env.ROWS || 3_000_000);
const DELTA = Number(process.env.DELTA || 10_000);
const MEM = process.env.MEM || '60%';
const DIR = path.resolve(process.env.POC_DIR || path.join(__dirname, 'data'));
const PG = process.env.PG_CATALOG || 'dbname=poc_lake host=localhost user=databridge password=databridge';

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

function open() {
  const db = new duckdb.Database(':memory:');
  const all = (sql) => new Promise((res, rej) => db.all(sql, (e, r) => (e ? rej(e) : res(r))));
  const close = () => new Promise((res) => db.close(res));
  return { all, close };
}

let peak = 0; let base = 0;
const sampler = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r; }, 25);
function resetPeak() { base = process.memoryUsage().rss; peak = base; }
const mb = (n) => (n / 1024 / 1024).toFixed(0) + ' MB';
async function timed(label, fn) {
  resetPeak(); const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  console.log(`${label.padEnd(58)} ${String(ms).padStart(7)} ms   peak RSS ${mb(peak)} (start ${mb(base)})`);
  return out;
}
function dirBytes(d) {
  let n = 0;
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    n += f.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return n;
}

const guard = async (all) => { await all(`SET threads=1`); await all(`SET memory_limit='${MEM}'`); await all(`SET temp_directory='${DIR}/tmp'`); };

const GEN = (n, offset) => `
  SELECT
    md5((i + ${offset})::varchar)                                   AS ID,
    (i + ${offset})::bigint                                          AS EntryNumber,
    ((i + ${offset}) % 12 + 1)::integer                              AS LineNumber,
    (DATE '2016-01-01' + ((i + ${offset}) % 3650)::integer)          AS Date,
    ('1' || ((i + ${offset}) % 400 + 100)::varchar)                  AS AccountCode,
    ((i + ${offset}) % 700 + 400000)::varchar                        AS GLAccountCode,
    ('J' || ((i + ${offset}) % 9)::varchar)                          AS JournalCode,
    md5(((i + ${offset}) % 5000)::varchar)                           AS Account,
    md5(((i + ${offset}) % 900)::varchar)                            AS GLAccount,
    round(((i + ${offset}) % 100000) / 7.0, 2)::double               AS AmountDC,
    round(((i + ${offset}) % 100000) / 7.0, 2)::double               AS AmountFC,
    round(((i + ${offset}) % 21000) / 7.0, 2)::double                AS VATAmountDC,
    'EUR'                                                            AS Currency,
    ('Line ' || (i + ${offset})::varchar || ' lorem ipsum dolor sit amet')  AS Description,
    ('INV-' || ((i + ${offset}) / 4)::varchar)                       AS InvoiceNumber,
    ((i + ${offset}) % 4 = 0)                                        AS Status,
    (TIMESTAMP '2016-01-01' + INTERVAL ((i + ${offset}) % 300000000) SECOND) AS Created,
    (TIMESTAMP '2024-01-01' + INTERVAL ((i + ${offset}) % 30000000) SECOND)  AS Modified
  FROM range(${n}) t(i)`;

(async () => {
  console.log(`rows=${ROWS} delta=${DELTA} memory_limit=${MEM} threads=1 dir=${DIR}`);
  const base = path.join(DIR, 'TransactionLines');
  fs.mkdirSync(base, { recursive: true });
  const parquet = path.join(base, 'data.parquet');
  const delta = path.join(DIR, 'delta.ndjson');

  // ── setup: the table as it sits in the warehouse today + one delta ──
  {
    const { all, close } = open(); await all(`SET threads=4`);
    await timed('setup: write base parquet', () => all(`COPY (${GEN(ROWS, 0)}) TO '${parquet}' (FORMAT parquet, COMPRESSION snappy)`));
    // delta: DELTA/2 updates of existing keys (bumped Modified + Amount), DELTA/2 new keys
    await timed('setup: write delta ndjson', () => all(`
      COPY (
        SELECT * REPLACE (AmountDC * 1.5 AS AmountDC, TIMESTAMP '2026-09-10 02:00:00' AS Modified)
        FROM (${GEN(DELTA / 2, 0)}) WHERE EntryNumber % 2 = 0
        UNION ALL BY NAME
        SELECT * FROM (${GEN(DELTA / 2, ROWS)})
      ) TO '${delta}' (FORMAT json)`));
    await close();
    console.log(`base parquet ${mb(fs.statSync(parquet).size)}`);
  }

  // ── A. the current writer's merge, verbatim shape ───────────────────
  for (const [label, setup] of [
    ['A  current merge (UNION BY NAME + ROW_NUMBER, full rewrite)', ''],
    ['A2 same + preserve_insertion_order=false', `SET preserve_insertion_order=false`],
    ['A3 same, memory_limit=4GB (what it really needs)', `SET memory_limit='4GB'`],
  ]) {
    const { all, close } = open(); await guard(all); if (setup) await all(setup);
    const tmpOut = path.join(DIR, 'merge-out.parquet');
    try {
    await timed(label, () => all(`
      COPY (
        WITH delta AS (SELECT * FROM read_json('${delta}', format='newline_delimited', auto_detect=true)),
        existing AS (SELECT * FROM read_parquet('${parquet}')),
        merged AS (SELECT *, 0 AS _origin FROM existing UNION ALL BY NAME SELECT *, 1 AS _origin FROM delta),
        ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY "ID" ORDER BY _origin DESC) AS _rn FROM merged)
        SELECT * EXCLUDE (_origin, _rn) FROM ranked WHERE _rn = 1
      ) TO '${tmpOut}' (FORMAT parquet, COMPRESSION snappy)`));
    const n = await all(`SELECT count(*) n, count(DISTINCT ID) d FROM read_parquet('${tmpOut}')`);
    console.log(`   result rows ${n[0].n} distinct ${n[0].d}  file ${mb(fs.statSync(tmpOut).size)}`);
    } catch (e) { console.log(`${label} FAILED: ${String(e.message).split('\n')[0].slice(0, 160)}`); }
    await close();
  }

  // ── B. DuckLake, Postgres catalog ───────────────────────────────────
  for (const [label, attach, dataDir] of [
    ['B  DuckLake (Postgres catalog)', `ducklake:postgres:${PG}`, path.join(DIR, 'lake_pg')],
    ['C  DuckLake (DuckDB-file catalog)', `ducklake:${path.join(DIR, 'meta.ducklake')}`, path.join(DIR, 'lake_file')],
  ]) {
    fs.mkdirSync(dataDir, { recursive: true });
    const { all, close } = open(); await guard(all);
    try {
      await all(`INSTALL ducklake; LOAD ducklake;`);
      await all(`ATTACH '${attach}' AS lake (DATA_PATH '${dataDir}/')`);
      await timed(`${label}: initial load from parquet`, () => all(`CREATE TABLE lake.tl AS SELECT * FROM read_parquet('${parquet}')`));
      await timed(`${label}: MERGE INTO 10k delta`, () => all(`
        MERGE INTO lake.tl AS t
        USING (SELECT * FROM read_json('${delta}', format='newline_delimited', auto_detect=true)) AS d
        ON t.ID = d.ID
        WHEN MATCHED THEN UPDATE
        WHEN NOT MATCHED THEN INSERT`));
      const n = await all(`SELECT count(*) n, count(DISTINCT ID) d FROM lake.tl`);
      console.log(`   result rows ${n[0].n} distinct ${n[0].d}  data dir ${mb(dirBytes(dataDir))}`);
      await timed(`${label}: soft-delete 1000 rows (UPDATE)`, () => all(`ALTER TABLE lake.tl ADD COLUMN _clarion_deleted BOOLEAN`).then(() =>
        all(`UPDATE lake.tl SET _clarion_deleted = (EntryNumber < 1000)`)));
      const snaps = await all(`SELECT count(*) n FROM lake.snapshots()`);
      const tt = await all(`SELECT count(*) n FROM lake.tl AT (VERSION => 1)`);
      console.log(`   snapshots ${snaps[0].n}; rows at version 1 (time travel) ${tt[0].n}`);
      await timed(`${label}: read  GROUP BY over the lake table`, () => all(`SELECT AccountCode, sum(AmountDC) FROM lake.tl WHERE NOT COALESCE(_clarion_deleted, false) GROUP BY 1`));
      await timed(`${label}: second MERGE (same delta, idempotent)`, () => all(`
        MERGE INTO lake.tl AS t
        USING (SELECT * FROM read_json('${delta}', format='newline_delimited', auto_detect=true)) AS d
        ON t.ID = d.ID
        WHEN MATCHED THEN UPDATE
        WHEN NOT MATCHED THEN INSERT`));
      const files = await all(`SELECT count(*) n, sum(file_size_bytes) b FROM lake.ducklake_table_info() WHERE table_name='tl'`).catch(() => null);
      if (files) console.log(`   files ${files[0].n} bytes ${mb(Number(files[0].b))}`);
      await timed(`${label}: expire + merge_adjacent_files`, async () => {
        await all(`CALL lake.merge_adjacent_files()`).catch((e) => console.log('   merge_adjacent_files: ' + String(e.message).slice(0, 120)));
        await all(`CALL lake.expire_snapshots(older_than => now())`).catch((e) => console.log('   expire_snapshots: ' + String(e.message).slice(0, 120)));
        await all(`CALL lake.cleanup_old_files(cleanup_all => true)`).catch((e) => console.log('   cleanup_old_files: ' + String(e.message).slice(0, 120)));
      });
      console.log(`   data dir after maintenance ${mb(dirBytes(dataDir))}`);
    } catch (e) {
      console.log(`${label} FAILED: ${String(e.message).slice(0, 400)}`);
    }
    await close();
  }

  // ── read benchmark: parquet vs lake, fresh process-independent session ─
  {
    const { all, close } = open(); await guard(all);
    await timed('read  GROUP BY over base parquet (today)', () => all(`SELECT AccountCode, sum(AmountDC) FROM read_parquet('${parquet}') GROUP BY 1`));
    await close();
  }
  clearInterval(sampler);
})().catch((e) => { console.error(e); clearInterval(sampler); process.exit(1); });
