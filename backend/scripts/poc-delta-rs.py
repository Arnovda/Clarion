#!/usr/bin/env python3
"""
Phase-2 PoC, second half (2026-09-10): delta-rs (the `deltalake` package the
topic sidecar runs) on the SAME 3M-row TransactionLines shape as
`poc-ducklake-merge.js`. Kept as the evidence behind
docs/backlog/ingestion-chain-assessment.md §9 — the numbers there decided
that the topic sidecar OVERWRITES (streaming) and computes its change counts
in DuckDB, and that delta-rs MERGE is not a writer for a 1 GiB container.

One operation per process (argv[1]) so `ru_maxrss` is THAT operation's peak,
not the process lifetime's:
    python3 -m venv /tmp/v && /tmp/v/bin/pip install deltalake==1.6.3 pyarrow==25.0.1 duckdb
    cd /tmp/poc && for op in setup A B C H D E F G; do /tmp/v/bin/python <repo>/backend/scripts/poc-delta-rs.py $op; done
`taskset -c 0 …` reproduces the 0.5-vCPU job container's view of the CPUs.
Synthetic data only — nothing here touches a tenant.
"""
import os, sys, time, resource
import pyarrow as pa, pyarrow.parquet as pq
from deltalake import DeltaTable, write_deltalake

ROWS = int(os.environ.get("ROWS", 3_000_000)); DELTA = int(os.environ.get("DELTA", 10_000))
DIR = os.path.abspath(os.environ.get("POC_DIR", "data")); OP = sys.argv[1]
os.makedirs(DIR, exist_ok=True)
base = f"{DIR}/base.parquet"; delta = f"{DIR}/delta.parquet"; newstate = f"{DIR}/newstate.parquet"; tbl = f"{DIR}/TransactionLines"
FS = 64 * 1024 * 1024
COLS = ["ID","EntryNumber","LineNumber","Date","AccountCode","GLAccountCode","JournalCode","Account","GLAccount","AmountDC","AmountFC","VATAmountDC","Currency","Description","InvoiceNumber","Status","Created","Modified"]
HASH = "md5(concat_ws(chr(31), " + ", ".join(f"COALESCE(CAST({c} AS VARCHAR),'NULL')" for c in COLS) + ")) AS _row_hash"

def gen(n, off):
    return f"""SELECT md5((i+{off})::varchar) AS ID, (i+{off})::bigint AS EntryNumber, ((i+{off})%12+1)::integer AS LineNumber,
    (DATE '2016-01-01' + ((i+{off})%3650)::integer) AS Date, ('1'||((i+{off})%400+100)::varchar) AS AccountCode,
    ((i+{off})%700+400000)::varchar AS GLAccountCode, ('J'||((i+{off})%9)::varchar) AS JournalCode,
    md5(((i+{off})%5000)::varchar) AS Account, md5(((i+{off})%900)::varchar) AS GLAccount,
    round(((i+{off})%100000)/7.0,2)::double AS AmountDC, round(((i+{off})%100000)/7.0,2)::double AS AmountFC,
    round(((i+{off})%21000)/7.0,2)::double AS VATAmountDC, 'EUR' AS Currency,
    ('Line '||(i+{off})::varchar||' lorem ipsum dolor sit amet') AS Description, ('INV-'||((i+{off})/4)::varchar) AS InvoiceNumber,
    ((i+{off})%4=0) AS Status, (TIMESTAMP '2016-01-01' + INTERVAL ((i+{off})%300000000) SECOND) AS Created,
    (TIMESTAMP '2024-01-01' + INTERVAL ((i+{off})%30000000) SECOND) AS Modified FROM range({n}) t(i)"""

def rss(): return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
def reader(path):
    pf = pq.ParquetFile(path); return pa.RecordBatchReader.from_batches(pf.schema_arrow, pf.iter_batches(batch_size=65536))
def timed(label, fn):
    t = time.time(); out = fn(); print(f"{label:62s} {time.time()-t:7.2f}s  peak RSS {rss():.0f} MB", flush=True); return out
def dirmb(d): return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(d) for f in fs) / 1e6
def nfiles(): return len(DeltaTable(tbl).file_uris())

if OP == "setup":
    import duckdb
    con = duckdb.connect(); con.execute("SET threads=4"); t0 = time.time()
    con.execute(f"COPY (SELECT *, {HASH} FROM ({gen(ROWS,0)})) TO '{base}' (FORMAT parquet, COMPRESSION snappy)")
    con.execute(f"""COPY (SELECT *, {HASH} FROM (SELECT * REPLACE (AmountDC*1.5 AS AmountDC, TIMESTAMP '2026-09-10 02:00:00' AS Modified) FROM ({gen(DELTA//2,0)}) WHERE EntryNumber%2=0
       UNION ALL BY NAME SELECT * FROM ({gen(DELTA//2,ROWS)}))) TO '{delta}' (FORMAT parquet)""")
    con.execute(f"""COPY (SELECT *, {HASH} FROM (
       SELECT * REPLACE (CASE WHEN EntryNumber % 600 = 0 THEN AmountDC*1.5 ELSE AmountDC END AS AmountDC) FROM ({gen(ROWS,0)}) WHERE EntryNumber % 600 <> 1
       UNION ALL BY NAME SELECT * FROM ({gen(DELTA//2,ROWS)}))) TO '{newstate}' (FORMAT parquet)""")
    print(f"setup {time.time()-t0:.1f}s base parquet {os.path.getsize(base)/1e6:.0f} MB", flush=True)
