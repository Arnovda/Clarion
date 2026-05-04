# RFC-002 — Python notebooks: Pyodide limits & path forward

Status: **Proposed** (not implemented)
Author: architecture review, 2026-04-18

---

## Problem

Python notebooks run in the browser via **Pyodide** (`frontend/components/notebooks/usePyodide.ts`). This was a good early bet — zero backend
infrastructure, privacy-friendly, works offline. But the ceiling is low:

| Constraint | Impact |
|---|---|
| WASM memory cap (~2 GB) | Any `pd.read_sql()` over a meaningful fact table OOMs the tab. |
| No full scikit-learn, no PyTorch, no XGBoost | Serious analytics work isn't possible. |
| No direct DB access | Every `sql()` call round-trips to `/notebooks/query` (backend DuckDB) → JSON → Python dict → `pd.DataFrame`. Adds ~200ms + serialisation cost per cell. |
| No file I/O to warehouse | Can't `pd.read_parquet('az://…/fact_orders')` directly; everything goes through the SQL round-trip. |
| Package install is slow | First-use of `sklearn` or similar: 10-30s install from micropip. |
| No GPU | Self-explanatory. |

Our actual users (analysts) will hit these within weeks of serious use.

## Options

### A. Stay on Pyodide, expand its reach

Give Pyodide direct access to Parquet files via signed URLs.

- `sql()` backend could return a signed blob URL to the Parquet file
  instead of JSON rows. Pyodide reads it via `pyarrow.parquet.read_table()`.
- Pro: No server-side Python infra. Bigger data still possible (Parquet
  streaming is memory-efficient).
- Con: Still no heavy ML packages. Still 2 GB ceiling.
- Con: Signed URL generation adds a Blob Storage SAS-token dependency.
- Effort: ~3 days.

### B. Backend Jupyter kernel per session

One ephemeral Docker container per notebook session runs a real Python
kernel. Cells execute server-side via WebSocket.

- Pro: Full Python ecosystem — pandas on 10+ GB, sklearn, torch, duckdb as
  a Python library, direct Parquet access.
- Pro: Sharable kernel (multi-cursor editing later).
- Con: Container orchestration infra Clarion doesn't have today
  (Azure Container Apps provisioning, idle lifecycle, resource limits).
- Con: Security surface area — arbitrary code on our infra, needs
  network egress lockdown + disk isolation.
- Effort: 2–3 weeks.

### C. Hybrid — Pyodide for interactive, hosted for heavy lifting

Start in Pyodide; "Run on server" button promotes a cell (or notebook)
to a remote kernel for one-off heavy jobs. Results stream back.

- Pro: Good defaults (fast, private) with an escape hatch.
- Con: Two execution environments to reason about. Inconsistent package
  availability. Context (dataframes) doesn't transfer between modes.
- Effort: full path of B plus ~1 week for the handoff UX.

## Recommendation

**Short-term (this quarter): Option A.** Cheap, unlocks the biggest user
complaint (round-tripping 10k+ row tables through JSON). Keeps the
Pyodide bet paying off until we have a reason to commit to server kernels.

**Medium-term (next quarter): evaluate Option B seriously.** Prerequisite:
the platform needs a container-orchestration story anyway (notebook kernels,
ad-hoc transformation previews, bring-your-own-SQL sandboxes). Build that
once, reuse it everywhere.

**Do not build Option C.** The hybrid UX is harder than it looks —
"where does my dataframe live" becomes a permanent source of confusion.

## Option A — Concrete design

### Changes to backend

1. New endpoint `POST /api/notebooks/parquet-url` returns a short-lived
   (15 min) signed URL to the Parquet file(s) of a given table.
   - Local mode: serves the file under `/internal/parquet/{tenant}/{path}`
     with a JWT-scoped token.
   - Azure mode: generates a SAS token with read-only, short TTL.
2. `/api/notebooks/query` keeps working — Pyodide users who don't want
   to think about Parquet can still use `sql()`.

### Changes to Pyodide side

1. New `await pq(table_name)` helper in `usePyodide.ts` → fetches signed
   URL → `pa.parquet.read_table(url)` → returns `pd.DataFrame`.
2. Document in the notebook UI: "`pq('fact_orders')` for big tables,
   `sql('SELECT … FROM fact_orders LIMIT 1000')` for small samples."

### Why this is a real win

Current path for a 100k-row table:
```
DuckDB SELECT * → Node rows → JSON.stringify (30 MB) → fetch → JSON.parse → Python list[dict] → pd.DataFrame
```
~6 s, ~120 MB peak browser memory.

Proposed path:
```
pyarrow streams Parquet directly from signed URL → pd.DataFrame
```
~800 ms, ~30 MB peak.

8× faster, 4× less memory, and it scales: a 10M-row table becomes merely
slow (20s) rather than impossible.

### Risks

- SAS token leakage — mitigated by 15-min TTL, tenant scoping, read-only.
- Pyodide's `pyarrow` is sizeable (~10 MB download). Mitigate via lazy
  load only when `pq()` is first called.

## Decision

Proposed. Option A for this quarter if demand materialises. Option B
revisited once broader "run this thing server-side" infra is on the
roadmap.
