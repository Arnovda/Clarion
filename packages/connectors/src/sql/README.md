# SQL source kit — connector brief

Covers the **PostgreSQL**, **MySQL / MariaDB** and **Microsoft SQL Server**
connectors. Written to `docs/SOURCE_ONBOARDING.md` Phase A; the deviations the
playbook requires to be recorded in writing are in §6.

---

## 1. Metadata tier

A relational database the customer owns is **mixed-tier**, and unusually
well-documented in the places that matter most:

| Metadata kind | Tier | Where it comes from |
|---|---|---|
| Relationships | **1** | `FOREIGN KEY` constraints. Not an inference — the engine *rejects* rows that violate them. No heuristics, no AI, no value-overlap verification. |
| Types | **1** | `information_schema.columns` / `sys.columns`, exact. |
| Business keys | **1** | `PRIMARY KEY` constraints. |
| Table & column descriptions | **1 where comments exist, 3 otherwise** | `COMMENT ON`, MySQL `COLUMN_COMMENT`, SQL Server `MS_Description`. Most customer schemas carry none, so this is normally the AI pass's job. |
| Entity catalog | **3-shaped** | The schema is bespoke per customer, so the catalog is introspected, never curated. |

This is the strongest relationship provenance the platform has anywhere. Exact
Online's hyperlinks and Odoo's `relation` attribute are the vendor *describing*
its model; a foreign key is the database *enforcing* one.

## 2. Auth

Username and password over the driver's own protocol. No OAuth, no token
rotation, so `onCredentialRotated` is not implemented. Credentials are
encrypted at rest by the platform (AES-256-GCM).

**Read-only is enforced at three levels**, in decreasing order of how much they
are worth:

1. **Structurally.** Every statement is built by this kit from identifiers it
   introspected and then quoted. `SqlConnection` exposes no method that runs
   caller-supplied text, so there is no path from a user, a prompt or a config
   value to a `DELETE`.
2. **By session.** Postgres `default_transaction_read_only`, MySQL
   `SET SESSION TRANSACTION READ ONLY`. SQL Server has no equivalent
   (`ApplicationIntent=ReadOnly` only applies to an Availability Group replica).
3. **By grant.** The config help asks for an account with read permission only.
   This is the one guarantee that does not depend on Clarion being correct, and
   the only one that holds for SQL Server.

## 3. Incremental story

Per table, decided at introspection time and reported in the entity picker:

* **Cursor** — the first NOT NULL date/time column matching a conventional
  modified-timestamp name (`updated_at`, `modified_date`, `write_date`, …).
  `created_at` and its synonyms are deliberately excluded: a creation stamp
  does not move on update, so it would sync inserts and silently miss edits.
* **Nullable cursor columns are refused.** `WHERE updated_at >= x` never
  matches a NULL, so a row inserted without a stamp after the first sync would
  be invisible to every later one.
* **Filter is `>=`, cursor advances on `>`** (playbook Phase D.1).
* **No cursor, or no single-column primary key → full sync**, never a faked
  watermark.
* `incrementalDetection: 'off'` turns detection off for a schema whose
  timestamps are not maintained by the application.

**Delete detection** is available on any table with a single-column primary
key: `reconcile` lists keys only (`SELECT <key>`, keyset-paged) and the writer
tombstones what is gone. A full re-sync merges and then calls
`finalizeFullSync`.

## 4. Paging

Keyset, never OFFSET, wherever there is a key — OFFSET re-scans everything it
skips, and a row inserted mid-sync shifts every later page, silently
duplicating and skipping rows.

| Table shape | Order | Resumable? |
|---|---|---|
| single-column PK **and** a cursor | `(cursor, key)` | **yes** — checkpointed |
| single-column PK only | `(key)` | no |
| composite PK | OFFSET over the PK columns | no |
| no PK (typically a view) | OFFSET, unordered | no — and the sync warns |

Ordering by `(cursor, key)` applies **even on the first full load**, which has
no filter. That load is the one most likely to meet the worker's 30-minute
ceiling, and ordering it by cursor is what lets it resume instead of starting
over.

A keyset predicate wants an index on `(cursor, key)`. Without one the database
sorts on every page; on a large table that is the difference between a sync
that finishes and one that does not.

## 5. Types

Mapped explicitly (`WriteTableOptions.columns`), never `auto_detect`. Every
mapping must land on the warehouse writer's allow-list — an unlisted type is
not rejected, the column is silently dropped from the read — and
`typeMap.test.ts` holds every dialect to that.

Two known, deliberate losses:

* **An unconstrained `numeric`** (legal in Postgres) has no width to express
  and becomes `DOUBLE`. Correct for aggregation; rounds beyond 15 significant
  digits.
* **Binary columns are not synced.** Rows are staged as NDJSON, so a blob
  column would embed a base64 copy of every attachment in the staging file and
  again in the Parquet, and nothing downstream can use the bytes. Reported per
  table as a warning, never silent.

## 6. Deviations from the playbook, and why

The playbook is written for vendor APIs, where every customer sees the same
surface. Three of its rules do not transfer to a database the customer owns:

1. **Phase A.6 — "curate 15–25 entities."** There is nothing to curate: the
   tables *are* the customer's. `listEntities` introspects. The spirit of the
   rule — don't mirror an entire API — is met by the customer choosing tables
   in the wizard.
2. **Phase C — descriptions required on every entity.** A table's description
   is its comment, and most schemas have none. Rather than invent one at the
   trusted rung, the descriptor's description **states the reading** —
   "incremental on `updated_at`", "no single-column primary key — read in full
   each sync" — which is the information a person actually needs at the moment
   they pick a table.
3. **Phase F — ship a star-schema template.** A bespoke schema has no universal
   fact/dimension design. `getStarSchemaTemplate()` returns null, which selects
   the AI designer.

`getKnownRelationships` and `getBusinessKeys` are likewise not implemented:
both are synchronous and config-free by contract, and neither question can be
answered without a connection to this customer's database. Both facts travel on
`describeEntities` instead, at the same `declared` rung.

## 7. Known limits

* **No SQLite.** It remains on the legacy direct-database path — it is a local
  file, not a server, and the connection model differs enough to want its own
  pass.
* **Cross-schema foreign keys are dropped.** One connection reads one schema,
  so the other endpoint is not in the catalog.
* **SQL Server `DECIMAL` precision.** The driver returns JS numbers, so a very
  high-scale decimal can round before Clarion ever sees it.
* **No per-table cursor override.** Detection is by convention or off entirely;
  a schema with an unconventional modified-column name syncs in full.
* **Not yet run against a live server of any dialect.** The sync is covered
  end-to-end against a fake driver with real Parquet and DuckDB read-back
  (`SqlSourceConnector.test.ts`), and the catalog SQL is written from each
  vendor's documentation — but the playbook's Phase G live validation is
  outstanding, and the introspection queries are what to watch on a first run.
