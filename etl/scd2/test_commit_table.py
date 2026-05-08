"""
Unit tests for the SCD1 sidecar's pure functions — hashing + diffing.

The sidecar's main() is a thin shell around `add_row_hash` + `diff_states`
+ `write_deltalake`; the I/O concerns aren't easy to unit-test, but the
two pure functions are where the bug surface area lives:

  - `hash_row` must be stable across runs and distinguish NULL from ''
  - `diff_states` must classify rows as unchanged / updated / inserted /
    deleted correctly when we have a business key

Run with:
    cd etl && python -m pytest scd2/test_commit_table.py -v

Or, if pytest isn't installed in the dev venv:
    pip install pytest
    python -m pytest scd2/test_commit_table.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

# Allow `from commit_table import ...` even when pytest is invoked from a
# different cwd. The sidecar lives next to this file.
sys.path.insert(0, str(Path(__file__).parent))

import pyarrow as pa  # noqa: E402

from commit_table import (  # noqa: E402
    HASH_SEP,
    add_row_hash,
    coerce_null_columns_to_string,
    coerce_uuid_columns_to_string,
    diff_states,
    hash_row,
    remove_legacy_parquet,
)


# ── hash_row ────────────────────────────────────────────────────────────────


def test_hash_row_is_stable() -> None:
    a = hash_row(["abc", 1, "x"])
    b = hash_row(["abc", 1, "x"])
    assert a == b, "same input must produce same hash across calls"


def test_hash_row_distinguishes_null_from_empty_string() -> None:
    # The bug we explicitly designed against: a row of (NULL, x) and a
    # row of ('', x) must NOT hash to the same value, otherwise an empty
    # string saved as "we cleared this field" gets diff'd as unchanged.
    null_hash = hash_row([None, "x"])
    empty_hash = hash_row(["", "x"])
    assert null_hash != empty_hash


def test_hash_row_distinguishes_nan_from_value() -> None:
    nan_hash = hash_row([float("nan"), "x"])
    val_hash = hash_row([1.5, "x"])
    assert nan_hash != val_hash


def test_hash_row_unit_separator_avoids_concat_collision() -> None:
    # Without a separator, ('ab', 'cd') and ('abc', 'd') collide.
    # The unit separator (\x1f) prevents this.
    a = hash_row(["ab", "cd"])
    b = hash_row(["abc", "d"])
    assert a != b
    assert HASH_SEP == "\x1f"


# ── add_row_hash ────────────────────────────────────────────────────────────


def test_add_row_hash_handles_empty_dataframe() -> None:
    df = pd.DataFrame({"id": pd.Series([], dtype="object"), "v": pd.Series([], dtype="object")})
    out = add_row_hash(df, ["id", "v"])
    assert "_row_hash" in out.columns
    assert len(out) == 0


def test_add_row_hash_tolerates_missing_columns() -> None:
    """
    business_columns may list names the transformation SQL didn't
    produce. Hash on what's present; don't fail.
    """
    df = pd.DataFrame({
        "id": [1, 2],
        "v": ["a", "b"],
    })
    out = add_row_hash(df, ["id", "v", "phantom_fk", "another_missing"])
    assert "_row_hash" in out.columns
    assert len(out) == 2
    # The hash should match what we'd get with just the present columns.
    expected = add_row_hash(df, ["id", "v"])
    assert list(out["_row_hash"]) == list(expected["_row_hash"])


def test_add_row_hash_zero_present_columns() -> None:
    """If NO business columns are present, every row gets the same
    placeholder hash so the refresh still ships."""
    df = pd.DataFrame({"id": [1, 2, 3]})
    out = add_row_hash(df, ["all_missing", "also_missing"])
    assert "_row_hash" in out.columns
    assert all(h == "no-business-columns" for h in out["_row_hash"])


def test_add_row_hash_subset_of_columns() -> None:
    df = pd.DataFrame({
        "id": [1, 2, 3],
        "v": ["a", "b", "c"],
        "ignore_me": ["X", "Y", "Z"],
    })
    out = add_row_hash(df, ["id", "v"])
    # Same business cols → same hash regardless of ignored cols.
    df2 = df.copy()
    df2["ignore_me"] = ["foo", "bar", "baz"]
    out2 = add_row_hash(df2, ["id", "v"])
    assert list(out["_row_hash"]) == list(out2["_row_hash"])


# ── diff_states ─────────────────────────────────────────────────────────────


def _hashed(rows: list[dict[str, object]], biz_cols: list[str]) -> pd.DataFrame:
    return add_row_hash(pd.DataFrame(rows), biz_cols)


def test_diff_no_business_key_treats_all_as_inserted() -> None:
    new_state = _hashed(
        [{"id": 1, "v": "a"}, {"id": 2, "v": "b"}],
        ["id", "v"],
    )
    counts = diff_states(pd.DataFrame(), new_state, business_key_columns=[])
    assert counts == {
        "rows_unchanged": 0,
        "rows_updated": 0,
        "rows_inserted": 2,
        "rows_deleted": 0,
        "rows_total": 2,
    }


def test_diff_first_run_all_inserted() -> None:
    new_state = _hashed(
        [{"id": 1, "v": "a"}, {"id": 2, "v": "b"}],
        ["v"],
    )
    counts = diff_states(pd.DataFrame(), new_state, ["id"])
    assert counts["rows_inserted"] == 2
    assert counts["rows_unchanged"] == 0
    assert counts["rows_updated"] == 0
    assert counts["rows_deleted"] == 0


def test_diff_classifies_each_state() -> None:
    biz_cols = ["v"]
    existing = _hashed(
        [
            {"id": 1, "v": "a"},     # will stay → unchanged
            {"id": 2, "v": "b"},     # will change → updated
            {"id": 3, "v": "c"},     # will disappear → deleted
        ],
        biz_cols,
    )
    new_state = _hashed(
        [
            {"id": 1, "v": "a"},     # unchanged
            {"id": 2, "v": "B"},     # updated
            {"id": 4, "v": "d"},     # inserted
        ],
        biz_cols,
    )
    counts = diff_states(existing, new_state, ["id"])
    assert counts == {
        "rows_unchanged": 1,
        "rows_updated": 1,
        "rows_inserted": 1,
        "rows_deleted": 1,
        "rows_total": 3,
    }


def test_diff_composite_business_key() -> None:
    # Business key is two columns; both must match for "unchanged".
    biz_cols = ["v"]
    existing = _hashed(
        [
            {"tenant_id": 1, "id": 1, "v": "a"},
            {"tenant_id": 1, "id": 2, "v": "b"},
            {"tenant_id": 2, "id": 1, "v": "z"},  # different tenant — independent row
        ],
        biz_cols,
    )
    new_state = _hashed(
        [
            {"tenant_id": 1, "id": 1, "v": "a"},
            {"tenant_id": 1, "id": 2, "v": "b"},
            {"tenant_id": 2, "id": 1, "v": "Z"},  # value changed for tenant 2
        ],
        biz_cols,
    )
    counts = diff_states(existing, new_state, ["tenant_id", "id"])
    assert counts["rows_unchanged"] == 2
    assert counts["rows_updated"] == 1
    assert counts["rows_inserted"] == 0
    assert counts["rows_deleted"] == 0


# ── remove_legacy_parquet (local paths only — Azure is best-effort) ────────


def test_cleanup_removes_legacy_parquet_when_present(tmp_path) -> None:  # type: ignore[no-untyped-def]
    delta_dir = tmp_path / "dim_supplier"
    delta_dir.mkdir()
    legacy = delta_dir / "data.parquet"
    legacy.write_bytes(b"legacy content")
    # A real-Delta data file should NOT be touched.
    keeper = delta_dir / "part-00000-uuid.parquet"
    keeper.write_bytes(b"delta data")

    msg = remove_legacy_parquet(str(delta_dir), {})
    assert msg is not None
    assert "data.parquet" in msg
    assert not legacy.exists(), "data.parquet should have been removed"
    assert keeper.exists(), "non-legacy files must not be touched"


def test_cleanup_no_op_when_legacy_missing(tmp_path) -> None:  # type: ignore[no-untyped-def]
    delta_dir = tmp_path / "dim_supplier"
    delta_dir.mkdir()
    msg = remove_legacy_parquet(str(delta_dir), {})
    assert msg is None


def test_cleanup_does_not_raise_on_missing_dir(tmp_path) -> None:  # type: ignore[no-untyped-def]
    nonexistent = tmp_path / "does_not_exist"
    # No exception even though path doesn't exist; returns None.
    msg = remove_legacy_parquet(str(nonexistent), {})
    assert msg is None


def test_cleanup_only_targets_data_parquet(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """The cleanup is deliberately narrow — only `data.parquet`, never anything else."""
    delta_dir = tmp_path / "dim_supplier"
    delta_dir.mkdir()
    other_files = [
        delta_dir / "schema.json",
        delta_dir / "metadata.parquet",
        delta_dir / "data.csv",
        delta_dir / "_delta_log",
    ]
    for f in other_files[:-1]:
        f.write_bytes(b"x")
    other_files[-1].mkdir()

    msg = remove_legacy_parquet(str(delta_dir), {})
    assert msg is None
    for f in other_files[:-1]:
        assert f.exists(), f"{f.name} must not be removed"
    assert other_files[-1].is_dir(), "_delta_log must not be removed"


# ── coerce_null_columns_to_string ──────────────────────────────────────────


def test_coerce_null_column_to_string() -> None:
    """An all-NULL column would fail Delta's schema check otherwise."""
    table = pa.table({
        "id": pa.array([1, 2, 3], type=pa.int64()),
        "all_null": pa.array([None, None, None], type=pa.null()),
        "name": pa.array(["a", "b", "c"], type=pa.string()),
    })
    out = coerce_null_columns_to_string(table)
    assert out.schema.field("all_null").type == pa.string()
    assert out.schema.field("id").type == pa.int64()  # untouched
    assert out.schema.field("name").type == pa.string()  # untouched
    # Values stay null.
    assert out.column("all_null").to_pylist() == [None, None, None]


