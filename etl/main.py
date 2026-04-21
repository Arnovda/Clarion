"""
DataBridge ETL Service — FastAPI
Reads source databases (SQLite, PostgreSQL, MySQL, SQL Server), writes Delta Lake tables.
Supports both local filesystem and Azure Blob Storage for multi-tenant production.
"""

import os
import re
import sqlite3
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional
from contextlib import contextmanager

import pandas as pd
import pyarrow as pa
from deltalake import DeltaTable, write_deltalake
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="DataBridge ETL", version="0.3.0")

# Warehouse config
WAREHOUSE_ROOT = os.environ.get("WAREHOUSE_ROOT", "/warehouse")
AZURE_CONN_STR = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
AZURE_CONTAINER = os.environ.get("AZURE_STORAGE_CONTAINER", "warehouse")

# Detect blob mode: if Azure connection string is set and we're not in local dev
USE_BLOB = bool(AZURE_CONN_STR) and os.environ.get("STORAGE_MODE", "auto") != "local"

SUPPORTED_TYPES = {"sqlite", "postgres", "postgresql", "mysql", "sqlserver", "mssql"}


def _parse_azure_conn_str(conn_str: str) -> dict:
    """Parse Azure Storage connection string into account_name + account_key."""
    parts = dict(part.split("=", 1) for part in conn_str.split(";") if "=" in part)
    return {
        "account_name": parts.get("AccountName", ""),
        "account_key": parts.get("AccountKey", ""),
    }


def _azure_storage_options() -> dict:
    """Return storage_options dict for deltalake Azure operations."""
    return _parse_azure_conn_str(AZURE_CONN_STR)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class DiscoverRequest(BaseModel):
    source_type: str
    config: dict

class TableIngestSpec(BaseModel):
    table_name: str
    load_mode: str = "full"
    watermark_column: Optional[str] = None
    watermark_value: Optional[str] = None

class IngestRequest(BaseModel):
    source_type: str
    config: dict
    connection_id: int
    tenant_id: Optional[int] = None
    tables: list[str]
    table_specs: Optional[list[TableIngestSpec]] = None

class TableDiscovery(BaseModel):
    table_name: str
    row_count: int
    column_count: int

class DiscoverResponse(BaseModel):
    ok: bool
    tables: list[TableDiscovery]

class IngestTableResult(BaseModel):
    table_name: str
    status: str
    row_count: Optional[int] = None
    file_size_bytes: Optional[int] = None
    delta_path: Optional[str] = None
    error: Optional[str] = None
    new_watermark: Optional[str] = None

class IngestResponse(BaseModel):
    ok: bool
    warehouse_path: str
    results: list[IngestTableResult]


# ---------------------------------------------------------------------------
# Source connection helpers
# ---------------------------------------------------------------------------

def _validate_source_type(source_type: str):
    if source_type not in SUPPORTED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported source type: {source_type}. Supported: {', '.join(sorted(SUPPORTED_TYPES))}"
        )

def _get_sqlite_conn(config: dict) -> sqlite3.Connection:
    filepath = config.get("filepath")
    if not filepath:
        raise HTTPException(status_code=400, detail="config.filepath is required for sqlite")
    if not Path(filepath).exists():
        raise HTTPException(status_code=400, detail=f"File not found: {filepath}")
    return sqlite3.connect(filepath)

def _get_pg_conn(config: dict):
    import psycopg2
    host = config.get("host", "localhost")
    port = int(config.get("port", 5432))
    database = config.get("database")
    user = config.get("user")
    password = config.get("password")
    ssl = config.get("ssl", False)
    if not database:
        raise HTTPException(status_code=400, detail="config.database is required for postgres")
    kwargs = dict(host=host, port=port, dbname=database, user=user, password=password)
    if ssl:
        kwargs["sslmode"] = "require"
    return psycopg2.connect(**kwargs)

def _get_mysql_conn(config: dict):
    import pymysql
    host = config.get("host", "localhost")
    port = int(config.get("port", 3306))
    database = config.get("database")
    user = config.get("user")
    password = config.get("password")
    ssl = config.get("ssl", False)
    if not database:
        raise HTTPException(status_code=400, detail="config.database is required for mysql")
    kwargs = dict(host=host, port=port, database=database, user=user, password=password)
    if ssl:
        kwargs["ssl"] = {"ssl": True}
    return pymysql.connect(**kwargs)

