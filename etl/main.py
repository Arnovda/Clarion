"""
DataBridge ETL Service — FastAPI
Reads source databases (SQLite for now), writes Delta Lake tables.
"""

import os
import sqlite3
import traceback
from pathlib import Path
from typing import Optional

import pandas as pd
import pyarrow as pa
from deltalake import DeltaTable, write_deltalake
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="DataBridge ETL", version="0.1.0")

# Warehouse root — shared volume with Node.js backend
WAREHOUSE_ROOT = os.environ.get("WAREHOUSE_ROOT", "/warehouse")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class DiscoverRequest(BaseModel):
    source_type: str  # 'sqlite'
    config: dict      # { "filepath": "/sources/sample.db" }


class TableIngestSpec(BaseModel):
    table_name: str
    load_mode: str = "full"                   # 'full' | 'incremental'
    watermark_column: Optional[str] = None    # e.g. 'updated_at', 'id'
    watermark_value: Optional[str] = None     # last loaded value


class IngestRequest(BaseModel):
    source_type: str
    config: dict
    connection_id: int
    tables: list[str]  # which tables to ingest (backward compat)
    table_specs: Optional[list[TableIngestSpec]] = None  # detailed specs with watermark info


class TableDiscovery(BaseModel):
    table_name: str
    row_count: int
    column_count: int


class DiscoverResponse(BaseModel):
    ok: bool
    tables: list[TableDiscovery]


class IngestTableResult(BaseModel):
    table_name: str
    status: str  # 'done' | 'error'
    row_count: Optional[int] = None
    file_size_bytes: Optional[int] = None
    delta_path: Optional[str] = None
    error: Optional[str] = None
    new_watermark: Optional[str] = None  # updated watermark value after incremental load


class IngestResponse(BaseModel):
    ok: bool
    warehouse_path: str
    results: list[IngestTableResult]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_sqlite_conn(config: dict) -> sqlite3.Connection:
    filepath = config.get("filepath")
    if not filepath:
        raise HTTPException(status_code=400, detail="config.filepath is required")
    if not Path(filepath).exists():
        raise HTTPException(status_code=400, detail=f"File not found: {filepath}")
    return sqlite3.connect(filepath)


def _delta_path_for_table(connection_id: int, table_name: str) -> str:
    """Returns the on-disk path for a Delta table."""
    return os.path.join(WAREHOUSE_ROOT, f"conn_{connection_id}", table_name)


def _get_delta_dir_size(delta_path: str) -> int:
    """Total size in bytes of all files under the delta directory."""
    total = 0
    for dirpath, _dirnames, filenames in os.walk(delta_path):
        for f in filenames:
            total += os.path.getsize(os.path.join(dirpath, f))
    return total


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True, "service": "etl"}


@app.post("/discover", response_model=DiscoverResponse)
def discover_tables(req: DiscoverRequest):
    """List all tables in the source with row counts."""
    if req.source_type != "sqlite":
        raise HTTPException(status_code=400, detail=f"Unsupported source type: {req.source_type}")

    conn = _get_sqlite_conn(req.config)
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
        table_names = [row[0] for row in cursor.fetchall()]

        tables = []
        for tn in sorted(table_names):
            row_count = cursor.execute(f'SELECT COUNT(*) FROM "{tn}"').fetchone()[0]
            col_count = len(cursor.execute(f'PRAGMA table_info("{tn}")').fetchall())
            tables.append(TableDiscovery(
                table_name=tn,
                row_count=row_count,
                column_count=col_count,
            ))
        return DiscoverResponse(ok=True, tables=tables)
    finally:
        conn.close()


