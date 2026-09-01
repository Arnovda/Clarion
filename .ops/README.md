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

## `star-schema-design`

Contains exactly one word: `templates` or `ai`.

| Value | Meaning |
|---|---|
| `templates` | "Create my topics" (the bus-matrix flow) instantiates the connector's deterministic star-schema template when one covers the synced entities; the AI designer is only the fallback. The default, and the documented preference — the AI designer measured worse, which is why the templates exist. |
| `ai` | Force the AI designer for **every** source, including ExactOnline/Odoo. Sets `STAR_SCHEMA_TEMPLATES_DISABLED=1` on the backend. Useful for evaluating the AI path against real data. |

Applies to the **backend app only** (the bus-matrix queue runs in the API —
see `jobs/queueRoles.ts`).

Mind what `ai` costs: designs spend AI tokens and take minutes instead of
being instant, topic/table names are no longer guaranteed identical across
tenants, and a rebuild retires template-built products and replaces them with
AI-designed ones. Rollback is setting the file back to `templates`.

Like `duckdb-runner`, this control **does nothing when the value is already
applied** — it is not a promote vehicle.

## `promote`

The GitOps mouth of the **Promote to production** workflow — the traffic shift
that takes the latest deployed revisions live. The workflow's
`workflow_dispatch` path still works from the Actions tab; this file exists
because dispatch returns 403 for the repo's integration token, so a session
operating via git push could deploy but never promote (the container-mode
control covered only the backend, as a side effect).

The first non-comment line is the target: `backend + frontend`,
`backend only` or `frontend only`. A re-apply is a comment edit documenting
what is being promoted — same convention as the other controls.

**Edit this file only AFTER the deploy.yml run for your commit has finished.**
The workflow promotes whatever revision is *ready* at that moment; touching
the control while the image is still building silently promotes the previous
build (the exact race the container-mode control's log documents from
2026-07-30).

## `db-role`

Contains exactly one word: `admin` or `app`.

| Value | Meaning |
|---|---|
| `app` | The backend connects as `databridge_app` (NOBYPASSRLS). Every `tenant_isolation` policy in the database **actually applies**. |
| `admin` | The backend connects as the superuser `databridge`, which **bypasses row-level security unconditionally**. Isolation then rests entirely on the application's own tenant filters. The rollback. |

Production ran as `admin` from the beginning, which meant RLS enforced nothing —
a superuser bypasses it, and `FORCE ROW LEVEL SECURITY` binds the table *owner*,
not a superuser. Flipped to `app` on 2026-08-06.

The workflow refuses to proceed on a preflight NO-GO, shifts traffic only after
the new revision provisions, then **proves the role can read a real table** (a
login attempt with a nonsense address must return 401, not 500) and returns
traffic to the previous revision by itself if it cannot.

No secret is needed: the role's password is generated, set, verified and written
into the Container App secret without anybody handling it. Set `DB_APP_PASSWORD`
only if you want a known password — it must then be 16+ characters of letters,
digits and `- _ . ~`, because anything else would store one password and connect
with another.

**After flipping, watch `prod-logs` for `grant-missing`** — a table the role was
never granted, on a code path verification did not exercise.

Details: `docs/runbooks/db-role-flip.md`.

## `prod-checks`

Contains one word: `report`.

Read-only. Runs the database role-flip preflight against production and reports
**GO** or **NO-GO** with the blockers named. It reads the PostgreSQL catalog
only — no business data.

## `graph-backfill`

Contains one word: `report`, `apply` or `noop`.

Stamps `tenantId` onto Neo4j nodes written before the write paths started
setting it — step 2 of 3 towards tenant-scoping the semantic graph:

1. every write stamps `tenantId` — done, held by `lint-graph-tenant-stamp`
2. existing nodes are backfilled — **this**
3. reads gain a tenant predicate — only after 2 reports zero remaining

`report` counts and changes nothing; `apply` writes, and is idempotent, so
re-running the report is the check. Until it comes back clean, a tenant
predicate must **not** be added to the reads in `db/semanticGraph.ts`: an
unstamped node does not leak once predicates exist, it silently vanishes from
its owner's catalog — a quieter outage and a harder one to attribute.

**Why it has its own control instead of living in `prod-checks`:** Neo4j runs
with `external_enabled = false`, so no GitHub runner can reach it. That check
sat in `prod-checks` for two days reporting "COULD NOT RUN" on every invocation
— a check that can neither pass nor fail is not a check. Rather than weaken the
ingress posture for a maintenance script, the work now runs as a one-shot
Container Apps **Job** inside the environment, built from the backend's own
image and configuration, with its output pulled back out of Log Analytics.

