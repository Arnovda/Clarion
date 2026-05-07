#!/usr/bin/env python3
"""
SCD1 + change-tracking writer for product tables.

Reads a tmp parquet (the new state Node DuckDB just produced from the
AI-generated transformation SQL), reads the existing Delta table if any,
hashes both sides, diffs on the business key, then writes the new state
back to Delta.

For SCD1 (today): the dim is fully overwritten with the new state. The
diff counts (unchanged / updated / inserted / deleted) are returned to
Node so they can be persisted in `product_table_refresh_history` for the
per-table change-evolution chart on /products/[id].

For SCD2 (later, mode='scd2'): the same diff drives a full version
history — old rows are closed (`_valid_to = now`, `_is_current = FALSE`)
and new versions are inserted. See docs/backlog/SCD2.md for the design.

Why a sidecar:
  - DuckDB is fast for SQL-shaped compute but its Delta WRITE support
    (esp. MERGE INTO) is limited compared to deltalake-rs.
  - deltalake handles ACID commits, schema evolution, and time travel
    natively.
  - Pairing them (DuckDB executes the AI SQL → polars/pandas reads the
    result + diffs → deltalake commits) is a small architectural seam
    that pays for itself the moment SCD2 lands.

Contract:
  - stdin: JSON config (see SidecarConfig below)
  - stdout: a single JSON object with the result (success or failure)
  - exit code: 0 on success, non-zero on hard failure (e.g. unparseable
    config, sidecar bug). Application errors (write failed) come back as
    `status: "failed"` JSON with code 0.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Optional

import pandas as pd
import pyarrow as pa

# deltalake import is conditional below — keeps the script importable in
# environments where it isn't installed (CI lint passes don't need it).


# ── Hashing ─────────────────────────────────────────────────────────────────

# ASCII Unit Separator — impossible to confuse with column data.
HASH_SEP = "\x1f"


def hash_row(values: list[Any]) -> str:
    """
    Deterministic per-row hash. md5 over a unit-separated string built from
    the row's business-column values, with explicit `'NULL'` for missing
    so empty-string vs NULL stays distinguishable across refreshes.

    md5 is sufficient for our scale — collision risk is ~10^-9 at 1M rows.
    Cryptographic strength isn't needed; deterministic stability across
    runs is.
    """
    parts: list[str] = []
    for v in values:
        if v is None:
            parts.append("NULL")
        elif isinstance(v, float) and pd.isna(v):
            parts.append("NULL")
        else:
            parts.append(str(v))
    joined = HASH_SEP.join(parts)
    return hashlib.md5(joined.encode("utf-8")).hexdigest()


def add_row_hash(df: pd.DataFrame, business_columns: list[str]) -> pd.DataFrame:
    """Add a `_row_hash` column computed from the listed business columns."""
    if df.empty:
        df = df.copy()
        df["_row_hash"] = pd.Series([], dtype="string")
        return df
    # Apply over selected cols only — much faster than hashing whole rows.
    sub = df[business_columns]
    df = df.copy()
    df["_row_hash"] = sub.apply(lambda row: hash_row(list(row)), axis=1)
    return df


# ── Storage options for Azure ───────────────────────────────────────────────


def derive_storage_options(path: str) -> dict[str, str]:
    """
    Build deltalake storage_options based on the URI scheme + env vars.
    Local paths need none; Azure paths need credentials.

    The Azure auth flow mirrors the existing ETL service pattern:
      1. AZURE_STORAGE_CONNECTION_STRING (full connection string) —
         convenient for dev/staging
      2. AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY — common
         in container apps
      3. Fall through to managed-identity / Azure CLI (set
         AZURE_USE_AZURE_CLI=true) — production default
    """
    if not path.startswith("az://"):
        return {}

    conn_str = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
    if conn_str:
        # deltalake parses this directly via SAS / key embedded in the string.
        # We pass account name + the SAS/key fragments by parsing it ourselves.
        parts = dict(
            kv.split("=", 1)
            for kv in conn_str.split(";")
            if "=" in kv
        )
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

    # Fall through: deltalake will try managed identity / CLI.
    return {"use_azure_cli": "true"} if os.environ.get("AZURE_USE_AZURE_CLI") == "true" else {}


# ── Diff ────────────────────────────────────────────────────────────────────


def diff_states(
    existing: pd.DataFrame,
    new_state: pd.DataFrame,
    business_key_columns: list[str],
) -> dict[str, int]:
    """
    Compute change counts between existing-state and new-state, both with
    `_row_hash` already populated.

    Returns counts dict — the actual data we ship to Delta is just
    `new_state` (SCD1: full overwrite). Counts power the refresh-history
    chart and surface what changed without an audit table.
    """
    if not business_key_columns:
        # No BK declared on the table — every refresh is treated as
        # "all inserted". That's the honest answer when we can't identify
        # rows across runs.
        return {
            "rows_unchanged": 0,
            "rows_updated": 0,
            "rows_inserted": int(len(new_state)),
            "rows_deleted": 0,
            "rows_total": int(len(new_state)),
        }

    if existing.empty:
        return {
            "rows_unchanged": 0,
            "rows_updated": 0,
            "rows_inserted": int(len(new_state)),
            "rows_deleted": 0,
            "rows_total": int(len(new_state)),
        }

    # Outer-merge on BK with hash-on-each-side suffixes so we can categorise.
    merged = existing[[*business_key_columns, "_row_hash"]].rename(
        columns={"_row_hash": "_row_hash_old"}
    ).merge(
        new_state[[*business_key_columns, "_row_hash"]].rename(
            columns={"_row_hash": "_row_hash_new"}
        ),
        on=business_key_columns,
        how="outer",
        indicator=False,
    )

    old = merged["_row_hash_old"]
    new = merged["_row_hash_new"]

    inserted = int((old.isna() & new.notna()).sum())
    deleted = int((old.notna() & new.isna()).sum())
    both = old.notna() & new.notna()
    unchanged = int((both & (old == new)).sum())
    updated = int((both & (old != new)).sum())

    return {
        "rows_unchanged": unchanged,
        "rows_updated": updated,
        "rows_inserted": inserted,
        "rows_deleted": deleted,
        "rows_total": int(len(new_state)),
    }


# ── Main ────────────────────────────────────────────────────────────────────


def main() -> int:
    try:
        cfg = json.loads(sys.stdin.read())
    except Exception as e:
        # Hard failure — config is malformed. Non-zero exit so Node's
        # spawn promise rejects.
        sys.stderr.write(f"[sidecar] failed to parse config: {e}\n")
        return 2

    delta_path: str = cfg["delta_path"]
    new_state_parquet: str = cfg["new_state_parquet"]
    business_key_columns: list[str] = cfg.get("business_key_columns") or []
    business_columns: list[str] = cfg["business_columns"]
    mode: str = cfg.get("mode", "scd1")

    if mode != "scd1":
        # SCD2 lives in the backlog; sidecar refuses unknown modes loudly
        # rather than silently doing the wrong thing.
        result = {
            "status": "failed",
            "error": f"unsupported mode '{mode}' — only 'scd1' is implemented",
        }
        sys.stdout.write(json.dumps(result))
        return 0

    storage_options = cfg.get("storage_options") or derive_storage_options(delta_path)

    try:
        # 1. Read the new state Node DuckDB just produced.
        new_state_raw = pd.read_parquet(new_state_parquet)

        # 2. Compute row hashes for the new state. Persisted to Delta so
        #    SCD2 can later use it as `_row_hash` without a schema change.
        new_state = add_row_hash(new_state_raw, business_columns)

        # 3. Read existing Delta if it exists.
        from deltalake import DeltaTable, write_deltalake

        existing: pd.DataFrame
        first_run: bool
        try:
            dt = DeltaTable(delta_path, storage_options=storage_options)
            existing_arrow = dt.to_pyarrow_table()
            existing = existing_arrow.to_pandas()
            first_run = False
        except Exception:
            # PathNotFound / TableNotFoundError both surface as exceptions
            # depending on deltalake version — treat any failure to load
            # as "first run" and let the write below initialise.
            existing = pd.DataFrame()
            first_run = True

        # 4. Diff (counts only — SCD1 doesn't act on the diff beyond logging).
        if first_run:
            counts = {
                "rows_unchanged": 0,
                "rows_updated": 0,
                "rows_inserted": int(len(new_state)),
                "rows_deleted": 0,
                "rows_total": int(len(new_state)),
            }
        else:
            # Existing rows already had _row_hash if written by this sidecar.
            # If not (legacy / parquet migration), recompute on the fly.
            if "_row_hash" not in existing.columns:
                # Compute hash on the existing rows using the SAME business
                # columns we're using now. Missing cols (schema evolution)
                # → NaN → hashed as 'NULL', matching new-state behaviour.
                for col in business_columns:
                    if col not in existing.columns:
                        existing[col] = None
                existing = add_row_hash(existing, business_columns)
            counts = diff_states(existing, new_state, business_key_columns)

        # 5. Write the new state to Delta.
        #    schema_mode='merge' lets deltalake widen the schema when the
        #    transformation produces new columns (SCD1 schema evolution).
        write_deltalake(
            delta_path,
            pa.Table.from_pandas(new_state, preserve_index=False),
            mode="overwrite",
            schema_mode="merge",
            storage_options=storage_options,
        )

        result = {
            "status": "ok",
            "first_run": first_run,
            **counts,
        }
        sys.stdout.write(json.dumps(result))
        return 0

    except Exception as e:
        # Application error — write failed, parquet missing, etc. Surface
        # to Node as JSON status='failed' with the message; exit 0 so Node
        # parses the structured output rather than treating it as a crash.
        result = {
            "status": "failed",
            "error": f"{type(e).__name__}: {e}",
        }
        sys.stdout.write(json.dumps(result))
        return 0


if __name__ == "__main__":
    sys.exit(main())
