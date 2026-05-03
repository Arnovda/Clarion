# ─────────────────────────────────────────────────────────────────────────────
# DataBridge — Azure Infrastructure (Terraform)
#
# Cost-optimized setup for first customer / test deployment:
#   - PostgreSQL Flexible Server (always-on, ~25 EUR/mo)
#   - Container Apps with scale-to-zero (backend, frontend, neo4j, etl)
#   - NO Redis (app falls back to in-memory cache + inline jobs)
#   - Azure Blob Storage, Key Vault, ACR, App Insights
#
# Idle cost: ~30 EUR/month  |  Active: ~50-60 EUR/month
#
# Usage:
#   cd infra
#   terraform init
#   terraform plan -var-file="prod.tfvars"
#   terraform apply -var-file="prod.tfvars"
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.100"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Uncomment to use remote state in Azure Storage (recommended for production)
  # backend "azurerm" {
  #   resource_group_name  = "databridge-tfstate-rg"
  #   storage_account_name = "databridgetfstate"
  #   container_name       = "tfstate"
  #   key                  = "prod.terraform.tfstate"
  # }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Data sources
# ─────────────────────────────────────────────────────────────────────────────

data "azurerm_client_config" "current" {}

# Random suffix for globally-unique resource names (ACR, Key Vault)
resource "random_string" "suffix" {
  length  = 6
  lower   = true
  upper   = false
  special = false
  numeric = true
}

# ─────────────────────────────────────────────────────────────────────────────
# Resource Group
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_resource_group" "main" {
  name     = "${var.project_name}-${var.environment}-rg"
  location = var.location
  tags     = var.tags
}

# ─────────────────────────────────────────────────────────────────────────────
# Log Analytics + Application Insights
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_log_analytics_workspace" "main" {
  name                = "${var.project_name}-${var.environment}-logs"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

resource "azurerm_application_insights" "main" {
  name                = "${var.project_name}-${var.environment}-insights"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "Node.JS"
  tags                = var.tags
}

# ─────────────────────────────────────────────────────────────────────────────
# Azure Container Registry
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_container_registry" "main" {
  name                = "${replace("${var.project_name}${var.environment}", "-", "")}acr${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = true
  tags                = var.tags
}

# ─────────────────────────────────────────────────────────────────────────────
# PostgreSQL Flexible Server  (~25 EUR/month — always on)
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "${var.project_name}-${var.environment}-pg"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  version                       = "16"
  administrator_login           = var.pg_admin_user
  administrator_password        = var.pg_admin_password
  storage_mb                    = 32768
  sku_name                      = var.pg_sku
  backup_retention_days         = 7
  geo_redundant_backup_enabled  = false
  public_network_access_enabled = true
  tags                          = var.tags

  lifecycle {
    ignore_changes = [zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "main" {
  name      = "databridge"
  server_id = azurerm_postgresql_flexible_server.main.id
  collation = "en_US.utf8"
  charset   = "utf8"
}

# Allow Azure services to connect (Container Apps → Postgres)
resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_azure" {
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# Allow your local machines to run migrations (set IPs in tfvars)
resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_local" {
  count            = length(var.local_ips)
  name             = "AllowLocalDev-${count.index}"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = var.local_ips[count.index]
  end_ip_address   = var.local_ips[count.index]
}

# ─────────────────────────────────────────────────────────────────────────────
# Azure Blob Storage (warehouse / parquet files + Neo4j data)
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_storage_account" "warehouse" {
  name                     = replace("${var.project_name}${var.environment}st", "-", "")
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
  tags                     = var.tags
}

resource "azurerm_storage_container" "warehouse" {
  name                  = "warehouse"
  storage_account_name  = azurerm_storage_account.warehouse.name
  container_access_type = "private"
}

resource "azurerm_storage_share" "neo4j_data" {
  name                 = "neo4j-data"
  storage_account_name = azurerm_storage_account.warehouse.name
  quota                = 5
}

# ─────────────────────────────────────────────────────────────────────────────
# Azure Key Vault
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_key_vault" "main" {
  name                       = "db-${var.environment}-kv-${random_string.suffix.result}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  soft_delete_retention_days = 7
  purge_protection_enabled   = false
  tags                       = var.tags

  access_policy {
    tenant_id = data.azurerm_client_config.current.tenant_id
    object_id = data.azurerm_client_config.current.object_id

    secret_permissions = ["Get", "List", "Set", "Delete", "Purge"]
  }
}

resource "azurerm_key_vault_secret" "jwt_secret" {
  name         = "jwt-secret"
  value        = var.jwt_secret
  key_vault_id = azurerm_key_vault.main.id
}