def _get_mssql_conn(config: dict):
    import pyodbc
    host = config.get("host", "localhost")
    port = int(config.get("port", 1433))
    database = config.get("database")
    user = config.get("user")
    password = config.get("password")
    encrypt = config.get("encrypt", False)
    trust_cert = config.get("trustServerCertificate", False)
    if not database:
        raise HTTPException(status_code=400, detail="config.database is required for sqlserver")
    driver = "ODBC Driver 18 for SQL Server"
    conn_str = (
        f"DRIVER={{{driver}}};"
        f"SERVER={host},{port};"
        f"DATABASE={database};"
        f"UID={user};"
        f"PWD={password};"
    )
    if encrypt:
        conn_str += "Encrypt=yes;"
    if trust_cert:
        conn_str += "TrustServerCertificate=yes;"
    return pyodbc.connect(conn_str)


@contextmanager
def get_source_connection(source_type: str, config: dict):
    _validate_source_type(source_type)
    if source_type == "sqlite":
        conn = _get_sqlite_conn(config)
    elif source_type in ("postgres", "postgresql"):
        conn = _get_pg_conn(config)
    elif source_type == "mysql":
        conn = _get_mysql_conn(config)
    elif source_type in ("sqlserver", "mssql"):
        conn = _get_mssql_conn(config)
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported source type: {source_type}")
    try:
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Discovery helpers per source type
# ---------------------------------------------------------------------------

def _discover_sqlite(conn) -> list[TableDiscovery]:
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    table_names = [row[0] for row in cursor.fetchall()]
    tables = []
    for tn in sorted(table_names):
        row_count = cursor.execute(f'SELECT COUNT(*) FROM "{tn}"').fetchone()[0]
        col_count = len(cursor.execute(f'PRAGMA table_info("{tn}")').fetchall())
        tables.append(TableDiscovery(table_name=tn, row_count=row_count, column_count=col_count))
    return tables

def _discover_postgres(conn, config: dict) -> list[TableDiscovery]:
    schema = config.get("schema", "public")
    cursor = conn.cursor()
    cursor.execute("""
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = %s AND table_type = 'BASE TABLE'
        ORDER BY table_name
    """, (schema,))
    table_names = [row[0] for row in cursor.fetchall()]
    tables = []
    for tn in table_names:
        cursor.execute(f'SELECT COUNT(*) FROM "{schema}"."{tn}"')
        row_count = cursor.fetchone()[0]
        cursor.execute("""
            SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
        """, (schema, tn))
        col_count = cursor.fetchone()[0]
        tables.append(TableDiscovery(table_name=tn, row_count=row_count, column_count=col_count))
    return tables

def _discover_mysql(conn, config: dict) -> list[TableDiscovery]:
    database = config.get("database")
    cursor = conn.cursor()
    cursor.execute("""
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = %s AND table_type = 'BASE TABLE'
        ORDER BY table_name
    """, (database,))
    table_names = [row[0] for row in cursor.fetchall()]
    tables = []
    for tn in table_names:
        cursor.execute(f"SELECT COUNT(*) FROM `{tn}`")
        row_count = cursor.fetchone()[0]
        cursor.execute("""
            SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
        """, (database, tn))
        col_count = cursor.fetchone()[0]
        tables.append(TableDiscovery(table_name=tn, row_count=row_count, column_count=col_count))
    return tables

def _discover_mssql(conn, config: dict) -> list[TableDiscovery]:
    schema = config.get("schema", "dbo")
    cursor = conn.cursor()
    cursor.execute("""
        SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME
    """, (schema,))
    table_names = [row[0] for row in cursor.fetchall()]
    tables = []
    for tn in table_names:
        cursor.execute(f'SELECT COUNT(*) FROM [{schema}].[{tn}]')
        row_count = cursor.fetchone()[0]
        cursor.execute("""
            SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        """, (schema, tn))
        col_count = cursor.fetchone()[0]
        tables.append(TableDiscovery(table_name=tn, row_count=row_count, column_count=col_count))
    return tables


# ---------------------------------------------------------------------------
# Ingest helpers
# ---------------------------------------------------------------------------

def _quote_table(source_type: str, table_name: str, config: dict) -> str:
    if source_type == "sqlite":
        return f'"{table_name}"'
    elif source_type in ("postgres", "postgresql"):
        schema = config.get("schema", "public")
        return f'"{schema}"."{table_name}"'
    elif source_type == "mysql":
        return f"`{table_name}`"
    elif source_type in ("sqlserver", "mssql"):
        schema = config.get("schema", "dbo")
        return f"[{schema}].[{table_name}]"
    return f'"{table_name}"'

def _quote_column(source_type: str, column_name: str) -> str:
    if source_type == "mysql":
        return f"`{column_name}`"
    elif source_type in ("sqlserver", "mssql"):
        return f"[{column_name}]"
    return f'"{column_name}"'

