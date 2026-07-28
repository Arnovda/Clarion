# `.ops/` — GitOps controls for production settings

Files here are **operational switches**, not application config. Editing one on
`main` triggers a workflow that applies it to the running Azure resources.

## `warehouse-container-mode`

Contains exactly one word: `per-tenant` or `shared`.

| Value | Meaning |
|---|---|
| `per-tenant` | One Azure Blob container per tenant (`tenant-<id>`). A **hard** storage boundary: a worker SAS scoped to `tenant-42` physically cannot touch `tenant-43`. GDPR offboarding = one container delete. |
| `shared` | One `warehouse` container for everyone, tenants separated by a `tenant_<id>/` path prefix that is enforced **only in application code**. The legacy mode, kept as the rollback path. |

Edit → commit → push to `main`. The **Warehouse container mode** workflow
(`.github/workflows/warehouse-container-mode.yml`) sets the backend's
`WAREHOUSE_CONTAINER_MODE` env var and shifts traffic to the new revision.

**Switching is safe in both directions.** It only changes where *new* writes
land; existing data keeps reading because `warehouse_path` / `delta_path` are
stored as absolute URIs, and the DuckDB session can read both the shared
container and per-tenant containers.

`infra/variables.tf` (`warehouse_container_mode`) remains the source of truth
for a **fresh** environment — keep the two in agreement, since a
`terraform apply` would otherwise reassert the Terraform value.

Details and the validation checklist: `docs/runbooks/per-tenant-container-flip.md`.

## `provision-jobs-worker`

Contains exactly one word: `create`, `delete` or `noop`.

| Value | Meaning |
|---|---|
| `create` | Create (or re-sync) the `…-jobs-worker` Container App: same image and configuration as the backend, no ingress, 1 replica. Heavy DuckDB transformations move there so they stop competing with dashboard queries. |
| `delete` | Remove the worker and hand every queue back to the API. The rollback. |
| `noop` | Do nothing. |

`create` is **idempotent** — running it again updates the existing worker to the
backend's current image and re-applies the queue split. That is the supported way
to move the worker onto a newer build: the worker clones the backend's image at
run time, so re-running it after a deploy brings the two back in step.

Any edit to the file re-triggers the workflow, including a comment line — the
value is read from the first non-comment line.

## `duckdb-runner`

Contains exactly one word: `child` or `off`.

| Value | Meaning |
|---|---|
| `child` | Every warehouse query runs in its own child process, so `DUCKDB_QUERY_TIMEOUT_MS` can **SIGKILL** a runaway query. In-process a timeout only frees the waiting user — the query keeps burning CPU and holds its concurrency permit for its real duration. Also contains a DuckDB OOM or native crash to one runner instead of the whole API. |
| `off` | In-process execution. The default. |

Applies to the **backend app only**. The runner sits on the read path
(`DuckDBConnector.executeQuery` — dashboards, Ask-AI, notebooks, quality
profiling, all in the API container); the worker's heavy DuckDB work is
`transformationRunner`'s write path, which doesn't go through it.

**After flipping to `child`, validate:** look for the log line
`Child-process query runner ACTIVE` (emitted once, on the first query after
boot). If it is missing and you see `the compiled runner script was not found`
instead, the runner silently degraded to in-process and the flip achieved
nothing. Rollback is setting the file back to `off`.

Note the runner divides `DUCKDB_MEMORY_LIMIT` and `DUCKDB_THREADS` across the
slots, so all runners together stay inside the budget one in-process session had.
Raising `DUCKDB_RUNNER_MAX` therefore makes each runner smaller rather than making
the replica's total footprint larger. (The divisor is
`max(DUCKDB_RUNNER_MAX, DUCKDB_MAX_CONCURRENT_QUERIES)`, because a busy runner
causes an extra one to be spawned and only idle runners can be evicted.)

Unlike `warehouse-container-mode`, this control **does nothing when the value is
already applied** — it will not create a revision or shift traffic. It is not a
promote vehicle: re-applying would push the app's current template image to 100%
traffic and so bypass deploy.yml's 0%-traffic test-first model.

## `infra-preflight`

Free-text. Editing it runs a **read-only** probe that reports which roles the
deploy identity holds, whether the backend's configuration can be cloned, whether
Terraform state exists in the subscription, the image + health of both apps, and
the state of warehouse storage (which `tenant-*` containers exist and whether
anything has actually been written into them — the open validation question from
the per-tenant flip). It changes nothing; use it to check production at any time.
