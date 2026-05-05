import { semanticDb } from '../db/knex';

export type NotificationType = 'job_complete' | 'quality_alert' | 'new_gap' | 'invite_accepted' | 'approval' | 'morning_brief';

interface CreateNotification {
  tenantId: number;
  userId: number;
  type: NotificationType;
  title: string;
  message?: string;
  entityType?: string;
  entityId?: number;
  link?: string;
}

/**
 * Create a single notification for one user.
 */
export async function notify(n: CreateNotification): Promise<void> {
  await semanticDb('notifications').insert({
    tenant_id: n.tenantId,
    user_id: n.userId,
    type: n.type,
    title: n.title,
    message: n.message ?? null,
    entity_type: n.entityType ?? null,
    entity_id: n.entityId ?? null,
    link: n.link ?? null,
  });
}

/**
 * Notify all users in a tenant (e.g. quality alert).
 * Optionally exclude a specific user (e.g. the one who triggered the action).
 */
export async function notifyTenant(
  tenantId: number,
  type: NotificationType,
  title: string,
  opts?: { message?: string; entityType?: string; entityId?: number; link?: string; excludeUserId?: number },
): Promise<void> {
  const users = await semanticDb('users')
    .where({ tenant_id: tenantId, is_active: true })
    .select('id');

  const rows = users
    .filter((u: { id: number }) => u.id !== opts?.excludeUserId)
    .map((u: { id: number }) => ({
      tenant_id: tenantId,
      user_id: u.id,
      type,
      title,
      message: opts?.message ?? null,
      entity_type: opts?.entityType ?? null,
      entity_id: opts?.entityId ?? null,
      link: opts?.link ?? null,
    }));

  if (rows.length > 0) {
    await semanticDb('notifications').insert(rows);
  }
}

/**
 * Notify all admins in a tenant.
 */
export async function notifyAdmins(
  tenantId: number,
  type: NotificationType,
  title: string,
  opts?: { message?: string; entityType?: string; entityId?: number; link?: string; excludeUserId?: number },
): Promise<void> {
  const admins = await semanticDb('users')
    .where({ tenant_id: tenantId, is_active: true, role: 'admin' })
    .select('id');

  const rows = admins
    .filter((u: { id: number }) => u.id !== opts?.excludeUserId)
    .map((u: { id: number }) => ({
      tenant_id: tenantId,
      user_id: u.id,
      type,
      title,
      message: opts?.message ?? null,
      entity_type: opts?.entityType ?? null,
      entity_id: opts?.entityId ?? null,
      link: opts?.link ?? null,
    }));

  if (rows.length > 0) {
    await semanticDb('notifications').insert(rows);
  }
}
