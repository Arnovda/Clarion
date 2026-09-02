# ─────────────────────────────────────────────────────────────────────────────
# Input variables
# ─────────────────────────────────────────────────────────────────────────────

variable "project_name" {
  type        = string
  default     = "databridge"
  description = "Project name prefix used in all resource names."
}

variable "environment" {
  type        = string
  default     = "prod"
  description = "Environment name (prod, staging, dev)."
  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "Environment must be prod, staging, or dev."
  }
}

variable "location" {
  type        = string
  default     = "westeurope"
  description = "Azure region. westeurope = Netherlands, closest to Belgium."
}

variable "tags" {
  type = map(string)
  default = {
    project    = "databridge"
    managed_by = "terraform"
  }
}

# ── PostgreSQL ──────────────────────────────────────────────────────────────

variable "pg_admin_user" {
  type        = string
  default     = "databridge"
  description = "PostgreSQL admin username."
}

variable "pg_admin_password" {
  type        = string
  sensitive   = true
  description = "PostgreSQL admin password."
}

variable "pg_sku" {
  type        = string
  default     = "B_Standard_B1ms"
  description = "PostgreSQL SKU. B_Standard_B1ms is the cheapest flexible server (~25 EUR/month)."
}

# ── Secrets ─────────────────────────────────────────────────────────────────

variable "jwt_secret" {
  type        = string
  sensitive   = true
  description = "JWT signing secret."
}

variable "anthropic_api_key" {
  type        = string
  sensitive   = true
  description = "Anthropic Claude API key."
}

variable "credentials_encryption_key" {
  type        = string
  sensitive   = true
  description = "AES-256 key for encrypting connection credentials at rest."
}

variable "neo4j_password" {
  type        = string
  sensitive   = true
  description = "Neo4j database password."
}

# ── Frontend ────────────────────────────────────────────────────────────────

variable "frontend_url" {
  type        = string
  default     = ""
  description = "Frontend URL for CORS origin. Leave empty on first deploy, then update with the actual Container App URL."
}

# ── Network ─────────────────────────────────────────────────────────────────

variable "local_ips" {
  type        = list(string)
  default     = []
  description = "Your local IP addresses, so you can run migrations from your machine. Find yours at https://whatismyipaddress.com."
}

# ── Custom domain (optional) ────────────────────────────────────────────────

variable "custom_domain" {
  type        = string
  default     = ""
  description = "Custom domain name. Leave empty to skip DNS zone creation."
}

# ── Resilience & backup (P1-4) ──────────────────────────────────────────────
# The written RTO/RPO these settings deliver lives in
# docs/runbooks/disaster-recovery.md — keep the two in step.

variable "pg_high_availability" {
  type        = bool
  default     = false
  description = "Zone-redundant HA for PostgreSQL (a synchronous standby in a second availability zone; automatic failover, RPO 0, RTO 60-120s). Default OFF for a hard reason, not preference: Azure does not support HA on the Burstable tier, and pg_sku defaults to B_Standard_B1ms — flipping this alone would fail the apply. Enabling it therefore means BOTH pg_sku >= GP_Standard_D2ds_v4 AND this flag, which roughly 10×es the Postgres bill (~25 -> ~260 EUR/month: General Purpose compute, twice, plus HA storage). Until a customer's contract needs RPO 0 on Postgres, the 14-day PITR + geo-redundant backups below it are the recovery story — restore-from-backup, not failover. See docs/runbooks/disaster-recovery.md for the RTO/RPO either way."
}

variable "redis_persistence_enabled" {
  type        = bool
  default     = false
  description = "AOF persistence for Redis on an Azure Files mount. Default OFF because ephemerality is a DECISION here, not an oversight (recorded in the redis app's command comment since the Fase-2 split): Postgres is the source of truth for every schedule, jobs/scheduleReconciler re-registers repeatable jobs on reconnect, startup crash-recovery closes interrupted runs, and the liveness reapers fail orphans within ~10 minutes — so a Redis restart today loses only delayed one-shot jobs and in-flight queue entries, all of which fail visibly and are re-triggerable. What flipping this buys is a narrower window on exactly those; what it costs is AOF fsync over SMB on every queue operation and a new failure mode (a corrupt AOF tail can refuse to load and turn an ephemeral blip into an outage — redis 7's aof-load-truncated default tolerates clean truncation, not corruption). If you flip it, VALIDATE LIVE before trusting it: restart the redis revision and watch a delayed job survive; nothing in CI exercises this path."
}

variable "neo4j_backup_retention_days" {
  type        = number
  default     = 30
  description = "Daily-snapshot retention for the Neo4j file share via Azure Backup. Snapshots are crash-consistent: Neo4j 5's transaction log recovers from one exactly as from a power cut, which is why share snapshots — not neo4j-admin dumps — are the mechanism (Community edition has no online backup; a dump requires the database STOPPED, i.e. scheduled downtime). RPO is therefore up to 24h on the graph; the residual loss is bounded because most of the graph is rebuildable from Postgres (migrateSemanticToNeo4j + syncAllProducts + re-Analyse) — the true 24h exposure is un-mirrored human edits (the revert/approve/import paths CLAUDE.md lists as un-mirrored)."
  validation {
    condition     = var.neo4j_backup_retention_days >= 7 && var.neo4j_backup_retention_days <= 180
    error_message = "neo4j_backup_retention_days must be between 7 and 180."
  }
}

