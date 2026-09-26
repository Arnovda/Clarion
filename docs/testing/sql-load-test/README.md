# SQL connector load test

A synthetic ERP database — 17 tables, ~14M rows, **10M in the sales fact** — for
putting the Postgres / MySQL / SQL Server connectors in front of a real server
for the first time. Nothing about them has ever touched a live database; the
suites fake the driver. This is the test that changes that.

It measures three things in order, and the order matters because each one can
only be read once the one before it is known good:

1. **Ingestion** — does the catalog SQL read this server correctly, does a 10M-row
   first load finish, does it resume when it runs past the worker's ceiling,
   does an incremental sync move 50,000 rows instead of 10,000,000.
2. **Modelling** — does the AI designer produce a sensible star schema from an
   introspected source (SQL sources ship no template, so the designer always runs),
   and does the real PRIMARY KEY reach the profiler instead of being guessed.
3. **Speed** — first load, transformation, then a dashboard and an Ask AI question
   over 10M rows.

---

## Before you start: two decisions

**Where the database lives.** Clarion's sync worker runs as an Azure Container
Apps job, so a database on a laptop is invisible to it. To test *production*
Clarion the server has to be reachable from Azure — the instructions below use
Azure Database for PostgreSQL Flexible Server in the same region. A local Docker
Postgres works only against a backend running on the same machine, which tests
the connector but not the worker, the blob warehouse, or anything about speed
that matters.

**Which workspace.** This drops 17 fake tables into whatever tenant you add it
to — the catalog, the subject list and the dashboard picker all fill up with
`erp` data. Register a fresh workspace for it rather than mixing synthetic
tables into the tenant that has real Exact Online data in it.

---

## The CI way: `.ops/loadtest-db` (steps 1–3 without a laptop)

Steps 1–3 below are automated by `.github/workflows/loadtest-db.yml`:

1. Set the repository secret **`LOADTEST_DB_PASSWORD`** (Settings → Secrets and
   variables → Actions). It becomes the password of the read-only login
   `clarion_ro`, the one you type into Clarion. The repository is public, so the
   workflow cannot generate one and show it to you.
2. Put `create` in `.ops/loadtest-db` and push to `main`. The run creates the
   server (General Purpose D2ds_v5 rather than B2ms — a Burstable server spends
   its CPU credits on the load and is then throttled for the sync you came to
   measure), loads the fixture, creates `clarion_ro`, proves it can read and
   cannot write, and puts the expected reading and the exact Clarion form values
   in the run summary.
3. Continue at step 4 below.
4. When Clarion has synced it: `delete` in `.ops/loadtest-db`, push. The run
   fails unless a fresh listing shows no load-test server left. A daily
   scheduled run deletes any load-test server older than 72 hours as a backstop.

Deleting the server removes the source, not what Clarion synced: tables, topics
and dashboards keep working over the warehouse copy. What stops working is
syncing again — so the follow-up runs in §6 need the server alive.

## 1. Create the server (Azure)

```bash
RG=clarion-loadtest-rg
LOC=westeurope                 # same region as the Clarion environment
PG=clarion-loadtest-$RANDOM    # must be globally unique
ADMIN=clarionadmin
read -rsp 'admin password: ' PW; echo

az group create -n "$RG" -l "$LOC"

az postgres flexible-server create \
  --resource-group "$RG" --name "$PG" --location "$LOC" \
  --admin-user "$ADMIN" --admin-password "$PW" \
  --tier Burstable --sku-name Standard_B2ms \
  --storage-size 128 --version 16 \
  --database-name erp_demo \
  --public-access 0.0.0.0 --yes
```

Two of those flags carry the weight:

- `--storage-size 128` is about **IOPS, not space**. The data is ~4 GB; on the
  Burstable tier the IOPS allowance scales with the disk, and the 10M-row insert
  is write-bound. On 32 GB the load takes hours instead of minutes.
- `--public-access 0.0.0.0` is the Azure firewall's "allow other Azure services"
  rule — not the open internet. It is what lets the Container Apps job reach the
  server. Narrower is possible (allow only the Container Apps environment's
  outbound IP, `az containerapp env show -n <env> -g <rg> --query properties.staticIp -o tsv`),
  but the broad rule is acceptable **here specifically because this database holds
  nothing but generated rows**. Do not carry the habit to a customer's database.

Scale it down or delete it when you're finished — a B2ms with 128 GB is roughly
€60–70/month if left running.

<details>
<summary>Local Docker instead (backend on the same machine only)</summary>

```bash
docker run -d --name clarion-loadtest \
  -e POSTGRES_PASSWORD=loadtest -e POSTGRES_DB=erp_demo \
  -p 55432:5432 -v clarion_loadtest:/var/lib/postgresql/data \
  postgres:16 -c shared_buffers=512MB -c max_wal_size=4GB
```
</details>

## 2. Load the data

```bash
CS="host=$PG.postgres.database.azure.com port=5432 dbname=erp_demo \
    user=$ADMIN password=$PW sslmode=require"

psql "$CS" -v ON_ERROR_STOP=1 -f 01-schema.sql      # seconds
psql "$CS" -v ON_ERROR_STOP=1 -f 02-load.sql        # 15-30 minutes, prints progress
psql "$CS" -v ON_ERROR_STOP=1 -f 03-verify.sql      # prints the expected reading
```

