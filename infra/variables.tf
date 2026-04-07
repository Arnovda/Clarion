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