def test_coerce_no_op_when_no_null_columns() -> None:
    table = pa.table({
        "id": pa.array([1, 2], type=pa.int64()),
        "name": pa.array(["a", "b"], type=pa.string()),
    })
    out = coerce_null_columns_to_string(table)
    # Identical schema; same object is fine but not required.
    assert out.schema == table.schema


def test_coerce_uuid_column_to_string() -> None:
    """fixed_size_binary[16] → STRING (UUID hex). Solves the BLOB-vs-UUID
    JOIN failure when DuckDB delta_scan reads back binary columns."""
    uuid_bytes = [
        bytes.fromhex("12345678123456781234567812345678"),
        bytes.fromhex("aabbccddaabbccddaabbccddaabbccdd"),
    ]
    table = pa.table({
        "id": pa.array([1, 2], type=pa.int64()),
        "account_id": pa.array(uuid_bytes, type=pa.binary(16)),
    })
    out = coerce_uuid_columns_to_string(table)
    assert out.schema.field("account_id").type == pa.string()
    assert out.schema.field("id").type == pa.int64()  # untouched
    vals = out.column("account_id").to_pylist()
    # UUID-hex format: 8-4-4-4-12 with dashes.
    assert vals[0] == "12345678-1234-5678-1234-567812345678"
    assert vals[1] == "aabbccdd-aabb-ccdd-aabb-ccddaabbccdd"


