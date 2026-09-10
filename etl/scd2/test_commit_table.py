"""
Tests for the Delta writer sidecar.

Two layers: the pure helpers (hashing, coercion, the streaming reader) and
`main()` driven end to end over real Delta tables on the local filesystem
(`deltalake` installed — CI's sidecar job pins the same versions as the
backend image).

Run with:
    cd etl && python -m pytest scd2/test_commit_table.py -v
"""

from __future__ import annotations

import io
import json
import sys
import uuid
from contextlib import redirect_stdout
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

sys.path.insert(0, str(Path(__file__).parent))

from commit_table import (  # noqa: E402
    HASH_SEP,
    NO_BUSINESS_COLUMNS_HASH,
    ROW_HASH_COL,
    all_inserted,
    coerce_null_columns_to_string,
    coerce_table,
    coerce_uuid_columns_to_string,
    coerced_schema,
    hash_batch,
    hash_row,
    main,
    new_state_reader,
    remove_legacy_parquet,
)

deltalake = pytest.importorskip("deltalake")
from deltalake import DeltaTable  # noqa: E402


# ── hash_row ────────────────────────────────────────────────────────────────


def test_hash_row_is_stable() -> None:
    assert hash_row(["abc", 1, "x"]) == hash_row(["abc", 1, "x"])


def test_hash_row_distinguishes_null_from_empty_string() -> None:
    # A row of (NULL, x) and a row of ('', x) must NOT hash alike, or an
    # emptied field diffs as unchanged.
    assert hash_row([None, "x"]) != hash_row(["", "x"])


def test_hash_row_distinguishes_nan_from_value() -> None:
    assert hash_row([float("nan"), "x"]) != hash_row([1.5, "x"])


def test_hash_row_unit_separator_avoids_concat_collision() -> None:
    assert hash_row(["ab", "cd"]) != hash_row(["abc", "d"])
    assert HASH_SEP == "\x1f"


# ── hash_batch ──────────────────────────────────────────────────────────────


def test_hash_batch_hashes_present_business_columns_in_declared_order() -> None:
    batch = pa.record_batch({"a": ["x", "y"], "b": [1, None], "c": [True, False]})
    hashes = hash_batch(batch, ["b", "a", "missing"]).to_pylist()
    assert hashes == [hash_row([1, "x"]), hash_row([None, "y"])]


def test_hash_batch_with_no_present_columns_uses_the_placeholder() -> None:
    batch = pa.record_batch({"a": ["x", "y"]})
    assert hash_batch(batch, ["nope"]).to_pylist() == [NO_BUSINESS_COLUMNS_HASH] * 2


# ── coercion ────────────────────────────────────────────────────────────────


def test_coerce_null_column_to_string() -> None:
    t = pa.table({"id": [1, 2], "always_null": pa.array([None, None], type=pa.null())})
    out = coerce_null_columns_to_string(t)
    assert out.schema.field("always_null").type == pa.string()
    assert out.column("always_null").to_pylist() == [None, None]
    assert out.column("id").to_pylist() == [1, 2]


def test_coerce_no_op_when_nothing_to_coerce() -> None:
    t = pa.table({"id": [1, 2], "name": ["a", "b"]})
    assert coerce_table(t) is t


def test_coerce_uuid_column_to_string() -> None:
    u1, u2 = uuid.uuid4(), uuid.uuid4()
    t = pa.table({"k": pa.array([u1.bytes, u2.bytes], type=pa.binary(16)), "v": [1, 2]})
    out = coerce_uuid_columns_to_string(t)
    assert out.schema.field("k").type == pa.string()
    assert out.column("k").to_pylist() == [str(u1), str(u2)]


def test_coerce_uuid_handles_nulls_and_leaves_other_binary_alone() -> None:
    u = uuid.uuid4()
    t = pa.table({
        "k": pa.array([u.bytes, None], type=pa.binary(16)),
        "raw8": pa.array([b"12345678", b"abcdefgh"], type=pa.binary(8)),
        "blob": pa.array([b"x", b"yy"], type=pa.binary()),
    })
    out = coerce_table(t)
    assert out.column("k").to_pylist() == [str(u), None]
    assert out.schema.field("raw8").type == pa.binary(8)
    assert out.schema.field("blob").type == pa.binary()


