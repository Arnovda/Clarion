"""dbt project runner.

Phase 1 of the dbt migration (see docs/rfc-001-dbt-transformations.md).

The backend generates a dbt project on disk (profiles.yml + dbt_project.yml +
models/*.sql + sources.yml), hands us the project path, and we shell out to
`dbt run`. We parse target/run_results.json and return a structured report.

This is deliberately thin — no Python-side project authoring, no dbt API
internals. Just orchestration. The project layout is owned by the backend's
dbtProjectBuilder.ts.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any, Dict, List, Optional


def _run(cmd: List[str], cwd: Optional[str] = None, timeout: int = 600) -> Dict[str, Any]:
    """Execute a shell command and capture output. Never raises."""
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "returncode": proc.returncode,
            "stdout": proc.stdout[-8000:],  # cap to avoid unbounded response size
            "stderr": proc.stderr[-8000:],
        }
    except subprocess.TimeoutExpired as e:
        return {
            "returncode": -1,
            "stdout": (e.stdout or b"").decode("utf-8", errors="replace")[-4000:],
            "stderr": f"Timeout after {timeout}s",
        }
    except FileNotFoundError:
        return {
            "returncode": -1,
            "stdout": "",
            "stderr": (
                "`dbt` binary not found. The ETL container must have "
                "dbt-duckdb installed (see etl/requirements.txt)."
            ),
        }


def _parse_run_results(project_dir: str) -> List[Dict[str, Any]]:
    """Read dbt's per-model results from target/run_results.json."""
    results_path = os.path.join(project_dir, "target", "run_results.json")
    if not os.path.exists(results_path):
        return []

    try:
        with open(results_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []

    out: List[Dict[str, Any]] = []
    for r in data.get("results", []):
        out.append({
            "unique_id":      r.get("unique_id"),
            "model_name":     (r.get("unique_id") or "").split(".")[-1],
            "status":         r.get("status"),
            "execution_time": r.get("execution_time"),
            "rows_affected":  r.get("adapter_response", {}).get("rows_affected"),
            "message":        r.get("message"),
        })
    return out


def run_dbt_project(
    project_dir: str,
    *,
    target: str = "dev",
    select: Optional[str] = None,
    full_refresh: bool = False,
    clean_target: bool = True,
) -> Dict[str, Any]:
    """Run `dbt run` on a project on disk. Returns structured report.

    - `project_dir` should contain `dbt_project.yml` + `profiles.yml`.
    - `select` accepts dbt selector syntax (e.g. 'fact_orders+').
    - `clean_target` deletes target/ before running so stale results from a
      previous invocation don't leak back into the parsed report.
    """
    if not os.path.isdir(project_dir):
        return {
            "ok": False,
            "error": f"Project directory not found: {project_dir}",
        }

    if not os.path.exists(os.path.join(project_dir, "dbt_project.yml")):
        return {
            "ok": False,
            "error": "dbt_project.yml missing — project is malformed.",
        }

    if clean_target:
        target_dir = os.path.join(project_dir, "target")
        if os.path.isdir(target_dir):
            shutil.rmtree(target_dir, ignore_errors=True)

    cmd: List[str] = [
        "dbt",
        "run",
        "--project-dir", project_dir,
        "--profiles-dir", project_dir,
        "--target", target,
    ]
    if select:
        cmd.extend(["--select", select])
    if full_refresh:
        cmd.append("--full-refresh")

    shell = _run(cmd, cwd=project_dir, timeout=1200)
    model_results = _parse_run_results(project_dir)

    success_count = sum(1 for r in model_results if r.get("status") == "success")
    fail_count = sum(1 for r in model_results if r.get("status") in ("error", "fail"))

    return {
        "ok": shell["returncode"] == 0,
        "returncode": shell["returncode"],
        "stdout": shell["stdout"],
        "stderr": shell["stderr"],
        "results": model_results,
        "summary": {
            "total":   len(model_results),
            "success": success_count,
            "failed":  fail_count,
        },
    }


def _fetch_failure_samples(
    state_path: str,
    test_results: List[Dict[str, Any]],
    limit: int = 10,
) -> None:
    """For each failing test, query its dbt_test__audit table and attach
    sample rows + total count to the result dict.

    Safely no-ops on every error — diagnostics are best-effort. Mutates
    test_results in place (adds `failure_count` and `failure_samples`).
    """
    if not state_path or not os.path.exists(state_path):
        return
    try:
        import duckdb  # lazy import — only need it when state exists
    except ImportError:
        return

    con = None
    try:
        con = duckdb.connect(state_path, read_only=True)

        # dbt-duckdb stores failures at `<schema>_dbt_test__audit.<test_name>`.
        # Schema is typically `main` so we commonly land at
        # `main_dbt_test__audit.<test_name>` — but look up dynamically so we
        # work across non-default schema configs too.
        audit_schemas = [
            row[0]
            for row in con.execute(
                "SELECT DISTINCT table_schema FROM information_schema.tables "
                "WHERE table_schema LIKE '%dbt_test__audit%'"
            ).fetchall()
        ]
        if not audit_schemas:
            return

        for r in test_results:
            if r.get("status") != "fail":
                continue
            uid = r.get("unique_id") or ""
            # unique_id format: test.<project>.<test_name>.<hash>
            parts = uid.split(".")
            if len(parts) < 3:
                continue
            test_name = parts[2]

            # Find the audit table in whichever schema actually holds it.
            located_schema: Optional[str] = None
            for sch in audit_schemas:
                exists = con.execute(
                    "SELECT 1 FROM information_schema.tables "
                    "WHERE table_schema = ? AND table_name = ? LIMIT 1",
                    [sch, test_name],
                ).fetchone()
                if exists:
                    located_schema = sch
                    break
            if located_schema is None:
                continue

            audit_table = f'"{located_schema}"."{test_name}"'
            try:
                total = con.execute(f"SELECT COUNT(*) FROM {audit_table}").fetchone()
                samples_rows = con.execute(
                    f"SELECT * FROM {audit_table} LIMIT {int(limit)}"
                ).fetchall()
                cols = [d[0] for d in con.description]
                samples = [dict(zip(cols, row)) for row in samples_rows]
                # DuckDB returns Decimal, datetime etc — coerce to JSON-safe.
                samples = [_jsonify(s) for s in samples]
                r["failure_count"] = int(total[0]) if total else 0
                r["failure_samples"] = samples
            except Exception:
                # Test may have no audit table (e.g. pass, or a relationship
                # test that errored before materialising). Skip silently.
                continue
    except Exception:
        return
    finally:
        if con is not None:
            try:
                con.close()
            except Exception:
                pass


def _jsonify(obj: Any) -> Any:
    """Coerce DuckDB row values to JSON-safe types."""
    import datetime
    import decimal
    if isinstance(obj, dict):
        return {k: _jsonify(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonify(v) for v in obj]
    if isinstance(obj, (datetime.date, datetime.datetime)):
        return obj.isoformat()
    if isinstance(obj, decimal.Decimal):
        return float(obj)
    if isinstance(obj, (bytes, bytearray)):
        return obj.decode("utf-8", errors="replace")
    return obj


def run_dbt_test(
    project_dir: str,
    *,
    target: str = "dev",
    state_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Run `dbt test`. Same shape as run_dbt_project.

    When `state_path` is provided and `store_failures: true` is enabled in
    the project, failing tests' rows are fetched from the state DuckDB and
    attached to each failing result as `failure_count` + `failure_samples`.
    """
    if not os.path.isdir(project_dir):
        return {"ok": False, "error": f"Project directory not found: {project_dir}"}

    cmd = [
        "dbt", "test",
        "--project-dir", project_dir,
        "--profiles-dir", project_dir,
        "--target", target,
    ]
    shell = _run(cmd, cwd=project_dir, timeout=600)
    model_results = _parse_run_results(project_dir)

    if state_path:
        _fetch_failure_samples(state_path, model_results)

    return {
        "ok": shell["returncode"] == 0,
        "returncode": shell["returncode"],
        "stdout": shell["stdout"],
        "stderr": shell["stderr"],
        "results": model_results,
    }