@app.post("/ingest", response_model=IngestResponse)
def ingest_tables(req: IngestRequest):
    """Read selected tables from source, write as Delta Lake tables."""
    if req.source_type != "sqlite":
        raise HTTPException(status_code=400, detail=f"Unsupported source type: {req.source_type}")

    conn = _get_sqlite_conn(req.config)
    warehouse_path = os.path.join(WAREHOUSE_ROOT, f"conn_{req.connection_id}")
    os.makedirs(warehouse_path, exist_ok=True)

    results: list[IngestTableResult] = []

    # Build a spec map for incremental support
    spec_map: dict[str, TableIngestSpec] = {}
    if req.table_specs:
        for spec in req.table_specs:
            spec_map[spec.table_name] = spec

    try:
        for table_name in req.tables:
            try:
                spec = spec_map.get(table_name)
                is_incremental = (
                    spec is not None
                    and spec.load_mode == "incremental"
                    and spec.watermark_column
                    and spec.watermark_value is not None
                )

                # Build the query — add WHERE clause for incremental
                if is_incremental:
                    query = (
                        f'SELECT * FROM "{table_name}" '
                        f'WHERE "{spec.watermark_column}" > ?'
                    )
                    df = pd.read_sql_query(query, conn, params=[spec.watermark_value])
                else:
                    df = pd.read_sql_query(f'SELECT * FROM "{table_name}"', conn)

                row_count = len(df)

                # If incremental returned 0 new rows, skip write but still report success
                if is_incremental and row_count == 0:
                    delta_path = _delta_path_for_table(req.connection_id, table_name)
                    results.append(IngestTableResult(
                        table_name=table_name,
                        status="done",
                        row_count=0,
                        file_size_bytes=_get_delta_dir_size(delta_path) if os.path.isdir(delta_path) else 0,
                        delta_path=delta_path,
                    ))
                    continue

                # Fix null-only columns: Delta Lake can't handle pa.null() type.
                for col in df.columns:
                    if df[col].isna().all():
                        df[col] = df[col].astype("str")

                delta_path = _delta_path_for_table(req.connection_id, table_name)
                os.makedirs(delta_path, exist_ok=True)

                # Convert to PyArrow table for Delta write.
                arrow_table = pa.Table.from_pandas(df, preserve_index=False)
                new_fields = []
                for field in arrow_table.schema:
                    if pa.types.is_null(field.type):
                        new_fields.append(field.with_type(pa.string()))
                    else:
                        new_fields.append(field)
                if any(pa.types.is_null(f.type) for f in arrow_table.schema):
                    new_schema = pa.schema(new_fields)
                    arrow_table = arrow_table.cast(new_schema)

                if is_incremental and os.path.exists(os.path.join(delta_path, "_delta_log")):
                    # Append new rows to existing Delta table
                    write_deltalake(
                        delta_path,
                        arrow_table,
                        mode="append",
                    )
                    # Get total row count from the Delta table after append
                    dt = DeltaTable(delta_path)
                    row_count = len(dt.to_pandas())
                else:
                    # Full overwrite
                    write_deltalake(
                        delta_path,
                        arrow_table,
                        mode="overwrite",
                        schema_mode="overwrite",
                    )

                # Compute new watermark value if watermark column is specified
                new_watermark = None
                if spec and spec.watermark_column and spec.watermark_column in df.columns and len(df) > 0:
                    new_watermark = str(df[spec.watermark_column].max())

                file_size = _get_delta_dir_size(delta_path)

                results.append(IngestTableResult(
                    table_name=table_name,
                    status="done",
                    row_count=row_count,
                    file_size_bytes=file_size,
                    delta_path=delta_path,
                    new_watermark=new_watermark,
                ))

            except Exception as e:
                traceback.print_exc()
                results.append(IngestTableResult(
                    table_name=table_name,
                    status="error",
                    error=str(e),
                ))
    finally:
        conn.close()

    return IngestResponse(
        ok=True,
        warehouse_path=warehouse_path,
        results=results,
    )


@app.get("/tables/{connection_id}")
def list_ingested_tables(connection_id: int):
    """List Delta tables that exist on disk for a connection."""
    warehouse_path = os.path.join(WAREHOUSE_ROOT, f"conn_{connection_id}")
    if not os.path.isdir(warehouse_path):
        return {"ok": True, "tables": []}

    tables = []
    for entry in sorted(os.listdir(warehouse_path)):
        delta_path = os.path.join(warehouse_path, entry)
        if os.path.isdir(delta_path) and os.path.exists(os.path.join(delta_path, "_delta_log")):
            try:
                dt = DeltaTable(delta_path)
                metadata = dt.metadata()
                tables.append({
                    "table_name": entry,
                    "delta_path": delta_path,
                    "num_files": len(dt.files()),
                    "version": dt.version(),
                    "description": metadata.description,
                })
            except Exception:
                tables.append({
                    "table_name": entry,
                    "delta_path": delta_path,
                    "error": "Could not read Delta metadata",
                })

    return {"ok": True, "tables": tables}