def _param_placeholder(source_type: str) -> str:
    if source_type in ("postgres", "postgresql"):
        return "%s"
    elif source_type == "mysql":
        return "%s"
    elif source_type in ("sqlserver", "mssql"):
        return "?"
    return "?"

def _read_table(conn, source_type: str, config: dict, table_name: str,
                watermark_column: str = None, watermark_value: str = None) -> pd.DataFrame:
    table_ref = _quote_table(source_type, table_name, config)
    col_quote = _quote_column(source_type, watermark_column) if watermark_column else None
    placeholder = _param_placeholder(source_type)
    if watermark_column and watermark_value is not None:
        query = f"SELECT * FROM {table_ref} WHERE {col_quote} > {placeholder}"
        return pd.read_sql_query(query, conn, params=[watermark_value])
    else:
        return pd.read_sql_query(f"SELECT * FROM {table_ref}", conn)


# ---------------------------------------------------------------------------
# Delta Lake path + write helpers (local or Azure Blob)
# ---------------------------------------------------------------------------

def _delta_path_for_table(tenant_id: Optional[int], connection_id: int, table_name: str) -> str:
    """Return the Delta table path — local or az:// blob URI."""
    if USE_BLOB:
        tenant_prefix = f"tenant_{tenant_id}" if tenant_id else "tenant_0"
        return f"az://{AZURE_CONTAINER}/{tenant_prefix}/conn_{connection_id}/{table_name}"
    return os.path.join(WAREHOUSE_ROOT, f"conn_{connection_id}", table_name)


def _warehouse_path(tenant_id: Optional[int], connection_id: int) -> str:
    """Return the warehouse base path for a connection."""
    if USE_BLOB:
        tenant_prefix = f"tenant_{tenant_id}" if tenant_id else "tenant_0"
        return f"az://{AZURE_CONTAINER}/{tenant_prefix}/conn_{connection_id}"
    return os.path.join(WAREHOUSE_ROOT, f"conn_{connection_id}")


def _is_existing_delta(delta_path: str) -> bool:
    """Check whether a Delta table already exists at the given path."""
    if USE_BLOB:
        try:
            DeltaTable(delta_path, storage_options=_azure_storage_options())
            return True
        except Exception:
            return False
    return os.path.exists(os.path.join(delta_path, "_delta_log"))


def _get_delta_dir_size(delta_path: str) -> int:
    """Total size in bytes of all files under the delta directory."""
    if USE_BLOB:
        try:
            dt = DeltaTable(delta_path, storage_options=_azure_storage_options())
            # Approximate from file metadata
            return sum(f.size for f in dt.get_add_actions().to_pandas().itertuples() if hasattr(f, 'size'))
        except Exception:
            return 0
    total = 0
    for dirpath, _dirnames, filenames in os.walk(delta_path):
        for f in filenames:
            total += os.path.getsize(os.path.join(dirpath, f))
    return total


def _write_delta(df: pd.DataFrame, delta_path: str, is_incremental: bool) -> int:
    """Write a DataFrame to Delta Lake (local or Azure Blob). Returns row count."""
    row_count = len(df)

    # Fix null-only columns
    for col in df.columns:
        if df[col].isna().all():
            df[col] = df[col].astype("str")

    # Local mode: ensure directory exists
    if not USE_BLOB:
        os.makedirs(delta_path, exist_ok=True)

    arrow_table = pa.Table.from_pandas(df, preserve_index=False)

    # Fix null types in Arrow schema
    new_fields = []
    for field in arrow_table.schema:
        if pa.types.is_null(field.type):
            new_fields.append(field.with_type(pa.string()))
        else:
            new_fields.append(field)
    if any(pa.types.is_null(f.type) for f in arrow_table.schema):
        new_schema = pa.schema(new_fields)
        arrow_table = arrow_table.cast(new_schema)

    storage_opts = _azure_storage_options() if USE_BLOB else None

    if is_incremental and _is_existing_delta(delta_path):
        # schema_mode="merge" lets the Delta write add new columns from the
        # source without a manual overwrite. Existing columns keep their type.
        write_deltalake(delta_path, arrow_table, mode="append",
                        schema_mode="merge",
                        storage_options=storage_opts)
        dt = DeltaTable(delta_path, storage_options=storage_opts)
        row_count = len(dt.to_pandas())
    else:
        write_deltalake(delta_path, arrow_table, mode="overwrite",
                        schema_mode="overwrite", storage_options=storage_opts)

    return row_count


