import { semanticDb } from '../db/knex';
import { logger } from '../utils/logger';

/**
 * Auto-approve stale AI drafts for a given tenant.
 *
 * Checks the tenant's auto_approve_ai_drafts and auto_approve_delay_days settings.
 * If enabled, finds all source_tables, source_columns, and kpi_definitions where:
 *   - ai_draft = true
 *   - approval_status IN ('pending', 'draft', NULL)
 *   - created_at < NOW() - delay_days
 *
 * Updates them to: ai_draft = false, approval_status = 'approved',
 * approved_by = NULL (system), approved_at = NOW()
 *
 * Safe to call multiple times (idempotent).
 *
 * @returns count of auto-approved items
 */
export async function autoApproveStaleDrafts(tenantId: number): Promise<number> {
  // Look up tenant settings
  const tenant = await semanticDb('tenants').where({ id: tenantId }).first();
  if (!tenant) return 0;

  if (!tenant.auto_approve_ai_drafts) return 0;

  const delayDays = tenant.auto_approve_delay_days ?? 7;
  const cutoff = new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  let total = 0;

  // Auto-approve source_tables
  const tablesUpdated = await semanticDb('source_tables')
    .where('tenant_id', tenantId)
    .where('ai_draft', true)
    .where(function () {
      this.whereNull('approval_status')
        .orWhereIn('approval_status', ['pending', 'draft', 'pending_review']);
    })
    .where('created_at', '<', cutoff)
    .update({
      ai_draft: false,
      approval_status: 'approved',
      approved_by: null,
      approved_at: now,
    });
  total += tablesUpdated;

  // Auto-approve source_columns
  const columnsUpdated = await semanticDb('source_columns')
    .where('tenant_id', tenantId)
    .where('ai_draft', true)
    .where(function () {
      this.whereNull('approval_status')
        .orWhereIn('approval_status', ['pending', 'draft', 'pending_review']);
    })
    .where('created_at', '<', cutoff)
    .update({
      ai_draft: false,
      approval_status: 'approved',
      approved_by: null,
      approved_at: now,
    });
  total += columnsUpdated;

  // Auto-approve kpi_definitions
  const kpisUpdated = await semanticDb('kpi_definitions')
    .where('tenant_id', tenantId)
    .where('ai_draft', true)
    .where(function () {
      this.whereNull('approval_status')
        .orWhereIn('approval_status', ['pending', 'draft', 'pending_review']);
    })
    .where('created_at', '<', cutoff)
    .update({
      ai_draft: false,
      approval_status: 'approved',
      approved_by: null,
      approved_at: now,
    });
  total += kpisUpdated;

  if (total > 0) {
    logger.info({ tenantId, total, tablesUpdated, columnsUpdated, kpisUpdated },
      `[auto-approve] Auto-approved ${total} stale AI draft(s) for tenant ${tenantId}`);
  }

  return total;
}

/**
 * Run auto-approve across ALL tenants that have the setting enabled.
 * Designed to be called on startup and periodically.
 */
export async function autoApproveAllTenants(): Promise<number> {
  const tenants = await semanticDb('tenants')
    .where('auto_approve_ai_drafts', true)
    .where('status', 'active')
    .select('id');

  let grandTotal = 0;
  for (const t of tenants) {
    try {
      const count = await autoApproveStaleDrafts(t.id);
      grandTotal += count;
    } catch (err) {
      logger.error({ tenantId: t.id, err }, '[auto-approve] Error processing tenant');
    }
  }

  return grandTotal;
}