The script refuses to guess: an entity whose Postgres mirror row is gone (a
`CrossSourceView` with no `connectionId`) is reported, never attributed.

## `relationship-audit`

Free-text; contains a tenant id. Dumps that tenant's semantic layer read-only —
per-connection table and column counts, every relationship with its provenance,
and a summary **last** (so a truncated log still shows it) flagging the four
defect shapes foreign-key detection is known to produce. Only schema metadata is
read; no row values.

## `infra-preflight`

Free-text. Editing it runs a **read-only** probe that reports which roles the
deploy identity holds, whether the backend's configuration can be cloned, whether
Terraform state exists in the subscription, the image + health of both apps, and
the state of warehouse storage (which `tenant-*` containers exist and whether
anything has actually been written into them — the open validation question from
the per-tenant flip). It changes nothing; use it to check production at any time.

## `prod-logs`

Contains a lookback window: `24h`, `7d`, … (Log Analytics keeps 30 days.)

Editing it runs a **read-only** Log Analytics query and reports whether a short
list of known failure signatures appeared:

| Signature | Meaning |
|---|---|
| `grant-missing` | `42501` / `permission denied for` — a table the app role was never granted. The residual risk of the `db-role` flip. |
| `rls-write-denied` | A policy refused a write. Fail-closed, but a user hit a wall. |
| `ownership-refused` | The tenant ownership gate turned traffic away. A burst means it is refusing *legitimate* requests. |
| `runner-active` | **Positive** signal — the child-process query runner announced itself. Its absence means it silently fell back in-process. |
| `runner-degraded` | The runner said so itself. |

Every one of these is something CLAUDE.md already tells the next person to
"watch for", each followed by a note that nobody has ever looked, because looking
meant having Azure credentials on a laptop. That is the gap this closes.

The report prints **log volume first**, deliberately: a clean report over a
window in which nobody used the product proves nothing, and this repository's
recurring failure is exactly the change believed to work while inert. For the
same reason a query that could not run is reported as *unknown*, never as clean.

---

## `alerts` — who gets told when production is broken

Contains an **email address**, or `off`.

Editing it runs `alerts.yml`, which creates (or updates) an Azure Monitor
action group routed to that address plus the alert rules listed in the file's
own comment block: backend 5xx rate, backend and jobs-worker restarts,
Postgres CPU and storage, `request failed` log lines (HTTP ≥500) and
`sync run failed` lines. `off` deletes all of them. Changing the address is an
edit + push — no redeploy.

This is the other half of P0-6 next to the deep `/api/health` check: the
health check stops a bad revision from being *promoted*; these rules are what
notice production breaking *between* deploys. Until 2026-09-01 neither
existed — promotion was automatic and nothing anywhere paged a human.

Two deliberate limits, stated in `.ops/alerts` itself: no queue-depth alert
(no Azure metric exists for BullMQ; the health check's queue-listener probe
covers the dead-consumer case) and no continuous uptime probe (wants an App
Insights web test — the P1-6 observability pass).

The Container Apps metric names are **discovered** from
`az monitor metrics list-definitions` at run time, and the discovered list is
printed to the run summary — this workflow cannot be tested outside Azure,
and a rule created against a guessed name would silently watch nothing. Any
rule that cannot be created **fails the workflow**: an alert you believe
exists but does not is precisely the failure this control replaces.
`infra/alerts.tf` describes the same resources for a future
`terraform import` reconciliation (same trade-off as `provision-jobs-worker`).

After the first successful run, **send a test alert once** (Azure portal →
action group `clarion-alerts` → Test) so the first real incident is not also
the first test of the delivery path.

---

## `.ops/operators` — who may release features to customers

One email address per line; `#` starts a note. Editing it on `main` applies the
list to the backend and shifts traffic to the resulting revision (a couple of
minutes). Removing a line takes the ability away again.

This is the only setup step for the **Who sees what** page, which is where a new
feature is switched on for a chosen set of customers. It is a `.ops` file rather
than a role in the database on purpose: an account admin administers *their own
company*, and if they could also decide which companies see unreleased work,
"release it to one customer first" would stop meaning anything. Putting the list
in the deployment means changing *who* decides needs a push (rare, reviewable),
while changing *what a customer sees* is a click (frequent, instant).

An empty list means **nobody** and the page stays shut — the safe direction, so
a deployment that forgets to fill this in cannot fall back to "any admin". The
workflow warns loudly rather than failing, because emptying it deliberately is a
legitimate act.

Unlike `warehouse-container-mode`, this control re-applies even when the value
has not changed: doing so is harmless here, and a run that reports success while
changing nothing is more confusing than a redundant revision.