# ── Warehouse & compute (storage-layer hardening) ───────────────────────────

variable "warehouse_container_mode" {
  type        = string
  default     = "per-tenant"
  description = "Warehouse tenant-isolation mode. 'per-tenant' (DEFAULT since 2026-07-23) = one Blob container per tenant: a hard storage boundary (a worker SAS scoped to tenant-42 physically cannot touch tenant-43) plus one-call GDPR offboarding. 'shared' = one Blob container with tenants separated by a tenant_<id>/ prefix enforced only in application code — the legacy mode, kept as the rollback path. Switching modes is safe in both directions: it only changes where NEW writes land; existing data keeps reading because warehouse_path/delta_path are stored as absolute URIs. See docs/runbooks/per-tenant-container-flip.md."
  validation {
    condition     = contains(["shared", "per-tenant"], var.warehouse_container_mode)
    error_message = "warehouse_container_mode must be 'shared' or 'per-tenant'."
  }
}

# Container Apps (consumption profile) requires memory in GiB = 2 × vCPU.
# Valid pairs: 0.25/0.5Gi, 0.5/1Gi, 0.75/1.5Gi, 1/2Gi, 1.25/2.5Gi, …

variable "backend_cpu" {
  type        = number
  default     = 1.0
  description = "vCPU for the backend Container App. Raised from 0.5 to 1.0 (2026-07): the backend runs DuckDB in-process for every interactive query, and 0.5 vCPU / 1 GiB was the tightest analytical-serving tier of any comparable platform."
}

variable "backend_memory" {
  type        = string
  default     = "2Gi"
  description = "Memory for the backend Container App. Must be 2 × backend_cpu GiB. 2Gi gives DuckDB real headroom (its memory_limit is a percentage of this) instead of spilling or OOM-ing on concurrent scans."
}

variable "backend_min_replicas" {
  type        = number
  default     = 0
  description = "Minimum backend replicas. Kept at 0 (scale-to-zero) on purpose: once BullMQ workers move to the jobs-worker app, nothing in the backend needs to be always-on, so scaling to zero costs only a cold start on the first request instead of ~EUR 65/month of idle compute. Set to 1 if cold starts for business users are unacceptable."
}

variable "backend_role" {
  type        = string
  default     = "api"
  description = "ROLE env var for the backend app. 'api' = HTTP only, background jobs are the jobs-worker's responsibility (the split). 'all' = the legacy single-process behaviour where the API also hosts every BullMQ worker — set this to roll the split back without deleting the worker app."
  validation {
    condition     = contains(["api", "all"], var.backend_role)
    error_message = "backend_role must be 'api' or 'all'."
  }
}

variable "jobs_worker_cpu" {
  type        = number
  default     = 0.5
  description = "vCPU for the jobs-worker Container App (transformations, profiling, email/brief jobs). 0.5 already beats today's situation, where transformations share the API's 0.5 vCPU with every dashboard query instead of having it to themselves. Raise to 1.0 only if transformations actually prove memory- or CPU-bound — at Consumption rates that doubles the bill (~$39 → ~$79/month at the active rate)."
}

variable "jobs_worker_memory" {
  type        = string
  default     = "1Gi"
  description = "Memory for the jobs-worker Container App. Must be 2 × jobs_worker_cpu GiB."
}

variable "jobs_worker_min_replicas" {
  type        = number
  default     = 1
  description = "Minimum jobs-worker replicas. MUST be >= 1: BullMQ delayed/repeatable jobs are promoted by a running worker (verified in BullMQ's own moveToActive Lua script), so with 0 replicas scheduled syncs, transformations and email reports simply never fire. KEDA cannot rescue this: scaling on the 'wait' list deadlocks because only a worker fills it, and scaling on the 'delayed' set never scales back down because an active Job Scheduler permanently keeps one job there. COST NOTE: Container Apps bills a min-replica app at the cheap idle rate only while it stays under 0.01 vCPU AND under 1000 bytes/sec received. A BullMQ worker polling Redis across 11 queues may well exceed that and bill at the ACTIVE rate around the clock — measure it in Cost Analysis rather than assuming the low figure."
}

variable "jobs_worker_max_replicas" {
  type        = number
  default     = 1
  description = "Maximum jobs-worker replicas. The old blockers are GONE (P1-1, 2026-09-01): RUN_SCHEDULERS=false already confines schedules, crash recovery and the reapers to the API process, and the reapers are liveness-based now (services/reapers.ts keys on a heartbeat going quiet, not on age), so parallel long-running work is safe and BullMQ handles multi-replica workers natively. The default stays 1 for a different reason: the worker has NO scale rule, and on Container Apps max_replicas without a rule is inert — raising this alone changes nothing. To actually scale out: either raise min replicas too (an always-on cost decision) or add a KEDA Redis queue-depth rule. Parallelism today comes from per-queue concurrency (2 on the AI queues, with per-tenant fairness)."
}

variable "duckdb_memory_limit" {
  type        = string
  default     = "70%"
  description = "DuckDB memory_limit for the backend (e.g. '512MB', '1GB', '70%'). Bounds analytical query memory so a heavy AI query can't OOM the replica; excess spills to disk."
}

variable "duckdb_threads" {
  type        = number
  default     = 2
  description = "DuckDB thread cap for the backend. Keeps a single query from saturating all cores on a small shared replica."
}
