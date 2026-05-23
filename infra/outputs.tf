# ─────────────────────────────────────────────────────────────────────────────
# Outputs — shown after terraform apply
# ─────────────────────────────────────────────────────────────────────────────

output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "acr_admin_username" {
  value     = azurerm_container_registry.main.admin_username
  sensitive = true
}

output "postgres_fqdn" {
  value = azurerm_postgresql_flexible_server.main.fqdn
}

output "postgres_connection_string" {
  value     = "postgresql://${var.pg_admin_user}:${var.pg_admin_password}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/databridge?sslmode=require"
  sensitive = true
}

output "storage_account_name" {
  value = azurerm_storage_account.warehouse.name
}

output "storage_connection_string" {
  value     = azurerm_storage_account.warehouse.primary_connection_string
  sensitive = true
}

output "key_vault_url" {
  value = azurerm_key_vault.main.vault_uri
}

output "app_insights_connection_string" {
  value     = azurerm_application_insights.main.connection_string
  sensitive = true
}

output "backend_url" {
  value = "https://${azurerm_container_app.backend.ingress[0].fqdn}"
}

output "frontend_url" {
  value = "https://${azurerm_container_app.frontend.ingress[0].fqdn}"
}

output "dns_nameservers" {
  value = var.custom_domain != "" ? azurerm_dns_zone.main[0].name_servers : []
}

# ─── Azure Communication Services Email ───────────────────────────────────────
output "acs_endpoint" {
  value       = "https://${azurerm_communication_service.main.name}.communication.azure.com"
  description = "Communication Service data-plane URL. Backend reads as ACS_ENDPOINT and authenticates via Managed Identity."
}

output "acs_sender_address" {
  value       = "donotreply@${azurerm_email_communication_service_domain.azuremanaged.from_sender_domain}"
  description = "Azure-managed sender address used for password reset + scheduled report emails. Replace with a CustomerManaged domain for branded sender."
}