# ---------------------------------------------------------------------------
# Delta hygiene — compaction + vacuum
# ---------------------------------------------------------------------------

def _optimize_and_vacuum(delta_path: str, retention_hours: int = 168) -> Dict[str, Any]:
    """Compact small files via Delta's OPTIMIZE and purge old versions via VACUUM.

    retention_hours: Delta default is 168h (7d). VACUUM errors if you ask for
    less than the configured retention unless you enforce override — we stay
    at the safe default.
    """
    storage_opts = _azure_storage_options() if USE_BLOB else None
    dt = DeltaTable(delta_path, storage_options=storage_opts)

    compact_result: Dict[str, Any] = {}
    try:
        compact_result = dt.optimize.compact()
    except Exception as e:  # noqa: BLE001 — surface as data, not failure
        compact_result = {"error": str(e)}

    try:
        # `dry_run=False` is required to actually delete old Parquet files.
        vacuum_result = dt.vacuum(retention_hours=retention_hours, dry_run=False,
                                  enforce_retention_duration=True)
    except Exception as e:  # noqa: BLE001
        vacuum_result = {"error": str(e)}

    return {
        "delta_path": delta_path,
        "compact": compact_result,
        "vacuum_files_removed": (
            len(vacuum_result) if isinstance(vacuum_result, list) else vacuum_result
        ),
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True, "service": "etl", "storage": "blob" if USE_BLOB else "local"}


@app.post("/discover", response_model=DiscoverResponse)
def discover_tables(req: DiscoverRequest):
    """List all tables in the source with row counts."""
    import sys
    print(f"[discover] source_type={req.source_type}, config keys={list(req.config.keys())}", file=sys.stderr, flush=True)
    _validate_source_type(req.source_type)

    with get_source_connection(req.source_type, req.config) as conn:
        if req.source_type == "sqlite":
            tables = _discover_sqlite(conn)
        elif req.source_type in ("postgres", "postgresql"):
            tables = _discover_postgres(conn, req.config)
        elif req.source_type == "mysql":
            tables = _discover_mysql(conn, req.config)
        elif req.source_type in ("sqlserver", "mssql"):
            tables = _discover_mssql(conn, req.config)
        else:
            tables = []

    print(f"[discover] found {len(tables)} tables", file=sys.stderr, flush=True)
    return DiscoverResponse(ok=True, tables=tables)


@app.post("/ingest", response_model=IngestResponse)
def ingest_tables(req: IngestRequest):
    """Read selected tables from source, write as Delta Lake tables."""
    import sys
    _validate_source_type(req.source_type)

    wh_path = _warehouse_path(req.tenant_id, req.connection_id)
    if not USE_BLOB:
        os.makedirs(wh_path, exist_ok=True)

    print(f"[ingest] tenant={req.tenant_id}, conn={req.connection_id}, tables={len(req.tables)}, storage={'blob' if USE_BLOB else 'local'}, wh={wh_path}", file=sys.stderr, flush=True)

    results: list[IngestTableResult] = []
    spec_map: dict[str, TableIngestSpec] = {}
    if req.table_specs:
        for spec in req.table_specs:
            spec_map[spec.table_name] = spec

    with get_source_connection(req.source_type, req.config) as conn:
        for table_name in req.tables:
            try:
                spec = spec_map.get(table_name)
                is_incremental = (
                    spec is not None
                    and spec.load_mode == "incremental"
                    and spec.watermark_column
                    and spec.watermark_value is not None
                )

                df = _read_table(
                    conn, req.source_type, req.config, table_name,
                    watermark_column=spec.watermark_column if is_incremental else None,
                    watermark_value=spec.watermark_value if is_incremental else None,
                )

                row_count = len(df)
                delta_path = _delta_path_for_table(req.tenant_id, req.connection_id, table_name)

                # Incremental with 0 new rows — skip write
                if is_incremental and row_count == 0:
                    results.append(IngestTableResult(
                        table_name=table_name, status="done", row_count=0,
                        file_size_bytes=_get_delta_dir_size(delta_path) if _is_existing_delta(delta_path) else 0,
                        delta_path=delta_path,
                    ))
                    continue

                row_count = _write_delta(df, delta_path, is_incremental)

                # Compute new watermark
                new_watermark = None
                if spec and spec.watermark_column and spec.watermark_column in df.columns and len(df) > 0:
                    new_watermark = str(df[spec.watermark_column].max())

                file_size = _get_delta_dir_size(delta_path)
                print(f"[ingest]   {table_name}: {row_count} rows, {file_size} bytes → {delta_path}", file=sys.stderr, flush=True)

                results.append(IngestTableResult(
                    table_name=table_name, status="done", row_count=row_count,
                    file_size_bytes=file_size, delta_path=delta_path,
                    new_watermark=new_watermark,
                ))

            except Exception as e:
                traceback.print_exc()
                results.append(IngestTableResult(
                    table_name=table_name, status="error", error=str(e),
                ))

    return IngestResponse(ok=True, warehouse_path=wh_path, results=results)