def test_coerced_schema_keeps_metadata_and_order() -> None:
    s = pa.schema([pa.field("n", pa.null()), pa.field("x", pa.int64())], metadata={b"k": b"v"})
    out = coerced_schema(s)
    assert out.names == ["n", "x"] and out.field("n").type == pa.string() and out.metadata == {b"k": b"v"}


# ── streaming reader ────────────────────────────────────────────────────────


def _write_parquet(path: Path, table: pa.Table, row_group_size: int = 2) -> str:
    pq.write_table(table, path, row_group_size=row_group_size)
    return str(path)


def test_reader_streams_row_groups_and_keeps_a_supplied_hash(tmp_path: Path) -> None:
    t = pa.table({"id": [1, 2, 3, 4, 5], "v": ["a", "b", "c", "d", "e"], ROW_HASH_COL: ["h1", "h2", "h3", "h4", "h5"]})
    p = _write_parquet(tmp_path / "n.parquet", t, row_group_size=2)
    r = new_state_reader(p, ["v"])
    batches = list(r)
    assert sum(b.num_rows for b in batches) == 5
    assert len(batches) >= 3  # one per row group at least
    assert pa.Table.from_batches(batches).column(ROW_HASH_COL).to_pylist() == ["h1", "h2", "h3", "h4", "h5"]


def test_reader_computes_the_hash_only_when_node_did_not(tmp_path: Path) -> None:
    t = pa.table({"id": [1, 2], "v": ["a", None]})
    p = _write_parquet(tmp_path / "n.parquet", t)
    r = new_state_reader(p, ["v", "id"])
    assert r.schema.names == ["id", "v", ROW_HASH_COL]
    out = r.read_all()
    assert out.column(ROW_HASH_COL).to_pylist() == [hash_row(["a", 1]), hash_row([None, 2])]


def test_reader_applies_coercions_per_batch(tmp_path: Path) -> None:
    u = uuid.uuid4()
    t = pa.table({"k": pa.array([u.bytes], type=pa.binary(16)), "n": pa.array([None], type=pa.null()), ROW_HASH_COL: ["h"]})
    p = _write_parquet(tmp_path / "n.parquet", t)
    r = new_state_reader(p, [])
    assert r.schema.field("k").type == pa.string() and r.schema.field("n").type == pa.string()
    out = r.read_all()
    assert out.column("k").to_pylist() == [str(u)] and out.column("n").to_pylist() == [None]


# ── legacy cleanup ──────────────────────────────────────────────────────────


def test_cleanup_removes_legacy_parquet_when_present(tmp_path: Path) -> None:
    (tmp_path / "data.parquet").write_bytes(b"legacy")
    (tmp_path / "part-0.parquet").write_bytes(b"delta data file")
    assert remove_legacy_parquet(str(tmp_path), {}) is not None
    assert not (tmp_path / "data.parquet").exists()
    assert (tmp_path / "part-0.parquet").exists()


def test_cleanup_no_op_when_legacy_missing(tmp_path: Path) -> None:
    assert remove_legacy_parquet(str(tmp_path), {}) is None


def test_cleanup_does_not_raise_on_missing_dir(tmp_path: Path) -> None:
    assert remove_legacy_parquet(str(tmp_path / "nope"), {}) is None


# ── main() end to end over real Delta tables ────────────────────────────────


def _run(cfg: dict) -> dict:
    stdin = io.StringIO(json.dumps(cfg))
    out = io.StringIO()
    old = sys.stdin
    sys.stdin = stdin
    try:
        with redirect_stdout(out):
            code = main()
    finally:
        sys.stdin = old
    assert code == 0, out.getvalue()
    return json.loads(out.getvalue())


