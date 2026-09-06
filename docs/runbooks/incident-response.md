# Runbook: incident response — what to do in the first hour, and what we owe afterwards (4-1)

> **This is the process the DPA and the security page refer to.** The DPA
> (§7) promises that Clarion, as processor, notifies the customer "without
> undue delay" after becoming aware of a personal-data breach, with what
> they need for their own Art. 33/34 obligations, and documents the breach
> and the remediation. Nothing in that sentence is true unless the steps
> below are followed and the artefacts named here exist. Every control this
> runbook cites is real and is linked; when one changes, change this file
> in the same PR.

Clarion is operated by one person today. "Incident commander", "comms" and
"engineer" below are roles, not people — the same person wears all three
until there is a second operator, and the point of writing them down is that
nothing is skipped because it was nobody's job.

---

## 1. What counts as an incident, and how bad it is

| Severity | Definition | Examples | Customer comms |
|---|---|---|---|
| **Sev 1** | The platform is down or unsafe for every customer, OR customer data was or may have been exposed to anyone it does not belong to | backend 5xx storm; login broken; a cross-tenant read; leaked credentials; ransomware on the warehouse | Announcement within 30 min; breach notification path (§5) if data is involved |
| **Sev 2** | A core capability is broken for some customers, no data exposure | syncs failing for one connector; Ask AI refusing every question; a queue not draining; a stale source past its window | Announcement within 2 h if more than one customer is affected |
| **Sev 3** | Degraded but usable; a single customer affected | one tenant's build stuck; a dashboard that cannot be generated | No announcement; the customer is told directly if they raised it |

Anything involving personal data reaching a party it should not have —
another tenant, the internet, an unauthorised person, or an AI provider
after a tenant switched AI off — is **Sev 1 by definition**, whatever the
volume.

## 2. How incidents are detected

Every signal below already exists. The list is what to read, in order,
when something feels wrong or an alert fires.