class DbtRunRequest(BaseModel):
    project_dir: str
    target: str = "dev"
    select: Optional[str] = None
    full_refresh: bool = False
    # Optional path to the DuckDB state file. When provided, /dbt/test
    # will fetch failure sample rows from dbt_test__audit tables.
    state_path: Optional[str] = None


@app.post("/dbt/run")
def dbt_run(req: DbtRunRequest):
    """Run `dbt run` against a dbt project already generated on disk.

    The backend `dbtProjectBuilder` writes the project to a shared warehouse
    path; both the backend and ETL containers mount the warehouse volume, so
    `req.project_dir` is reachable from here.
    """
    from dbt_runner import run_dbt_project
    return run_dbt_project(
        req.project_dir,
        target=req.target,
        select=req.select,
        full_refresh=req.full_refresh,
    )


@app.post("/dbt/test")
def dbt_test(req: DbtRunRequest):
    """Run `dbt test` (quality tests) against a dbt project on disk."""
    from dbt_runner import run_dbt_test
    return run_dbt_test(req.project_dir, target=req.target, state_path=req.state_path)


class OptimizeRequest(BaseModel):
    connection_id: int
    tenant_id: Optional[int] = None
    table_names: Optional[List[str]] = None
    retention_hours: int = 168  # Delta default: 7 days


@app.post("/optimize")
def optimize_warehouse(req: OptimizeRequest):
    """Run OPTIMIZE (file compaction) + VACUUM (remove old Parquet files past
    retention) on one connection's Delta tables.

    If `table_names` is omitted, operates on every Delta table in the warehouse.
    Returns a per-table report; the endpoint itself never fails the whole call
    if a single table errors — the per-table error is surfaced in the response.
    """
    wh_path = _warehouse_path(req.tenant_id, req.connection_id)

    if USE_BLOB:
        # In blob mode we need the explicit table list from the caller.
        if not req.table_names:
            raise HTTPException(
                status_code=400,
                detail="table_names required in blob/Azure mode",
            )
        targets = [f"{wh_path}/{t}" for t in req.table_names]
    else:
        if not os.path.isdir(wh_path):
            return {"ok": True, "results": [], "warehouse_path": wh_path}
        if req.table_names:
            targets = [os.path.join(wh_path, t) for t in req.table_names]
        else:
            targets = [
                os.path.join(wh_path, entry)
                for entry in sorted(os.listdir(wh_path))
                if os.path.isdir(os.path.join(wh_path, entry))
                and os.path.exists(os.path.join(wh_path, entry, "_delta_log"))
            ]

    results = []
    for tp in targets:
        try:
            results.append(_optimize_and_vacuum(tp, retention_hours=req.retention_hours))
        except Exception as e:  # noqa: BLE001
            results.append({"delta_path": tp, "error": str(e)})

    return {"ok": True, "results": results, "warehouse_path": wh_path}


@app.get("/tables/{connection_id}")
def list_ingested_tables(connection_id: int, tenant_id: int = 0):
    """List Delta tables that exist for a connection."""
    wh_path = _warehouse_path(tenant_id or None, connection_id)

    if USE_BLOB:
        # In blob mode, we can't list directories easily — return empty
        # The backend uses the ingested_tables DB table as source of truth
        return {"ok": True, "tables": [], "storage": "blob", "warehouse_path": wh_path}

    # Local mode: scan filesystem
    if not os.path.isdir(wh_path):
        return {"ok": True, "tables": []}

    tables = []
    for entry in sorted(os.listdir(wh_path)):
        delta_path = os.path.join(wh_path, entry)
        if os.path.isdir(delta_path) and os.path.exists(os.path.join(delta_path, "_delta_log")):
            try:
                dt = DeltaTable(delta_path)
                metadata = dt.metadata()
                tables.append({
                    "table_name": entry, "delta_path": delta_path,
                    "num_files": len(dt.files()), "version": dt.version(),
                    "description": metadata.description,
                })
            except Exception:
                tables.append({"table_name": entry, "delta_path": delta_path, "error": "Could not read Delta metadata"})

    return {"ok": True, "tables": tables}