def test_coerce_uuid_no_op_when_no_uuid_columns() -> None:
    table = pa.table({
        "id": pa.array([1, 2], type=pa.int64()),
        "name": pa.array(["a", "b"], type=pa.string()),
        # Variable binary is left alone — only fixed[16] is converted.
        "blob_data": pa.array([b"x", b"yy"], type=pa.binary()),
    })
    out = coerce_uuid_columns_to_string(table)
    assert out.schema == table.schema


def test_coerce_uuid_handles_nulls() -> None:
    table = pa.table({
        "account_id": pa.array(
            [bytes.fromhex("12345678123456781234567812345678"), None],
            type=pa.binary(16),
        ),
    })
    out = coerce_uuid_columns_to_string(table)
    vals = out.column("account_id").to_pylist()
    assert vals[0] == "12345678-1234-5678-1234-567812345678"
    assert vals[1] is None


def test_coerce_uuid_only_targets_16_byte_fixed_binary() -> None:
    """Other fixed sizes (e.g. 8-byte, 32-byte) must not be touched."""
    table = pa.table({
        "eight_byte": pa.array([b"01234567", b"abcdefgh"], type=pa.binary(8)),
        "uuid": pa.array([b"\x00" * 16, b"\xff" * 16], type=pa.binary(16)),
    })
    out = coerce_uuid_columns_to_string(table)
    assert out.schema.field("eight_byte").type == pa.binary(8)  # untouched
    assert out.schema.field("uuid").type == pa.string()


