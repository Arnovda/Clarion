#!/usr/bin/env python3
"""
Delta writer sidecar for product (topic) tables — and, in `maintain` mode,
the compaction/vacuum pass the weekly maintenance job runs over them.

Node DuckDB executes the AI-generated transformation SQL and writes the
result to a temporary parquet, `_row_hash` included (computed in DuckDB —
see `deltaWriter.ts`). This sidecar owns the Delta commit and reports the
per-refresh change counts (unchanged / updated / inserted / deleted) that
`product_table_refresh_history` and the change-evolution chart read.

THE RULE THIS FILE EXISTS TO KEEP (2026-09-10): THE TABLE IS NEVER
MATERIALISED IN THIS PROCESS. The previous version loaded the existing
Delta table AND the new state into pandas, hashed every row with a Python
lambda, outer-merged the two frames for the counts, and then overwrote the
table. Two full copies of a fact table in a 1 GiB jobs-worker — the same
failure class phase 2 fixed on the source side (`parquetOps.ts`), live on
the topic side. Now:

  • the new state is streamed to delta-rs as a RecordBatchReader (one
    parquet row group at a time), with the per-batch type coercions Delta
    needs applied on the way through;
  • the change counts arrive FROM NODE (`counts` in the config): DuckDB
    joins the previous state's key + hash against the new state's under
    its own memory limit, spilling to disk when it must. Nothing here is
    proportional to the table;
  • the write is a streaming OVERWRITE — a topic is a full recompute, so
    that is its natural semantics. delta-rs' MERGE was measured on the
    same 3M-row PoC table and rejected: 1.3–1.9 GB peak for a 10k-row
    delta, killed at 4+ GB for a full-table merge, whichever executor —
    inside a 1 GiB container that is not a writer (assessment §9). The
    streaming overwrite peaks at ~300 MB on the same table.

Contract (unchanged): JSON config on stdin, one JSON result on stdout,
exit 0 for application failures (`status: "failed"`), non-zero only for
an unparseable config. `mode` is `scd1` (the write) or `maintain`.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from typing import Any, Iterator, Optional

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

# deltalake is imported inside the functions that need it, so the pure
# helpers stay importable (and testable) without it.

# ── Hashing ─────────────────────────────────────────────────────────────────

# ASCII Unit Separator — impossible to confuse with column data. Node's
# DuckDB formula uses the same separator (`chr(31)`) and the same 'NULL'
# sentinel; see `rowHashExpression` in deltaWriter.ts.
HASH_SEP = "\x1f"
ROW_HASH_COL = "_row_hash"
NO_BUSINESS_COLUMNS_HASH = "no-business-columns"

# delta-rs' default is ~100 MB; 64 MB keeps a merge's rewrite unit small.
DEFAULT_TARGET_FILE_SIZE = 64 * 1024 * 1024
DEFAULT_VACUUM_RETENTION_HOURS = 7 * 24
READ_BATCH = 8_192
WRITE_BATCH = 8_192
WRITE_ROW_GROUP = 65_536


def hash_row(values: list[Any]) -> str:
    """
    Deterministic per-row hash: md5 over a unit-separated string of the
    row's business-column values, 'NULL' for missing. Kept for the
    fallback that hashes in Python when the parquet carries no `_row_hash`
    (a Node older than this file). The DuckDB formula is the primary one;
    the two agree on the shape, not on every value's spelling (a boolean
    is `true` in DuckDB and `True` here), which only ever costs one
    all-updated refresh on a table that crosses from one to the other.
    """
    parts: list[str] = []
    for v in values:
        if v is None or (isinstance(v, float) and v != v):
            parts.append("NULL")
        else:
            parts.append(str(v))
    return hashlib.md5(HASH_SEP.join(parts).encode("utf-8")).hexdigest()


def hash_batch(batch: pa.RecordBatch, business_columns: list[str]) -> pa.Array:
    """`_row_hash` for one batch, over the business columns it actually has."""
    present = [c for c in business_columns if c in batch.schema.names]
    if not present:
        return pa.array([NO_BUSINESS_COLUMNS_HASH] * batch.num_rows, type=pa.string())
    cols = [batch.column(c).to_pylist() for c in present]
    return pa.array([hash_row(list(row)) for row in zip(*cols)], type=pa.string())


# ── Storage options for Azure ───────────────────────────────────────────────


def derive_storage_options(path: str) -> dict[str, str]:
    """
    Build deltalake storage_options from the URI scheme + env vars. Local
    paths need none; Azure paths need credentials:
      1. AZURE_STORAGE_CONNECTION_STRING (account key or SAS inside it)
      2. AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY
      3. managed identity / Azure CLI when AZURE_USE_AZURE_CLI=true
    """
    if not path.startswith("az://"):
        return {}

    conn_str = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
    if conn_str:
        parts = dict(kv.split("=", 1) for kv in conn_str.split(";") if "=" in kv)
        opts: dict[str, str] = {}
        if "AccountName" in parts:
            opts["account_name"] = parts["AccountName"]
        if "AccountKey" in parts:
            opts["account_key"] = parts["AccountKey"]
        if "SharedAccessSignature" in parts:
            opts["sas_token"] = parts["SharedAccessSignature"]
        return opts

    account = os.environ.get("AZURE_STORAGE_ACCOUNT_NAME")
    key = os.environ.get("AZURE_STORAGE_ACCOUNT_KEY")
    if account and key:
        return {"account_name": account, "account_key": key}

    return {"use_azure_cli": "true"} if os.environ.get("AZURE_USE_AZURE_CLI") == "true" else {}


# ── Legacy parquet cleanup ──────────────────────────────────────────────────


def remove_legacy_parquet(delta_path: str, storage_options: dict[str, str]) -> Optional[str]:
    """
    On the first Delta commit at a path that previously held the legacy
    `data.parquet` writer's output, remove that one orphan. Best-effort and
    deliberately narrow: only that exact filename, never a Delta data file.
    """
    LEGACY_FILENAME = "data.parquet"

    if not delta_path.startswith("az://"):
        try:
            from pathlib import Path
            target = Path(delta_path) / LEGACY_FILENAME
            if target.is_file():
                target.unlink()
                return f"removed legacy {target}"
            return None
        except Exception as e:
            sys.stderr.write(f"[sidecar] local cleanup error: {e}\n")
            return None

    try:
        from urllib.parse import urlparse
        u = urlparse(delta_path)
        container = u.netloc
        prefix = u.path.lstrip("/").rstrip("/")
        legacy_blob = f"{prefix}/{LEGACY_FILENAME}" if prefix else LEGACY_FILENAME
        full_path = f"{container}/{legacy_blob}"

        account_name = storage_options.get("account_name")
        if not account_name:
            sys.stderr.write("[sidecar] Azure cleanup skipped: no account_name in storage_options\n")
            return None

        import pyarrow.fs as pafs
        fs_kwargs: dict[str, object] = {"account_name": account_name}
        if "account_key" in storage_options:
            fs_kwargs["account_key"] = storage_options["account_key"]
        if "sas_token" in storage_options:
            fs_kwargs["sas_token"] = storage_options["sas_token"]
        fs = pafs.AzureFileSystem(**fs_kwargs)  # type: ignore[arg-type]

        info = fs.get_file_info(full_path)
        if info.type == pafs.FileType.File:
            fs.delete_file(full_path)
            return f"removed legacy az://{full_path}"
        return None
    except Exception as e:
        sys.stderr.write(f"[sidecar] Azure cleanup skipped: {type(e).__name__}: {e}\n")
        return None


# ── Schema coercion ─────────────────────────────────────────────────────────


def coerced_field(field: pa.Field) -> pa.Field:
    """
    The Delta-safe type for one Arrow field.

      • Arrow `null` (a column that is all-NULL in this refresh — DuckDB
        writes these often: a dim whose `parent_id` is never set) → STRING,
        every cell stays NULL. Delta refuses the null type outright.
      • 16-byte fixed-size binary (DuckDB's parquet UUID) → STRING in
        UUID-hex form. Delta would downcast it to plain binary, DuckDB's
        delta_scan would then read BLOB, and joins to UUID-typed source
        columns would fail at runtime.
    """
    if pa.types.is_null(field.type):
        return pa.field(field.name, pa.string(), nullable=True)
    if pa.types.is_fixed_size_binary(field.type) and field.type.byte_width == 16:
        return pa.field(field.name, pa.string(), nullable=True)
    return field


def coerced_schema(schema: pa.Schema) -> pa.Schema:
    return pa.schema([coerced_field(f) for f in schema], metadata=schema.metadata)


def _bytes_to_uuid_str(b: Optional[bytes]) -> Optional[str]:
    if b is None:
        return None
    import uuid as _uuid
    try:
        return str(_uuid.UUID(bytes=bytes(b)))
    except Exception:
        return bytes(b).hex()


def coerce_table(table: pa.Table) -> pa.Table:
    """Apply `coerced_field` to every column of a table (or batch-as-table)."""
    target = coerced_schema(table.schema)
    if target.equals(table.schema):
        return table
    columns: list[pa.ChunkedArray] = []
    for i, field in enumerate(table.schema):
        col = table.column(i)
        if pa.types.is_fixed_size_binary(field.type) and field.type.byte_width == 16:
            columns.append(pa.chunked_array([pa.array([_bytes_to_uuid_str(v) for v in col.to_pylist()], type=pa.string())]))
        elif pa.types.is_null(field.type):
            columns.append(col.cast(pa.string()))
        else:
            columns.append(col)
    return pa.Table.from_arrays(columns, schema=target)


# Backwards-compatible names the tests and any caller may still use.
def coerce_null_columns_to_string(table: pa.Table) -> pa.Table:
    return coerce_table(table)


def coerce_uuid_columns_to_string(table: pa.Table) -> pa.Table:
    return coerce_table(table)


# ── Streaming the new state ─────────────────────────────────────────────────


def new_state_reader(parquet_path: str, business_columns: list[str]) -> pa.RecordBatchReader:
    """
    The new state as a RecordBatchReader: one parquet row group at a time,
    coerced on the way through, `_row_hash` computed here only when Node
    did not already supply it. Nothing beyond one row group is ever held.
    """
    pf = pq.ParquetFile(parquet_path, pre_buffer=False)
    has_hash = ROW_HASH_COL in pf.schema_arrow.names
    schema = coerced_schema(pf.schema_arrow)
    if not has_hash:
        schema = schema.append(pa.field(ROW_HASH_COL, pa.string()))

    def batches() -> Iterator[pa.RecordBatch]:
        # One row group at a time, split into small batches: pyarrow's
        # `iter_batches` read-ahead is what made the reader alone cost
        # ~550 MB on the PoC table; this shape costs ~140 MB.
        for i in range(pf.num_row_groups):
            group = coerce_table(pf.read_row_group(i, use_threads=False))
            if not has_hash:
                group = group.append_column(ROW_HASH_COL, pa.chunked_array([
                    hash_batch(b, business_columns) for b in group.to_batches()
                ]) if group.num_rows > 0 else pa.array([], pa.string()))
            for b in group.to_batches(max_chunksize=READ_BATCH):
                yield b

    return pa.RecordBatchReader.from_batches(schema, batches())


def writer_properties() -> Any:
    """
    Small write batches and row groups keep delta-rs' own buffering small:
    measured on the 3M-row PoC table, the streaming overwrite peaks at
    ~300 MB with these against ~1.4 GB with the defaults.
    """
    from deltalake import WriterProperties
    return WriterProperties(write_batch_size=WRITE_BATCH, max_row_group_size=WRITE_ROW_GROUP)


def parquet_row_count(parquet_path: str) -> int:
    return int(pq.ParquetFile(parquet_path).metadata.num_rows)


# ── Counts ──────────────────────────────────────────────────────────────────


def all_inserted(n: int) -> dict[str, int]:
    return {"rows_unchanged": 0, "rows_updated": 0, "rows_inserted": int(n), "rows_deleted": 0, "rows_total": int(n)}


def rows_in_table(dt: Any) -> int:
    """Row count from the add actions' statistics — metadata, no scan."""
    try:
        # delta-rs 1.x hands back an arro3 table; `pa.table()` takes it over
        # the Arrow C interface.
        adds = pa.table(dt.get_add_actions(flatten=True))
        if "num_records" not in adds.schema.names:
            return -1
        total = pc.sum(adds.column("num_records")).as_py()
        return int(total or 0)
    except Exception:
        return -1


def run_scd1(cfg: dict[str, Any]) -> dict[str, Any]:
    from deltalake import DeltaTable, write_deltalake

    delta_path: str = cfg["delta_path"]
    new_state_parquet: str = cfg["new_state_parquet"]
    business_columns: list[str] = list(cfg.get("business_columns") or [])
    allow_empty: bool = bool(cfg.get("allow_empty", False))
    target_file_size: int = int(cfg.get("target_file_size") or DEFAULT_TARGET_FILE_SIZE)
    storage_options = cfg.get("storage_options") or derive_storage_options(delta_path)
    table_config = {"delta.targetFileSize": str(target_file_size)}

    n_new = parquet_row_count(new_state_parquet)
    new_schema = new_state_reader(new_state_parquet, business_columns).schema

    dt: Optional[Any]
    try:
        dt = DeltaTable(delta_path, storage_options=storage_options)
    except Exception:
        # PathNotFound / TableNotFoundError depending on the version — a
        # first run; the write below initialises the table.
        dt = None
    first_run = dt is None
    rows_before = rows_in_table(dt) if dt is not None else 0

    result: dict[str, Any] = {"status": "ok", "first_run": first_run}
    preserved_existing = False
    write_mode = "overwrite"

    # ── zero rows ──
    if n_new == 0:
        if first_run:
            DeltaTable.create(delta_path, schema=new_schema, mode="ignore",
                              configuration=table_config, storage_options=storage_options)
            counts = all_inserted(0)
        elif rows_before != 0 and not allow_empty:
            # PRESERVE. Anything that makes the transformation return
            # nothing for one run must not empty the topic (2026-09-09).
            # `rows_before` is -1 when the stats are unreadable: still
            # preserve — "unknown" is not "empty".
            counts = {"rows_unchanged": max(rows_before, 0), "rows_updated": 0, "rows_inserted": 0,
                      "rows_deleted": 0, "rows_total": max(rows_before, 0)}
            preserved_existing = True
            write_mode = "preserved"
        else:
            dt.delete()  # type: ignore[union-attr]
            counts = {"rows_unchanged": 0, "rows_updated": 0, "rows_inserted": 0,
                      "rows_deleted": max(rows_before, 0), "rows_total": 0}
            write_mode = "emptied"

    # ── first run ──
    elif first_run:
        write_deltalake(delta_path, new_state_reader(new_state_parquet, business_columns),
                        mode="overwrite", schema_mode="merge", target_file_size=target_file_size,
                        writer_properties=writer_properties(), configuration=table_config,
                        storage_options=storage_options)
        counts = all_inserted(n_new)

    # ── refresh: streaming overwrite ──
    else:
        supplied = cfg.get("counts")
        counts = dict(supplied) if isinstance(supplied, dict) and all(
            k in supplied for k in ("rows_unchanged", "rows_updated", "rows_inserted", "rows_deleted", "rows_total")
        ) else all_inserted(n_new)
        write_deltalake(delta_path, new_state_reader(new_state_parquet, business_columns),
                        mode="overwrite", schema_mode="merge", target_file_size=target_file_size,
                        writer_properties=writer_properties(), storage_options=storage_options)
        write_mode = "overwrite"
        result["counts_measured"] = supplied is not None

    cleanup_msg: Optional[str] = None
    if first_run:
        cleanup_msg = remove_legacy_parquet(delta_path, storage_options)

    result.update(counts)
    result["write_mode"] = write_mode
    if preserved_existing:
        result["preserved_existing"] = True
    if cleanup_msg:
        result["legacy_cleanup"] = cleanup_msg
    return result


def run_maintain(cfg: dict[str, Any]) -> dict[str, Any]:
    """
    OPTIMIZE (compact small files) + VACUUM (drop files no snapshot within
    the retention window references) for each listed Delta path. A path
    that is not a Delta table is reported `skipped`, never an error — the
    caller enumerates by catalog row and a legacy parquet directory is a
    legitimate thing to find there.
    """
    from deltalake import DeltaTable

    target_file_size: int = int(cfg.get("target_file_size") or DEFAULT_TARGET_FILE_SIZE)
    retention_hours: int = int(cfg.get("retention_hours") if cfg.get("retention_hours") is not None else DEFAULT_VACUUM_RETENTION_HOURS)
    results: list[dict[str, Any]] = []
    for delta_path in cfg.get("delta_paths") or []:
        entry: dict[str, Any] = {"delta_path": delta_path}
        storage_options = cfg.get("storage_options") or derive_storage_options(delta_path)
        try:
            dt = DeltaTable(delta_path, storage_options=storage_options)
        except Exception as e:
            entry["skipped"] = f"not a Delta table ({type(e).__name__})"
            results.append(entry)
            continue
        try:
            entry["files_before"] = len(dt.file_uris())
            c = dt.optimize.compact(target_size=target_file_size)
            entry["compact"] = {k: c.get(k) for k in ("numFilesAdded", "numFilesRemoved", "totalConsideredFiles") if k in c}
            removed = dt.vacuum(retention_hours=retention_hours, dry_run=False, enforce_retention_duration=True)
            entry["vacuum_files_removed"] = len(removed)
            entry["files_after"] = len(DeltaTable(delta_path, storage_options=storage_options).file_uris())
        except Exception as e:
            entry["error"] = f"{type(e).__name__}: {str(e)[:300]}"
        results.append(entry)
    return {"status": "ok", "results": results}


# ── Main ────────────────────────────────────────────────────────────────────


def main() -> int:
    try:
        cfg = json.loads(sys.stdin.read())
    except Exception as e:
        sys.stderr.write(f"[sidecar] failed to parse config: {e}\n")
        return 2

    mode: str = cfg.get("mode", "scd1")
    try:
        if mode == "scd1":
            result = run_scd1(cfg)
        elif mode == "maintain":
            result = run_maintain(cfg)
        else:
            result = {"status": "failed", "error": f"unsupported mode '{mode}' — only 'scd1' and 'maintain' are implemented"}
    except Exception as e:
        result = {"status": "failed", "error": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