def _state(tmp_path: Path, name: str, rows: dict) -> str:
    t = pa.table(rows)
    if ROW_HASH_COL not in t.column_names:
        t = t.append_column(ROW_HASH_COL, pa.array([hash_row([t.column(c)[i].as_py() for c in t.column_names]) for i in range(t.num_rows)], pa.string()))
    return _write_parquet(tmp_path / name, t, row_group_size=2)


def _read(delta_path: str) -> pa.Table:
    return DeltaTable(delta_path).to_pyarrow_table().sort_by("id")


def test_first_run_creates_the_table_streams_every_row_and_cleans_legacy(tmp_path: Path) -> None:
    table = tmp_path / "dim_x"
    table.mkdir()
    (table / "data.parquet").write_bytes(b"legacy")
    p = _state(tmp_path, "s1.parquet", {"id": [1, 2, 3], "v": ["a", "b", "c"]})
    r = _run({"delta_path": str(table), "new_state_parquet": p, "business_key_columns": ["id"], "business_columns": ["id", "v"], "mode": "scd1"})
    assert r["status"] == "ok" and r["first_run"] is True and r["write_mode"] == "overwrite"
    assert r["rows_inserted"] == 3 and r["rows_total"] == 3 and r["rows_updated"] == 0
    assert r["legacy_cleanup"] and not (table / "data.parquet").exists()
    out = _read(str(table))
    assert out.column("v").to_pylist() == ["a", "b", "c"]
    assert ROW_HASH_COL in out.column_names
    assert DeltaTable(str(table)).metadata().configuration.get("delta.targetFileSize")


def test_refresh_overwrites_and_reports_the_counts_node_measured(tmp_path: Path) -> None:
    table = tmp_path / "dim_x"
    _run({"delta_path": str(table), "new_state_parquet": _state(tmp_path, "s1.parquet", {"id": [1, 2, 3], "v": ["a", "b", "c"]}), "business_columns": ["id", "v"], "mode": "scd1"})
    counts = {"rows_unchanged": 1, "rows_updated": 1, "rows_inserted": 1, "rows_deleted": 1, "rows_total": 3}
    r = _run({"delta_path": str(table), "new_state_parquet": _state(tmp_path, "s2.parquet", {"id": [1, 2, 4], "v": ["a", "B", "d"]}), "business_columns": ["id", "v"], "mode": "scd1", "counts": counts})
    assert r["status"] == "ok" and r["first_run"] is False and r["write_mode"] == "overwrite"
    assert {k: r[k] for k in counts} == counts and r["counts_measured"] is True
    assert _read(str(table)).column("v").to_pylist() == ["a", "B", "d"]
    assert DeltaTable(str(table)).version() == 1


def test_refresh_without_counts_reports_all_inserted(tmp_path: Path) -> None:
    table = tmp_path / "dim_x"
    _run({"delta_path": str(table), "new_state_parquet": _state(tmp_path, "s1.parquet", {"id": [1], "v": ["a"]}), "business_columns": ["id", "v"], "mode": "scd1"})
    r = _run({"delta_path": str(table), "new_state_parquet": _state(tmp_path, "s2.parquet", {"id": [1, 2], "v": ["a", "b"]}), "business_columns": ["id", "v"], "mode": "scd1"})
    assert r["counts_measured"] is False
    assert {k: r[k] for k in all_inserted(2)} == all_inserted(2)


def test_refresh_with_a_new_column_widens_the_schema(tmp_path: Path) -> None:
    table = tmp_path / "dim_x"
    _run({"delta_path": str(table), "new_state_parquet": _state(tmp_path, "s1.parquet", {"id": [1], "v": ["a"]}), "business_columns": ["id", "v"], "mode": "scd1"})
    r = _run({"delta_path": str(table), "new_state_parquet": _state(tmp_path, "s2.parquet", {"id": [1], "v": ["a"], "w": [2.5]}), "business_columns": ["id", "v", "w"], "mode": "scd1"})
    assert r["status"] == "ok"
    assert "w" in _read(str(table)).column_names