| Signal | Where | What it tells you |
|---|---|---|
| Alert email (`clarion-alerts`, and `clarion-alerts-sev1` when paging is configured) | `.ops/alerts`, `.github/workflows/alerts.yml` | The eleven rules: backend 5xx, backend/worker restarts, Postgres CPU/storage, `server-errors`, `failed-syncs`, `brute-force`, `queue-depth`, `stale-source`, `sql-guard`. The summary of the last alerts run lists what exists. |
| Deep health | `GET /api/health` on the backend (the promote gate's probe) | Postgres, Redis, Neo4j, blob storage, and whether anything is LISTENING on the transformation and bus-matrix queues. 503 names the component. |
| Production logs | `.ops/prod-logs` (edit the window, optional `tenant <id>` / `request <id>`) | Known failure signatures over the last window, log volume first, per tenant or per request id. Log Analytics keeps **30 days** — export what you need within that. |
| Operator console | `/admin/ops` → Errors, Queues; `/admin/tenants` | Recent errors per customer with the request id; queue depth, failed jobs (retry/cancel); per-tenant health, suspension, budgets. |
| Customer report | email to the support address | Ask for the time, the screen, and — if they have it — the request id the error card shows. |

## 3. The first hour — Sev 1 and Sev 2

Work top to bottom. Write a line in the incident log (§6) at every step:
timestamp, what you saw, what you did.

1. **Confirm, don't assume.** `GET /api/health`; the last Build & Deploy
   run (was there a deploy in the last hour? its Go-live step names the
   revision); `.ops/prod-logs` over `1h`. Decide the severity from §1.
2. **Stop the bleeding before understanding it.** The levers, cheapest
   first:
   - **Roll back the last deploy**: Actions → *Rollback production* → Run
     workflow (`.github/workflows/rollback.yml`; `migrations: true` also
     undoes the last migration batch — read
     `docs/runbooks/disaster-recovery.md` §2b first).
   - **Suspend one tenant** whose activity is the problem: `/admin/tenants`
     → Suspend (bites within 30 s; their schedules stop within the request).
   - **Switch AI off for a tenant** whose data must stop flowing to a
     provider: `/admin/tenants` → impersonate an admin → AI usage → routing
     → *AI off* (or `UPDATE tenants SET ai_routing_mode='off'` from a DB
     session — takes effect within 15 s).
   - **Lock down warehouse reads**: `.ops/duckdb-lockdown` → `on` (blocks
     local-filesystem access from every query session).
   - **Cancel or drain a queue**: `/admin/ops` → Queues → Cancel / Retry.
   - **Revoke credentials** if any were exposed: rotate the affected secret
     in the Container App (the storage connection string, the JWT secret,
     the credentials encryption key — see `infra/` for which app holds
     what), then redeploy via `.ops/redeploy`. A JWT secret rotation signs
     everyone out; say so in the announcement.
3. **Tell customers what you know** — `/admin/ops` → Announcements
   (`critical` for Sev 1, `warning` for Sev 2). The banner shows on every
   screen of every workspace within 60 s. Say what is affected, what they
   should not do, and when the next update comes. End it when it is over.
4. **Find the cause.** Take the request id from the error card, the errors
   feed or the alert, and read `.ops/prod-logs` with `request <id>`; the
   pino `mixin` stamps every line of that request, its jobs and its sync
   child. Read the audit trail (`/users` → Audit log → Export CSV) for the
   tenant if the question is "who did what".
5. **Preserve evidence before it ages out.** Log Analytics retention is 30
   days: run the `prod-logs` query for the whole window and keep the run's
   summary; export the tenant's audit CSV; note the deploy run numbers and
   revision names; if data may have been exposed, a schema-only dump is in
   the deploy run's artifacts (`schema-before-<sha>`, 30 days) and a PITR
   restore to a side server preserves the rows (`disaster-recovery.md` §2).
6. **Decide whether personal data was involved.** If yes, or if you cannot
   rule it out within the hour, §5 starts NOW — the clock is the customer's.

## 4. Closing an incident

- The cause is fixed in a commit that names the incident (or the
  mitigation is in place and the fix is scheduled).
- The announcement is ended, with a final line saying it is resolved.
- Any secret that was exposed is rotated; any session that might have
  been hijacked is revoked (`POST /auth/logout-all` for the users
  involved, or a JWT secret rotation for everyone).
- The write-up (§6) exists.
- If an alert rule would have caught it earlier, add the rule
  (`.ops/alerts` + `alerts.yml`) in the same PR as the write-up.

## 5. Personal-data breach — the notification path

A breach is any confirmed or reasonably suspected event where personal
data held for a customer was accessed, disclosed, altered, lost or
destroyed without authorisation. Clarion is the **processor**; the customer
is the **controller** and owns the 72-hour clock to their supervisory
authority (GDPR Art. 33) and any notification to data subjects (Art. 34).
Our obligation is to give them what they need, fast.

1. **Within 24 hours of becoming aware**, email every affected customer's
   admins (the addresses on `/admin/tenants` → detail → users, role
   admin), subject `Clarion — security incident notification`, with:
   - what happened and when (first known occurrence, when we became
     aware, when it was contained);
   - which categories of data and roughly how many records/people
     (from the affected tables — the tenant export `manifest.json` gives
     the row counts per table);
   - the likely consequences as far as known;
   - the measures taken and proposed;
   - a contact for follow-up (the security address on `/security`).
   Send what you know; say what you do not know yet and when the next
   update follows. Do not wait for a complete picture — "without undue
   delay" means the first message goes out before the investigation ends.
2. **Keep the record.** The incident log and write-up (§6) ARE the
   processor's breach documentation the DPA promises. Keep the sent
   emails with them.
3. **Follow up** with the complete picture within 72 hours of the first
   notice, and again when remediation is done.
4. **Anthropic and Azure**: if the breach involved a subprocessor (an AI
   provider outage that returned another customer's content, a storage
   misconfiguration), record their incident reference and what they
   reported; the customer will ask.

## 6. The incident log and the write-up

- During the incident: a running log in `docs/incidents/<yyyy-mm-dd>-<slug>.md`
  (create the directory on first use), one line per step, timestamps in
  UTC. Started in the first ten minutes, however rough.
- Within five working days: turn it into a write-up with — timeline;
  impact (which tenants, what data, for how long); root cause; what
  detected it and how long that took; what fixed it; what changes so it
  cannot recur (with the commit or `.ops` file that carries each change);
  and, for a data breach, the notification record from §5.
- Customer-facing summaries are derived from the write-up, never written
  separately.

## 7. Practising

Once a quarter, pick one Sev 2 scenario from §1, run §3 against the
0%-traffic staging revision (every deploy leaves one behind the `staging`
label) and note what was slow or missing. The first rehearsal of this
runbook has not happened yet; the disaster-recovery runbook's §6
restore rehearsal counts as one when it is done.