resource "azurerm_key_vault_secret" "anthropic_api_key" {
  name         = "anthropic-api-key"
  value        = var.anthropic_api_key
  key_vault_id = azurerm_key_vault.main.id
}

resource "azurerm_key_vault_secret" "credentials_encryption_key" {
  name         = "credentials-encryption-key"
  value        = var.credentials_encryption_key
  key_vault_id = azurerm_key_vault.main.id
}

# ─────────────────────────────────────────────────────────────────────────────
# Container Apps Environment
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_container_app_environment" "main" {
  name                       = "${var.project_name}-${var.environment}-env"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  tags                       = var.tags
}

# Persistent storage for Neo4j data
# Redis Container App — required for BullMQ queues + repeatable jobs.
# Without Redis: scheduled transformations, scheduled email reports, AND the
# new scheduled connection syncs are all dormant. Adding it as a Container
# App is much cheaper than Azure Cache for Redis (~€10/mo vs €16+/mo) and
# the data we cache is non-durable (queue state survives restarts via the
# durable BullMQ persistence model + Postgres records of in-flight runs).
resource "azurerm_container_app" "redis" {
  name                         = "${var.project_name}-${var.environment}-redis"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = var.tags

  template {
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "redis"
      image  = "redis:7-alpine"
      cpu    = 0.25
      memory = "0.5Gi"

      # Defaults are fine — BullMQ doesn't need any special config.
      # Persistence is intentionally OFF (no AOF/RDB) — queue state is
      # recoverable from Postgres + the orchestrator's idempotency.
      command = ["redis-server", "--save", "", "--appendonly", "no"]
    }
  }

  # Internal-only ingress: nothing outside the Container Apps env can hit it.
  ingress {
    external_enabled           = false
    target_port                = 6379
    transport                  = "tcp"
    exposed_port               = 6379
    allow_insecure_connections = true

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

resource "azurerm_container_app_environment_storage" "neo4j_data" {
  name                         = "neo4jdata"
  container_app_environment_id = azurerm_container_app_environment.main.id
  account_name                 = azurerm_storage_account.warehouse.name
  share_name                   = azurerm_storage_share.neo4j_data.name
  access_key                   = azurerm_storage_account.warehouse.primary_access_key
  access_mode                  = "ReadWrite"
}

# ─────────────────────────────────────────────────────────────────────────────
# Container App — Neo4j  (scale-to-zero, ~0 EUR idle)
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_container_app" "neo4j" {
  name                         = "${var.project_name}-${var.environment}-neo4j"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = var.tags

  template {
    min_replicas = 1
    max_replicas = 1

    volume {
      name         = "neo4j-data"
      storage_name = azurerm_container_app_environment_storage.neo4j_data.name
      storage_type = "AzureFile"
    }

    container {
      name   = "neo4j"
      image  = "neo4j:5-community"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "NEO4J_AUTH"
        value = "neo4j/${var.neo4j_password}"
      }
      env {
        name  = "NEO4J_PLUGINS"
        value = "[]"
      }
      env {
        name  = "NEO4J_dbms_memory_heap_initial__size"
        value = "256m"
      }
      env {
        name  = "NEO4J_dbms_memory_heap_max__size"
        value = "512m"
      }

      volume_mounts {
        name = "neo4j-data"
        path = "/data"
      }

      liveness_probe {
        transport               = "HTTP"
        path                    = "/"
        port                    = 7474
        interval_seconds        = 15
        failure_count_threshold = 10
      }

      readiness_probe {
        transport               = "HTTP"
        path                    = "/"
        port                    = 7474
        interval_seconds        = 10
        failure_count_threshold = 10
      }
    }
  }

  ingress {
    external_enabled = false
    target_port      = 7687
    transport        = "tcp"
    exposed_port     = 7687

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Container App — ETL  (scale-to-zero, ~0 EUR idle)
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_container_app" "etl" {
  name                         = "${var.project_name}-${var.environment}-etl"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = var.tags

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  secret {
    name  = "storage-connection-string"
    value = azurerm_storage_account.warehouse.primary_connection_string
  }

  template {
    min_replicas = 0
    max_replicas = 1

    container {
      name   = "etl"
      image  = "${azurerm_container_registry.main.login_server}/databridge-etl:main-latest"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "WAREHOUSE_ROOT"
        value = "/warehouse"
      }
      env {
        name        = "AZURE_STORAGE_CONNECTION_STRING"
        secret_name = "storage-connection-string"
      }
      env {
        name  = "AZURE_STORAGE_CONTAINER"
        value = "warehouse"
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/health"
        port      = 8000
      }
    }
  }

  ingress {
    external_enabled = false
    target_port      = 8000
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Container App — Backend  (scale-to-zero, ~0 EUR idle)
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_container_app" "backend" {
  name                         = "${var.project_name}-${var.environment}-backend"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = var.tags

  # System-assigned managed identity — used by:
  #   • BlobSasTokenIssuer to mint user-delegation SAS for the warehouse +
  #     heartbeat containers (no Storage account key handling)
  #   • AzureContainerAppsJobLauncher to start sync-worker job executions
  identity {
    type = "SystemAssigned"
  }

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  secret {
    name  = "database-url"
    value = "postgresql://${var.pg_admin_user}:${var.pg_admin_password}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/databridge?sslmode=require"
  }

  secret {
    name  = "jwt-secret"
    value = var.jwt_secret
  }

  secret {
    name  = "anthropic-api-key"
    value = var.anthropic_api_key
  }

  secret {
    name  = "credentials-encryption-key"
    value = var.credentials_encryption_key
  }

  secret {
    name  = "storage-connection-string"
    value = azurerm_storage_account.warehouse.primary_connection_string
  }

  secret {
    name  = "neo4j-password"
    value = var.neo4j_password
  }

  template {
    min_replicas = 0
    max_replicas = 3

    container {
      name   = "backend"
      image  = "${azurerm_container_registry.main.login_server}/databridge-backend:main-latest"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "PORT"
        value = "3001"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
      env {
        name        = "JWT_SECRET"
        secret_name = "jwt-secret"
      }
      env {
        name  = "JWT_EXPIRES_IN"
        value = "8h"
      }
      env {
        name        = "ANTHROPIC_API_KEY"
        secret_name = "anthropic-api-key"
      }
      env {
        name  = "CLAUDE_MODEL"
        value = "claude-sonnet-4-6"
      }
      env {
        name        = "CREDENTIALS_ENCRYPTION_KEY"
        secret_name = "credentials-encryption-key"
      }
      # No REDIS_URL — app uses in-memory cache + inline job execution
      env {
        name        = "AZURE_STORAGE_CONNECTION_STRING"
        secret_name = "storage-connection-string"
      }
      env {
        name  = "AZURE_KEY_VAULT_URL"
        value = azurerm_key_vault.main.vault_uri
      }
      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = azurerm_application_insights.main.connection_string
      }
      env {
        name  = "CORS_ORIGIN"
        value = var.frontend_url
      }
      # Neo4j — internal Container App DNS
      env {
        name  = "NEO4J_URI"
        value = "bolt://${azurerm_container_app.neo4j.name}:7687"
      }
      env {
        name  = "NEO4J_USER"
        value = "neo4j"
      }
      env {
        name        = "NEO4J_PASSWORD"
        secret_name = "neo4j-password"
      }
      env {
        name  = "NEO4J_DATABASE"
        value = "neo4j"
      }
      # ETL — internal Container App DNS
      env {
        name  = "ETL_URL"
        value = "http://${azurerm_container_app.etl.name}"
      }
      env {
        name  = "AZURE_STORAGE_CONTAINER"
        value = "warehouse"
      }

      liveness_probe {
        transport               = "HTTP"
        path                    = "/api/ping"
        port                    = 3001
        interval_seconds        = 30
        failure_count_threshold = 10
      }

      readiness_probe {
        transport               = "HTTP"
        path                    = "/api/ping"
        port                    = 3001
        interval_seconds        = 10
        failure_count_threshold = 10
      }

      # ─── Source-connector platform env (Day 5/6) ──────────────────────
      # When AZURE_CONTAINER_APPS_JOB_NAME is set, the SyncOrchestrator
      # routes syncs to ephemeral Container Apps Job executions instead
      # of in-process. The other vars below are only consulted in that
      # branch — leave them set unconditionally so flipping the launcher
      # is a single env-var change.
      env {
        name  = "AZURE_SUBSCRIPTION_ID"
        value = data.azurerm_client_config.current.subscription_id
      }
      env {
        name  = "AZURE_RESOURCE_GROUP"
        value = azurerm_resource_group.main.name
      }
      env {
        name  = "AZURE_CONTAINER_APPS_JOB_NAME"
        value = azurerm_container_app_job.sync_worker.name
      }
      env {
        name  = "AZURE_WAREHOUSE_STORAGE_ACCOUNT"
        value = azurerm_storage_account.warehouse.name
      }
      env {
        name  = "AZURE_WAREHOUSE_CONTAINER"
        value = azurerm_storage_container.warehouse.name
      }
      env {
        name  = "AZURE_HEARTBEAT_STORAGE_ACCOUNT"
        value = azurerm_storage_account.warehouse.name
      }
      env {
        name  = "AZURE_HEARTBEAT_CONTAINER"
        value = azurerm_storage_container.sync_heartbeat.name
      }
      # Redis — enables BullMQ queues (scheduled syncs, scheduled
      # transformations, scheduled email reports). Internal-only Container
      # App in the same env, addressed by its app name.
      env {
        name  = "REDIS_URL"
        value = "redis://${azurerm_container_app.redis.name}:6379"
      }
      # OAuth callback base — providers (ExactOnline / NetSuite / etc.) verify
      # that the redirect_uri sent on /auth matches the one sent on /token, and
      # the URL must be pre-registered in the customer's app registration.
      # Pinning to the deployed backend's external URL means the URL never
      # surprises the customer — same value across replicas, same value over
      # time. See routes/sources.ts:computeRedirectUri.
      env {
        name  = "OAUTH_REDIRECT_BASE_URL"
        value = "https://${var.project_name}-${var.environment}-backend.${azurerm_container_app_environment.main.default_domain}"
      }
      # OAuth completion bounces the popup through the FRONTEND domain
      # (/setup/oauth-return) so that postMessage to the wizard runs
      # same-origin — cross-origin window.opener access is unreliable
      # after the popup has passed through a third-party auth screen.
      env {
        name  = "FRONTEND_BASE_URL"
        value = "https://${var.project_name}-${var.environment}-frontend.${azurerm_container_app_environment.main.default_domain}"
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3001
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Sync-worker Container App Job (Day 6 — container-per-sync isolation)
# ─────────────────────────────────────────────────────────────────────────────
# An ephemeral container is spun up per sync execution. The orchestrator
# triggers it via Mgmt API, passing per-execution env vars (decrypted creds,
# warehouse SAS, heartbeat SAS). Container exits cleanly after the sync;
# memory dies with it. No DataBridge DB credentials, no shared state.

resource "azurerm_storage_container" "sync_heartbeat" {
  name                  = "sync-heartbeat"
  storage_account_name  = azurerm_storage_account.warehouse.name
  container_access_type = "private"
}

resource "azurerm_container_app_job" "sync_worker" {
  name                         = "${var.project_name}-${var.environment}-sync-worker"
  location                     = azurerm_resource_group.main.location
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  tags                         = var.tags

  # Hard cap. Longest sync we expect today is ~10 min (TransactionLines
  # filtered to FY2025); 30-min ceiling gives plenty of headroom.
  replica_timeout_in_seconds = 1800
  # No auto-retry — orchestrator persists the failure and the user can
  # re-trigger manually. Auto-retry without idempotency = duplicate writes.
  replica_retry_limit = 0

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }
  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  template {
    container {
      name   = "sync-worker"
      image  = "${azurerm_container_registry.main.login_server}/databridge-sync-worker:main-latest"
      cpu    = 0.5
      memory = "1Gi"

      # No env block here — every var is supplied per-execution by the
      # orchestrator's Mgmt API call. Setting them here would shadow that.
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Role assignments — wire backend's managed identity to the perms it needs
# ─────────────────────────────────────────────────────────────────────────────
# Backend → Storage: issue user-delegation SAS for warehouse + heartbeat
# (the SAS URLs are then handed to the worker — worker never sees an
# account key). Reading the heartbeat blob also goes through this identity.
resource "azurerm_role_assignment" "backend_blob_contributor" {
  scope                = azurerm_storage_account.warehouse.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_container_app.backend.identity[0].principal_id
}

# Backend → Container App Job: start + stop executions, read execution status.
# `Container Apps Jobs Operator` is the minimum role; `Contributor` works too
# but is broader.
resource "azurerm_role_assignment" "backend_job_operator" {
  scope                = azurerm_container_app_job.sync_worker.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_container_app.backend.identity[0].principal_id
}

# ─────────────────────────────────────────────────────────────────────────────
# Container App — Frontend  (scale-to-zero, ~0 EUR idle)
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_container_app" "frontend" {
  name                         = "${var.project_name}-${var.environment}-frontend"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = var.tags

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  template {
    min_replicas = 0
    max_replicas = 3

    container {
      name   = "frontend"
      image  = "${azurerm_container_registry.main.login_server}/databridge-frontend:main-latest"
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# DNS zone (optional — only created if custom_domain is set)
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_dns_zone" "main" {
  count               = var.custom_domain != "" ? 1 : 0
  name                = var.custom_domain
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}
