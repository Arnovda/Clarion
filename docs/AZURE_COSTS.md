# Azure cost notes

> Snapshot from the invoice period 01-05-2026 → 09-06-2026 (~39 days), and the
> decisions taken to cut it. Update when the shape of the bill changes.

## Where the money went (net ex-VAT, this period)

| Item | ≈ ex-VAT | What it is |
|---|---|---|
| Azure Container-apps | €88.5 | **mostly the two always-on containers below** |
| — Neo4j (always-on, 0.5 vCPU / 1 GiB) | ~€68 | the single biggest line; ~65% of the whole bill |
| — Redis (always-on, 0.25 vCPU / 0.5 GiB) | ~€12–16 | backs BullMQ scheduled jobs |
| — backend / frontend / etl / sync-worker | the rest | scale-to-zero, genuine usage — fine |
| Container Registry (Basic) | €13.4 | accumulated image layers |
| Files / Blob | €1.4 | Neo4j volume + warehouse |

(Postgres, Log Analytics, Key Vault bill elsewhere — not in this snapshot.)

## Decisions

- **Neo4j → scale to zero** (`min_replicas = 0`, infra/main.tf). Biggest saver
  (~€50/mo). Backend `getSession()` now retries with backoff so the first query
  after idle rides out the ~30–60s cold start.
  **Must validate in prod:** Neo4j uses internal **TCP** ingress (bolt 7687) —
  confirm an inbound connection actually *activates* the container from zero. If
  it doesn't wake reliably, fall back to **scheduled scaling** (scale to 0
  nights/weekends via an `az containerapp update --min-replicas` cron) rather
  than min=0. A managed alternative that sidesteps the wake problem entirely is
  **Neo4j AuraDB Free** (€0, auto-pause/resume) — viable only if the graph fits
  its node/relationship limits.
- **Redis → keep.** It is NOT waste (an earlier read of a stale comment said so).
  It powers scheduled syncs / transformations / email reports, and it's the home
  for the phase-2 warmed dashboard cache (docs/DASHBOARD_PERF.md). ~€12/mo
  buying real automation + future instant-dashboards. Drop it only if you never
  use scheduled refreshes.

## Still open (easy wins, not yet done)

- **Prune ACR images** (~€6/period). Already Basic tier; cost is piled-up layers.
  Add a purge of untagged/old manifests. The path-filtered deploy already pushes
  fewer images per deploy going forward.
- **Log Analytics retention/cap** — set a daily cap; cheap insurance against log
  ingestion creep (the new dashboard timing line is low-volume but additive).
- **Postgres** — already the cheapest burstable tier; stop the dev instance when
  unused if you want a little more.
