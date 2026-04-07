"""
DataBridge ETL Service — FastAPI
Reads source databases (SQLite, PostgreSQL, MySQL, SQL Server), writes Delta Lake tables.
"""

import os
import sqlite3
import traceback
from pathlib import Path
from typing import Optional
from contextlib import contextmanager

import pandas as pd
import pyarrow as pa
from deltalake import DeltaTable, write_deltalake
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="DataBridge ETL", version="0.2.0")

# Warehouse root — shared volume with Node.js backend
WAREHOUSE_ROOT = os.environ.get("WAREHOUSE_ROOT", "/warehouse")

SUPPORTED_TYPES = {"sqlite", "postgres", "postgresql", "mysql", "sqlserver", "mssql"}


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class DiscoverRequest(BaseModel):
    source_type: str
    config: dict

class TableIngestSpec(BaseModel):
    table_name: str
    load_mode: str = "full"                   # 'full' | 'incremental'
    watermark_column: Optional[str] = None
    watermark_value: Optional[str] = None

class IngestRequest(BaseModel):
    source_type: str
    config: dict
    connection_id: int
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
    status: str  # 'done' | 'error'
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
    """Create a psycopg2 connection to PostgreSQL."""
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
    """Create a pymysql connection to MySQL."""
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
    """Create a pyodbc connection to SQL Server."""
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

    # Try available ODBC drivers
    driver = None
    for d in ["ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server", "FreeTDS"]:
        try:
            pyodbc.connect(f"DRIVER={{{d}}};SERVER=test;", timeout=1)
        except Exception:
            pass
        driver = d
        break

    if not driver:
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
    """Context manager that yields a DB-API connection for any supported source type."""
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
        SELECT table_name
        FROM information_schema.tables
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
        SELECT table_name
        FROM information_schema.tables
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
        SELECT TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
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
# Ingest helpers — read a table into a DataFrame
# ---------------------------------------------------------------------------

def _quote_table(source_type: str, table_name: str, config: dict) -> str:
    """Return a properly quoted table reference for SQL queries."""
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
    """Return the parameter placeholder for the DB driver."""
    if source_type in ("postgres", "postgresql"):
        return "%s"
    elif source_type == "mysql":
        return "%s"
    elif source_type in ("sqlserver", "mssql"):
        return "?"
    return "?"  # sqlite


def _read_table(conn, source_type: str, config: dict, table_name: str,
                watermark_column: str = None, watermark_value: str = None) -> pd.DataFrame:
    """Read a full or incremental table into a Pandas DataFrame."""
    table_ref = _quote_table(source_type, table_name, config)
    col_quote = _quote_column(source_type, watermark_column) if watermark_column else None
    placeholder = _param_placeholder(source_type)

    if watermark_column and watermark_value is not None:
        query = f"SELECT * FROM {table_ref} WHERE {col_quote} > {placeholder}"
        return pd.read_sql_query(query, conn, params=[watermark_value])
    else:
        return pd.read_sql_query(f"SELECT * FROM {table_ref}", conn)


# ---------------------------------------------------------------------------
# Common Delta write logic
# ---------------------------------------------------------------------------

def _delta_path_for_table(connection_id: int, table_name: str) -> str:
    return os.path.join(WAREHOUSE_ROOT, f"conn_{connection_id}", table_name)


def _get_delta_dir_size(delta_path: str) -> int:
    total = 0
    for dirpath, _dirnames, filenames in os.walk(delta_path):
        for f in filenames:
            total += os.path.getsize(os.path.join(dirpath, f))
    return total


def _write_delta(df: pd.DataFrame, delta_path: str, is_incremental: bool) -> int:
    """Write a DataFrame to Delta Lake. Returns row count."""
    row_count = len(df)

    # Fix null-only columns
    for col in df.columns:
        if df[col].isna().all():
            df[col] = df[col].astype("str")

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

    if is_incremental and os.path.exists(os.path.join(delta_path, "_delta_log")):
        write_deltalake(delta_path, arrow_table, mode="append")
        dt = DeltaTable(delta_path)
        row_count = len(dt.to_pandas())
    else:
        write_deltalake(delta_path, arrow_table, mode="overwrite", schema_mode="overwrite")

    return row_count


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True, "service": "etl"}


@app.post("/discover", response_model=DiscoverResponse)
def discover_tables(req: DiscoverRequest):
    """List all tables in the source with row counts."""
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

    return DiscoverResponse(ok=True, tables=tables)


@app.post("/ingest", response_model=IngestResponse)
def ingest_tables(req: IngestRequest):
    """Read selected tables from source, write as Delta Lake tables."""
    _validate_source_type(req.source_type)

    warehouse_path = os.path.join(WAREHOUSE_ROOT, f"conn_{req.connection_id}")
    os.makedirs(warehouse_path, exist_ok=True)

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

                # Incremental with 0 new rows — skip write
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

                delta_path = _delta_path_for_table(req.connection_id, table_name)
                row_count = _write_delta(df, delta_path, is_incremental)

                # Compute new watermark
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
