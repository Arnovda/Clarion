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
  description = "Maximum jobs-worker replicas. MUST stay 1 until crash recovery and the 5-minute reaper are behind a leader election. Both run on startup / on a timer in EVERY worker process and reset rows stuck in 'running' using an age test with no owner or heartbeat — so a second replica starting up would mark the first replica's legitimately in-flight transformations as failed. BullMQ per-queue concurrency already provides parallelism inside one replica; scaling out is a follow-up that needs a Redis leader lock first."
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
