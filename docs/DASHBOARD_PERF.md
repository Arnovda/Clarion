# Dashboard performance — toward "near-instant"

> Goal: make dashboards feel instant (the LakehouseRT experience) at Clarion's
> SMB data scale, without paying for it before it's measured. This doc tracks
> how the path works, what we measure, and the phased plan.

## How a dashboard load works today

`POST /api/dashboards/batch-execute[-stream]` — all widgets in one request:

1. `createProductConnector` resolves each table URI via the table catalog.
2. `connector.connect()` → **DuckDBPool**: a process-wide in-memory DuckDB with
   `delta`(+`azure`) loaded and a view per table pre-registered
   (`delta_scan`/`read_parquet` over `az://…` or local). Reused across requests,
   idle-evicted at 30 min, invalidated on data refresh.
3. Per widget: check **widgetCache** (in-memory, 5-min TTL, keyed
   `tenant + sha256(resolvedSql)`). Hit → return; miss → run on DuckDB (scans
   Parquet/Delta — from blob via curl on cold data) and cache the rows.
4. `Promise.all` across widgets sharing the one pooled DB.

We already match LakehouseRT's core thesis: a vectorized columnar engine
querying Delta/Parquet **directly in object storage** — no separate serving DB.
The gap is latency on a cold miss + cold start, not the architecture.

## What we measure (shipped — free, log-only)

Every `batch-execute` emits one structured line:

```
evt=dashboard.batch_execute  layer=product  widgets=8
  cacheHits=5  cacheMisses=3
  connectMs=…       ← pool connect: cold = extension load + view registration
  slowestWidgetMs=… ← worst single SQL scan (the blob/Parquet read cost)
  totalMs=…
```

How to read it (find the bottleneck before optimising):

- **High `connectMs`, low `slowestWidgetMs`** → cold pool / cold container is the
  cost. Fix = keep the engine warm (always-warm service — *paid*, phase 3).
- **Low `connectMs`, high `slowestWidgetMs`** → blob/Parquet scan is the cost.
  Fix = local data cache + materialized views (mostly *free*, phase 2).
- **High `cacheHits`, low `totalMs`** → already hot; nothing to do.
- **`cacheMisses` high on repeat loads** → cache isn't surviving (per-replica,
  in-memory, 5-min). Fix = durable shared cache + warming (phase 2).

Look at this in App Insights / logs over real usage before spending anything.

## Free wins shipped

- **`enable_object_cache`** on the pooled session — caches Parquet metadata
  (footers/stats) across queries, so repeat scans skip re-parsing.
- **`enable_http_metadata_cache`** (Azure) — caches blob HEAD/range headers so
  repeat reads skip a network round-trip. Both safe: the session is read-only and
  the pool is dropped + rebuilt on every data refresh, so caches can't go stale.
- **Latency instrumentation** (above).

## Roadmap (cheapest first; only spend on measured pain)

**Phase 1 — free (this change):** instrument + read-path caching. ✅

**Phase 2 — ~free (next):**
- Generalise monthly rollups into **materialized widget views** built at refresh
  time → dashboards read a tiny precomputed table. Biggest latency win; cost is
  marginal refresh compute + negligible blob storage.
- **Durable, warmed result cache:** move widgetCache to Redis (survives
  replicas/restarts) and **re-run each dashboard's widget SQL after a refresh**
  so the first user load is already hot. ~€0 self-hosted / ~€16/mo managed.
- **Change-aware refresh** via the Delta sidecar — recompute only changed
  partitions (this *saves* compute).

**Phase 3 — paid (only if `connectMs` proves cold start is the felt pain):**
- **Always-warm query service** (min-replicas = 1) holding the warm pool + a
  **local data cache** (Parquet on node NVMe → DuckDB scans disk, not blob).
  ~€10–30/mo; removes cold start. Roughly doubles the idle baseline.

**Not pursued:** Reyden-class 12k qps / sub-10 ms / custom async engine — solves
a problem we don't have at SMB scale.
