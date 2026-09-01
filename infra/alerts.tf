# Production alerting (P0-6) — the Terraform description of what
# .github/workflows/alerts.yml creates with `az`.
#
# READ THIS BEFORE `terraform apply`: these resources are CREATED BY THE
# WORKFLOW, not by Terraform, for the same reason the jobs-worker app was —
# no Terraform state storage exists in the subscription, so an apply from a
# machine without the (laptop-held) state would try to recreate live
# infrastructure. This file exists so the definitions agree; reconcile with
# `terraform import` for each resource below before the first apply that
# includes them, exactly as infra/main.tf's jobs_worker comment prescribes.
#
# The routing address lives in `.ops/alerts` (GitOps — editing it re-runs the
# workflow); `alert_email` here defaults to the same value and must be kept
# in agreement by hand, the same covenant as WAREHOUSE_CONTAINER_MODE.

variable "alert_email" {
  description = "Where Azure Monitor alerts are sent. Keep in agreement with .ops/alerts."
  type        = string
  default     = "arnovda@telenet.be"
}

resource "azurerm_monitor_action_group" "alerts" {
  name                = "clarion-alerts"
  resource_group_name = azurerm_resource_group.main.name
  short_name          = "clarion"

  email_receiver {
    name          = "owner"
    email_address = var.alert_email
  }
}

resource "azurerm_monitor_metric_alert" "backend_5xx" {
  name                = "clarion-backend-5xx"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.backend.id]
  description         = "Backend served 10+ HTTP 5xx responses in 15 minutes"
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "Requests"
    aggregation      = "Total"
    operator         = "GreaterThanOrEqual"
    threshold        = 10

    dimension {
      name     = "statusCodeCategory"
      operator = "Include"
      values   = ["5xx"]
    }
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts.id
  }
}

resource "azurerm_monitor_metric_alert" "backend_restarts" {
  name                = "clarion-backend-restarts"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.backend.id]
  description         = "Backend container restarted 3+ times in 15 minutes"
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "RestartCount"
    aggregation      = "Total"
    operator         = "GreaterThanOrEqual"
    threshold        = 3
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts.id
  }
}

resource "azurerm_monitor_metric_alert" "worker_restarts" {
  name                = "clarion-worker-restarts"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.jobs_worker.id]
  description         = "Jobs-worker container restarted 3+ times in 15 minutes"
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "RestartCount"
    aggregation      = "Total"
    operator         = "GreaterThanOrEqual"
    threshold        = 3
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts.id
  }
}

resource "azurerm_monitor_metric_alert" "pg_cpu" {
  name                = "clarion-pg-cpu"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Postgres CPU at 90%+ for 15 minutes"
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "cpu_percent"
    aggregation      = "Average"
    operator         = "GreaterThanOrEqual"
    threshold        = 90
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts.id
  }
}

resource "azurerm_monitor_metric_alert" "pg_storage" {
  name                = "clarion-pg-storage"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Postgres storage at 85%+ — act before writes start failing"
  severity            = 1
  frequency           = "PT15M"
  window_size         = "PT30M"

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "storage_percent"
    aggregation      = "Average"
    operator         = "GreaterThanOrEqual"
    threshold        = 85
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts.id
  }
}

# The two log-query rules match strings that are LOAD-BEARING in code:
# 'request failed' (middleware/requestLogger.ts at HTTP >=500) and
# 'sync run failed' (orchestrator/SyncOrchestrator.ts when a run is persisted
# as failed). Both code sites carry a comment pointing back here.

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "server_errors" {
  name                = "clarion-server-errors"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  scopes              = [azurerm_log_analytics_workspace.main.id]
  description         = "5+ server errors (HTTP 5xx log lines) in 15 minutes"
  severity            = 1
  evaluation_frequency = "PT15M"
  window_duration      = "PT15M"

  criteria {
    query                   = <<-KQL
      ContainerAppConsoleLogs_CL
      | where Log_s contains 'request failed'
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThanOrEqual"
    threshold               = 5
  }

  action {
    action_groups = [azurerm_monitor_action_group.alerts.id]
  }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "failed_syncs" {
  name                = "clarion-failed-syncs"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  scopes              = [azurerm_log_analytics_workspace.main.id]
  description         = "A source sync run was persisted as failed"
  severity            = 2
  evaluation_frequency = "PT15M"
  window_duration      = "PT15M"

  criteria {
    query                   = <<-KQL
      ContainerAppConsoleLogs_CL
      | where Log_s contains 'sync run failed'
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThanOrEqual"
    threshold               = 1
  }

  action {
    action_groups = [azurerm_monitor_action_group.alerts.id]
  }
}
