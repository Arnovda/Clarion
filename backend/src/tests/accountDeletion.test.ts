import { describe, it, expect } from 'vitest';
import { eraseUser, purgeTenant } from '../services/accountDeletion';
import { semanticDb } from '../db/knex';
import { registerUser } from './helpers';

// Test DB connects as the superuser (RLS-bypassing), so verification queries
// can read across tenants directly. purgeTenant/eraseUser stay correct
// regardless via their explicit tenant_id / id filters.

describe('eraseUser', () => {
  it('anonymises the user and drops credential rows', async () => {
    const { user } = await registerUser();
    // Give the user a refresh token row to prove side-tables are cleared.
    await semanticDb('refresh_tokens').insert({
      tenant_id: user.tenantId, user_id: user.id,
      token_hash: 'x'.repeat(64),
      expires_at: semanticDb.raw(`NOW() + INTERVAL '1 day'`),
    });

    await eraseUser(semanticDb, user.tenantId, user.id);

    const row = await semanticDb('users').where({ id: user.id }).first();
    expect(row.email).toBe(`deleted-user-${user.id}@deleted.invalid`);
    expect(row.display_name).toBe('Deleted user');
    expect(row.is_active).toBe(false);
    expect(row.password_hash).toBe('');

    const tokens = await semanticDb('refresh_tokens').where({ user_id: user.id }).count<{ count: string }[]>('* as count');
    expect(Number(tokens[0].count)).toBe(0);
  });
});

describe('purgeTenant', () => {
  it('deletes all of a tenant\'s data, tombstones the tenant, and leaves other tenants intact', async () => {
    const a = await registerUser();
    const b = await registerUser();

    // Seed some data for tenant A (and one row for B to prove isolation).
    const notif = { type: 'system', title: 't', message: 'm', read: false };
    await semanticDb('notifications').insert({ ...notif, tenant_id: a.user.tenantId, user_id: a.user.id });
    await semanticDb('notifications').insert({ ...notif, tenant_id: b.user.tenantId, user_id: b.user.id });

    const result = await purgeTenant(semanticDb, a.user.tenantId);
    expect(result.tablesCleared).toBeGreaterThan(0);

    // Tenant A: users + notifications gone; tenant row tombstoned.
    const aUsers = await semanticDb('users').where({ tenant_id: a.user.tenantId }).count<{ count: string }[]>('* as count');
    expect(Number(aUsers[0].count)).toBe(0);
    const aNotifs = await semanticDb('notifications').where({ tenant_id: a.user.tenantId }).count<{ count: string }[]>('* as count');
    expect(Number(aNotifs[0].count)).toBe(0);
    const aTenant = await semanticDb('tenants').where({ id: a.user.tenantId }).first();
    expect(aTenant).toBeTruthy();               // row kept
    expect(aTenant.status).toBe('deleted');     // tombstoned
    expect(aTenant.name).toBe(`deleted-tenant-${a.user.tenantId}`);

    // Tenant B: untouched.
    const bUsers = await semanticDb('users').where({ tenant_id: b.user.tenantId }).count<{ count: string }[]>('* as count');
    expect(Number(bUsers[0].count)).toBe(1);
    const bNotifs = await semanticDb('notifications').where({ tenant_id: b.user.tenantId }).count<{ count: string }[]>('* as count');
    expect(Number(bNotifs[0].count)).toBe(1);
    const bTenant = await semanticDb('tenants').where({ id: b.user.tenantId }).first();
    expect(bTenant.status).not.toBe('deleted');

    // cleanup B
    await semanticDb('notifications').where({ tenant_id: b.user.tenantId }).del();
  });
});