`02-load.sql` builds the keys and indexes *after* the rows, and ends with
`ANALYZE` — leave that in. Clarion shows a row estimate from `pg_class.reltuples`,
which stays at "unknown" until the planner has seen the table, and the AI designer
is explicitly told not to build a fact on tables that look empty.

## 3. Create the read-only login Clarion will use

```sql
CREATE ROLE clarion_ro LOGIN PASSWORD '<a different strong password>';
GRANT CONNECT ON DATABASE erp_demo TO clarion_ro;
GRANT USAGE  ON SCHEMA erp TO clarion_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA erp TO clarion_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA erp GRANT SELECT ON TABLES TO clarion_ro;
```

The connector cannot construct a write statement — every statement is built by
the kit from introspected, quoted identifiers, and the connection exposes no way
to run caller-supplied text — but the config asks for a read-only login anyway,
and on SQL Server that structural guarantee carries the whole weight.

## 4. Add the source in Clarion

**Sources → Add a source → PostgreSQL.** Host
`<server>.postgres.database.azure.com`, port 5432, database `erp_demo`, user
`clarion_ro`, schema **`erp`**, and **tick "Use SSL/TLS"** — Azure Flexible Server
refuses an unencrypted connection, and the box is off by default.

**Test connection** is the first real measurement. It should say:

| | |
|---|---|
| tables | **17** |
| with a primary key | **16 of 17** |
| synced incrementally | **14 of 17** |
| relationships | **23** |

`03-verify.sql` prints the same four numbers from the database itself, so any
disagreement is the connector's reading, not the data. **A `0 of N` on either of
the first two means a catalog query is wrong for this server version** — that is
the single thing this step exists to catch.

The three tables that are deliberately not incremental, and why:

| table | why it must sync in full |
|---|---|
| `inventory_movements` | only `created_at`, which never moves on update — using it would sync inserts and silently miss every edit |
| `price_list_entries` | `updated_at` is nullable, and `>= x` never matches a NULL |
| `order_line_tags` | composite primary key — nothing single-valued to merge on |

Select every entity and sync.

## 5. What to watch, step by step

**The first load.** 10M rows at ~5,000 per page. The worker stops cleanly a few
minutes before its 30-minute ceiling and queues a continuation run from the
checkpoint, so expect one or two runs tagged `continued` in the sync history
rather than one long one. That is the resumable-load path working. What would be
wrong is a run reported complete with far fewer than 10,000,000 rows.

**The cursor tie.** 200,000 rows share one exact `updated_at`, spanning forty
pages. This is the case keyset paging exists for: get the tuple comparison wrong
and the sync either loops on one page forever or skips 195,000 rows. Reconcile the
count and `sum(line_amount)` that `03-verify.sql` printed against the same figures
asked in Clarion.

**The reported exclusions.** `customer_documents.file_blob` must appear as an
*excluded* column with a reason, never just be absent. `order_line_tags` must
raise the "no single-column primary key, so every sync reads it in full" warning.

**Then Analyse** (not before — the profiler needs rows to measure). Check
`source_tables.business_key_column` holds the real primary key rather than a
guess from the data, that the 23 foreign keys arrive as source-laid relationships
needing no review, and that the commented tables (`customers`, `products`,
`sales_orders`, `sales_order_lines`, `payment_terms`) arrive already described
while the rest go to the AI review queue. The split is deliberate.

**Then Build → Create my topics.** SQL sources ship no star-schema template, so
this is the AI designer working from an introspected schema — the first time it
has done so. `sales_order_lines` is the obvious fact; `customers`, `products`,
`stores`, `sales_reps` the obvious dimensions.

**Then speed.** Time the transformation, then a dashboard, then an Ask AI question
that aggregates the full 10M rows. DuckDB now really honours its memory limit, so
a large merge may spill to disk and be slower — that is the guard working, not a
fault.

## 6. The follow-up runs

`04-changes.sql` holds four more, to be run one at a time with a sync between each:
an ordinary day's edits (must move ~50,000 rows, not 10M), new rows, deletions
(which an incremental sync *cannot* see — "Check for deleted rows" is what
tombstones them), and a new column appearing. A fifth, commented out, drops a
column a topic depends on; run it only once a topic is built on it, and the table
should go `degraded` naming the column rather than failing.

## 7. Tear down

```bash
az group delete -n clarion-loadtest-rg --yes --no-wait
```

Remove the source in Clarion first if you want its warehouse files cleaned up
with it.

---

## What this does not test

- **MySQL and SQL Server.** Same three-step shape, different catalog SQL — the
  part most likely to be wrong per server version. This fixture is Postgres only;
  porting it is mostly type substitutions.
- **A source that changes mid-sync.** Rows updated while the read is in flight are
  the one case the warnings on the composite-key table describe and nothing here
  exercises.
- **Concurrency.** One tenant, one source, one sync at a time.
