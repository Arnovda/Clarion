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

from commit_table import (  # noqa: E402
    HASH_SEP,
    add_row_hash,
    diff_states,
    hash_row,
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