def test_coerce_handles_multiple_null_columns() -> None:
    table = pa.table({
        "id": pa.array([1], type=pa.int64()),
        "a": pa.array([None], type=pa.null()),
        "b": pa.array([None], type=pa.null()),
    })
    out = coerce_null_columns_to_string(table)
    assert out.schema.field("a").type == pa.string()
    assert out.schema.field("b").type == pa.string()


# ── BK validation in diff_states ────────────────────────────────────────────


def test_diff_filters_missing_bks_and_proceeds() -> None:
    """
    A BK tagged in product_columns but not produced by the transformation
    SQL should not fail the refresh — diff falls back to the BKs that ARE
    present, with a stderr warning. The chart still tells a useful story.
    """
    biz_cols = ["v"]
    existing = _hashed([{"id": 1, "v": "a"}, {"id": 2, "v": "b"}], biz_cols)
    new_state = _hashed(
        [{"id": 1, "v": "a"}, {"id": 2, "v": "B"}, {"id": 3, "v": "c"}],
        biz_cols,
    )
    # 'phantom_fk' is tagged as a BK but doesn't exist in either side.
    counts = diff_states(existing, new_state, ["id", "phantom_fk"])
    # Diff still ran on `id` only.
    assert counts["rows_unchanged"] == 1
    assert counts["rows_updated"] == 1
    assert counts["rows_inserted"] == 1
    assert counts["rows_deleted"] == 0


def test_diff_zero_usable_bks_falls_back_to_all_inserted() -> None:
    """
    Edge case: every BK is missing. The diff would be meaningless, so
    we degrade to "all inserted" (the same answer as no-BK-declared).
    """
    biz_cols = ["v"]
    existing = _hashed([{"id": 1, "v": "a"}], biz_cols)
    new_state = _hashed([{"id": 1, "v": "a"}, {"id": 2, "v": "b"}], biz_cols)
    counts = diff_states(existing, new_state, ["totally_missing"])
    assert counts == {
        "rows_unchanged": 0,
        "rows_updated": 0,
        "rows_inserted": 2,
        "rows_deleted": 0,
        "rows_total": 2,
    }


def test_diff_handles_resurrected_row() -> None:
    # A BK that was previously not present and now reappears is "inserted"
    # under SCD1 (we don't have history yet to call it "resurrected"). The
    # SCD2 backlog covers the proper handling — this test pins the SCD1
    # behaviour so it's clear when SCD2 lands.
    biz_cols = ["v"]
    existing = _hashed([{"id": 1, "v": "a"}], biz_cols)
    new_state = _hashed(
        [
            {"id": 1, "v": "a"},
            {"id": 2, "v": "b"},
        ],
        biz_cols,
    )
    counts = diff_states(existing, new_state, ["id"])
    assert counts["rows_inserted"] == 1
    assert counts["rows_unchanged"] == 1