elif OP == "A":
    import shutil; shutil.rmtree(tbl, ignore_errors=True)
    timed("A  create Delta from base parquet (streaming write, 64MB files)", lambda: write_deltalake(tbl, reader(base), mode="overwrite", target_file_size=FS, configuration={"delta.targetFileSize": str(FS)}))
    print("   files", nfiles(), f"{dirmb(tbl):.0f} MB", flush=True)
elif OP == "B":
    def run():
        m = DeltaTable(tbl).merge(reader(delta), predicate="t.ID = s.ID", source_alias="s", target_alias="t", streamed_exec=True)
        return m.when_matched_update_all(predicate="s._row_hash <> t._row_hash").when_not_matched_insert_all().execute()
    m = timed("B  source-style merge: 10k delta (5k upd, 5k ins) into 3M", run)
    print("   ", {k: m[k] for k in ("num_target_rows_inserted","num_target_rows_updated","num_target_rows_copied","num_target_files_added","num_target_files_removed")}, "files", nfiles(), flush=True)
elif OP == "C":
    def run():
        m = DeltaTable(tbl).merge(reader(newstate), predicate="t.ID = s.ID", source_alias="s", target_alias="t", streamed_exec=True)
        return m.when_matched_update_all(predicate="s._row_hash <> t._row_hash").when_not_matched_insert_all().when_not_matched_by_source_delete().execute()
    m = timed("C  topic-style merge: 3M new state vs 3M target (upd/ins/del)", run)
    print("   ", {k: m[k] for k in ("num_target_rows_inserted","num_target_rows_updated","num_target_rows_deleted","num_target_rows_copied","num_target_files_added","num_target_files_removed")}, flush=True)
    dt = DeltaTable(tbl); adds = dt.get_add_actions(flatten=True).to_pydict(); print("   rows via add actions", sum(adds["num_records"]), "files", len(dt.file_uris()), flush=True)
elif OP == "D":
    timed("D  topic-style streaming OVERWRITE of 3M (the old sidecar's write)", lambda: write_deltalake(tbl, reader(newstate), mode="overwrite", schema_mode="merge", target_file_size=FS))
    print("   files", nfiles(), f"{dirmb(tbl):.0f} MB", flush=True)
elif OP == "E":
    u = timed("E  soft-delete UPDATE (finalizeFullSync shape) on 1/600 rows", lambda: DeltaTable(tbl).update(updates={"Status": "true"}, predicate="EntryNumber % 600 = 2"))
    print("   ", {k: u[k] for k in ("num_updated_rows","num_copied_rows","num_added_files","num_removed_files")}, flush=True)
elif OP == "F":
    c = timed("F  optimize.compact (64MB target)", lambda: DeltaTable(tbl).optimize.compact(target_size=FS))
    print("   ", {k: c[k] for k in ("numFilesAdded","numFilesRemoved","totalConsideredFiles")}, "files", nfiles(), flush=True)
elif OP == "G":
    v = timed("G  vacuum (retention 0h, enforcement off)", lambda: DeltaTable(tbl).vacuum(retention_hours=0, dry_run=False, enforce_retention_duration=False))
    print("   removed", len(v), "files; dir", f"{dirmb(tbl):.0f} MB", flush=True)
elif OP == "H":
    def run():
        dt = DeltaTable(tbl)
        ex = dt.to_pyarrow_dataset().to_table(columns=["ID", "_row_hash"]).rename_columns(["ID", "h_old"])
        nw = pq.read_table(newstate, columns=["ID", "_row_hash"]).rename_columns(["ID", "h_new"])
        j = ex.join(nw, keys="ID", join_type="full outer")
        import pyarrow.compute as pc
        old, new = j["h_old"], j["h_new"]
        return {"ins": pc.sum(pc.and_(pc.is_null(old), pc.is_valid(new))).as_py(), "del": pc.sum(pc.and_(pc.is_valid(old), pc.is_null(new))).as_py(),
                "upd": pc.sum(pc.and_(pc.and_(pc.is_valid(old), pc.is_valid(new)), pc.not_equal(old, new))).as_py()}
    print("   ", timed("H  projected key/hash diff via pyarrow full-outer join (3M vs 3M)", run), flush=True)
