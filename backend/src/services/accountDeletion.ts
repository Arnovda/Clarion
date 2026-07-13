/**
 * Account deletion — GDPR erasure for a user and full purge for a tenant.
 *
 * Two operations:
 *   • eraseUser        — anonymise a single user's PII and hard-delete their
 *                        credential side-tables. Anonymisation (not row
 *                        delete) because ~dozens of tables FK to users.id;
 *                        scrubbing the PII satisfies erasure while keeping
 *                        referential integrity.
 *   • purgeTenant      — delete ALL of a tenant's data across every
 *                        tenant-scoped table, its warehouse, and its graph.
 *                        The `tenants` row is kept but scrubbed + tombstoned
 *                        (status='deleted') — with every user gone, login is
 *                        impossible, and keeping the parent row avoids the
 *                        FK-parent-delete privilege problem.
 *
 * Both are irreversible. The HTTP surface guards them (self, last-admin, and
 * re-auth / name-confirmation checks) — this module just does the work.
 */

import type { Knex } from 'knex';
import { setTenantContext } from '../db/tenantContext';
import { safeQuery } from '../db/safeQuery';
import { deleteTenantGraph } from '../db/semanticGraph';
import {
  perTenantContainersActive,
  deleteTenantWarehouseContainer,
  deleteWarehousePaths,
  warehouseRoot,
} from './warehouse';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'account-deletion' });

// ─── User erasure ──────────────────────────────────────────────────────────

export interface EraseUserResult {
  anonymisedEmail: string;
}

/**
 * Anonymise a user and drop their credential side-tables. Runs in one
 * transaction, tenant-scoped so RLS confines every write to the caller's
 * tenant. Caller must have verified authority (admin) and the safety rules
 * (not self, not the last admin) BEFORE calling.
 */
export async function eraseUser(
  db: Knex,
  tenantId: number,
  userId: number,
): Promise<EraseUserResult> {
  const anonymisedEmail = `deleted-user-${userId}@deleted.invalid`;
  await db.transaction(async (trx) => {
    await setTenantContext(trx, tenantId);

    // Hard-delete pure-PII / credential rows (safe — nothing FKs to these).
    await trx('refresh_tokens').where({ user_id: userId }).del();
    await trx('webauthn_credentials').where({ user_id: userId }).del();
    await trx('mfa_backup_codes').where({ user_id: userId }).del();

    // Anonymise the user row: strip PII, disable login, clear MFA/password.
    await trx('users').where({ id: userId }).update({
      email: anonymisedEmail,
      display_name: 'Deleted user',
      password_hash: '',
      is_active: false,
      mfa_secret: null,
      mfa_enabled_at: null,
      avatar_url: null,
      updated_at: new Date().toISOString(),
    });
  });
  log.info({ userId, tenantId }, 'user erased (anonymised)');
  return { anonymisedEmail };
}

// ─── Tenant purge ────────────────────────────────────────────────────────────

export interface PurgeTenantResult {
  tablesCleared: number;
  rowsDeleted: number;
  warehouse: 'deleted' | 'partial' | 'skipped';
  graph: 'deleted' | 'failed' | 'skipped';
}

/** Tables we must NOT bulk-delete by tenant even though the loop discovers them. */
const PURGE_SKIP = new Set<string>([
  // knex migration bookkeeping never carries tenant data
  'knex_migrations',
  'knex_migrations_lock',
]);

/**
 * Purge every row belonging to a tenant, then its warehouse + graph. The
 * `tenants` row is scrubbed and tombstoned rather than deleted.
 *
 * Deletion order across the ~60 tenant-scoped tables is resolved by an
 * iterative pass: each table's delete is attempted inside a SAVEPOINT
 * (`safeQuery`), and a table blocked by a child FK is retried on the next
 * pass once its referrers are gone. If a pass makes no progress while tables
 * remain, we throw — the whole transaction rolls back, so a tenant is never
 * left half-purged.
 */
export async function purgeTenant(db: Knex, tenantId: number): Promise<PurgeTenantResult> {
  // 1. Collect graph scoping ids BEFORE deleting the Postgres rows.
  const connIds = (await db('connections').where({ tenant_id: tenantId }).select('id'))
    .map((r: { id: number }) => r.id);
  const productIds = (await db('data_products').where({ tenant_id: tenantId }).select('id'))
    .map((r: { id: number }) => r.id);

  // 2. Postgres: iterative FK-safe delete in ONE transaction.
  let rowsDeleted = 0;
  const cleared = new Set<string>();
  await db.transaction(async (trx) => {
    await setTenantContext(trx, tenantId);

    // Discover every tenant-scoped table (has a tenant_id column).
    const rows = await trx.raw(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
    );
    const tables: string[] = (rows.rows as Array<{ table_name: string }>)
      .map((r) => r.table_name)
      .filter((t) => !PURGE_SKIP.has(t));

    let remaining = new Set(tables);
    // Bounded by table count; each pass must delete ≥1 table or we stop.
    for (let pass = 0; pass < tables.length + 1 && remaining.size > 0; pass++) {
      let progressed = false;
      for (const table of [...remaining]) {
        // safeQuery wraps the delete in a SAVEPOINT: an FK violation rolls
        // back to the savepoint (returns null) instead of poisoning the txn.
        const n = await safeQuery(
          trx,
          (t) => t(table).where({ tenant_id: tenantId }).del(),
          null as number | null,
        );
        if (n !== null) {
          rowsDeleted += n;
          cleared.add(table);
          remaining.delete(table);
          progressed = true;
        }
      }
      if (!progressed) break;
    }

    if (remaining.size > 0) {
      throw new Error(
        `Tenant purge could not clear: ${[...remaining].join(', ')} (FK cycle or external reference)`,
      );
    }

    // Scrub + tombstone the tenant row (kept, not deleted).
    await trx('tenants').where({ id: tenantId }).update({
      name: `deleted-tenant-${tenantId}`,
      slug: `deleted-${tenantId}`,
      status: 'deleted',
      updated_at: new Date().toISOString(),
    });
  });

  // 3. Warehouse (best-effort, outside the PG transaction).
  let warehouse: PurgeTenantResult['warehouse'] = 'skipped';
  try {
    if (perTenantContainersActive()) {
      const deleted = await deleteTenantWarehouseContainer(tenantId);
      warehouse = deleted ? 'deleted' : 'skipped';
    } else {
      // Shared container / local FS: the tenant's data lives under a
      // `tenant_<id>` prefix beneath the warehouse root.
      const root = warehouseRoot(tenantId);
      const res = await deleteWarehousePaths([`${root}/tenant_${tenantId}`]);
      warehouse = res.errors.length > 0 ? 'partial' : 'deleted';
    }
  } catch (err) {
    log.warn({ err, tenantId }, 'warehouse purge failed (data rows already deleted)');
    warehouse = 'partial';
  }

  // 4. Neo4j graph (best-effort).
  let graph: PurgeTenantResult['graph'] = 'skipped';
  try {
    await deleteTenantGraph(connIds, productIds);
    graph = 'deleted';
  } catch (err) {
    log.warn({ err, tenantId }, 'graph purge failed (data rows already deleted)');
    graph = 'failed';
  }

  log.info({ tenantId, tablesCleared: cleared.size, rowsDeleted, warehouse, graph }, 'tenant purged');
  return { tablesCleared: cleared.size, rowsDeleted, warehouse, graph };
}