def test_zero_row_first_run_creates_an_empty_table_with_the_schema(tmp_path: Path) -> None:
    table = tmp_path / "fact_x"
    p = _write_parquet(tmp_path / "empty.parquet", pa.table({"id": pa.array([], pa.int64()), "v": pa.array([], pa.string())}))
    r = _run({"delta_path": str(table), "new_state_parquet": p, "business_columns": ["id", "v"], "mode": "scd1"})
    assert r["status"] == "ok" and r["first_run"] is True and r["rows_total"] == 0
    dt = DeltaTable(str(table))
    assert dt.to_pyarrow_table().num_rows == 0
    assert set(dt.schema().to_arrow().names) >= {"id", "v", ROW_HASH_COL}


def test_zero_row_refresh_preserves_existing_rows(tmp_path: Path) -> None:
    table = tmp_path / "fact_x"
    _run({"delta_path": str(table), "new_state_parquet": _state(tmp_path, "s1.parquet", {"id": [1, 2], "v": ["a", "b"]}), "business_columns": ["id", "v"], "mode": "scd1"})
    p = _write_parquet(tmp_path / "empty.parquet", pa.table({"id": pa.array([], pa.int64()), "v": pa.array([], pa.string()), ROW_HASH_COL: pa.array([], pa.string())}))
    r = _run({"delta_path": str(table), "new_state_parquet": p, "business_columns": ["id", "v"], "mode": "scd1"})
    assert r["status"] == "ok" and r["preserved_existing"] is True and r["write_mode"] == "preserved"
    assert r["rows_total"] == 2 and r["rows_unchanged"] == 2
    assert _read(str(table)).num_rows == 2
    assert DeltaTable(str(table)).version() == 0, "preserving must not commit a new version"


def test_zero_row_refresh_with_allow_empty_deletes_existing_rows(tmp_path: Path) -> None:
    table = tmp_path / "fact_x"
    _run({"delta_path": str(table), "new_state_parquet": _state(tmp_path, "s1.parquet", {"id": [1, 2], "v": ["a", "b"]}), "business_columns": ["id", "v"], "mode": "scd1"})
    p = _write_parquet(tmp_path / "empty.parquet", pa.table({"id": pa.array([], pa.int64()), "v": pa.array([], pa.string()), ROW_HASH_COL: pa.array([], pa.string())}))
    r = _run({"delta_path": str(table), "new_state_parquet": p, "business_columns": ["id", "v"], "mode": "scd1", "allow_empty": True})
    assert r["status"] == "ok" and r["write_mode"] == "emptied" and r["rows_deleted"] == 2 and r["rows_total"] == 0
    assert _read(str(table)).num_rows == 0


def test_unknown_mode_is_refused_loudly() -> None:
    r = _run({"mode": "scd2", "delta_path": "x", "new_state_parquet": "y", "business_columns": []})
    assert r["status"] == "failed" and "scd2" in r["error"]


def test_maintain_compacts_and_vacuums_and_skips_non_delta_paths(tmp_path: Path) -> None:
    table = tmp_path / "dim_x"
    for i in range(3):
        # three commits → three small files → compaction has work to do
        _run({"delta_path": str(table), "new_state_parquet": _state(tmp_path, f"s{i}.parquet", {"id": [i, i + 10], "v": ["a", "b"]}), "business_columns": ["id", "v"], "mode": "scd1"})
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "data.parquet").write_bytes(b"not delta")
    r = _run({"mode": "maintain", "delta_paths": [str(table), str(plain), str(tmp_path / "missing")], "retention_hours": 168})
    assert r["status"] == "ok"
    by_path = {e["delta_path"]: e for e in r["results"]}
    assert "skipped" in by_path[str(plain)] and "skipped" in by_path[str(tmp_path / "missing")]
    t = by_path[str(table)]
    assert "error" not in t
    assert t["compact"]["totalConsideredFiles"] >= 1
    # Every superseded file is younger than the retention window: nothing may go.
    assert t["vacuum_files_removed"] == 0
    assert _read(str(table)).column("id").to_pylist() == [2, 12]
