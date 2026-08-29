/**
 * Feature flags — the deploy/release split.
 *
 * The property that matters most here is unusual for this codebase, and it is
 * why this file exists: `feature_flags` has no `tenant_id` column and
 * therefore NO row-level security behind it. Everywhere else a route bug is
 * still caught by Postgres refusing the row; here the operator gate is the
 * only control. So the refusal direction is tested for every tenant role,
 * including admin — an admin of their own company must not be able to grant
 * themselves unreleased features, or the flag stops being a release mechanism
 * and becomes a settings screen.
 *
 * What must stay true:
 *  1. A flag with no row is OFF. Nothing needs seeding when a key is declared.
 *  2. Rollout resolves per tenant: 'off' nobody, 'tenants' only those listed,
 *     'all' everyone.
 *  3. Only a platform operator (env allowlist) may change a rollout — viewer,
 *     analyst AND admin are all refused, with 404 rather than 403.
 *  4. An empty allowlist means nobody, including an admin. Fail closed.
 *  5. A flag key not in the code registry cannot be created via the API.
 *  6. Naming a tenant that does not exist is rejected, not silently stored.
 *  7. A purged tenant is stripped from every flag's audience — the GDPR purge
 *     enumerates by tenant_id COLUMN and cannot see this table.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { request, registerUser, makeToken } from './helpers';
import { migrateTestDb, closeTestDb, getTestDb } from './db-helpers';
import {
  isFeatureEnabled,
  getFeaturesForTenant,
  setFlagRollout,
  removeTenantFromAllFlags,
  invalidateFeatureFlagCache,
  isPlatformOperator,
} from '../services/featureFlags';

const FLAG = 'preview_banner';       // a key that exists in the registry
const UNKNOWN = 'not_a_real_flag';   // a key that does not

let operatorToken: string;
let adminToken: string;
let analystToken: string;
let viewerToken: string;
let tenantA: number;
let tenantB: number;
let operatorEmail: string;
let savedEnv: string | undefined;

beforeAll(async () => {
  await migrateTestDb();

  const a = await registerUser();
  tenantA = a.user.tenantId;
  adminToken = a.token;
  operatorEmail = `operator-${Date.now()}@test.com`;

  const b = await registerUser();
  tenantB = b.user.tenantId;

  const db = getTestDb();
  async function addUser(role: 'admin' | 'analyst' | 'viewer', email: string) {
    const [row] = await db('users')
      .insert({ tenant_id: tenantA, email, password_hash: 'x', display_name: role, role })
      .returning('id');
    const id = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    return makeToken({ sub: id, tenantId: tenantA, role, email });
  }
  analystToken = await addUser('analyst', `analyst-${Date.now()}@test.com`);
  viewerToken = await addUser('viewer', `viewer-${Date.now()}@test.com`);
  operatorToken = await addUser('admin', operatorEmail);

  savedEnv = process.env.PLATFORM_OPERATOR_EMAILS;
  process.env.PLATFORM_OPERATOR_EMAILS = operatorEmail;
});

afterAll(async () => {
  if (savedEnv === undefined) delete process.env.PLATFORM_OPERATOR_EMAILS;
  else process.env.PLATFORM_OPERATOR_EMAILS = savedEnv;
  await closeTestDb();
});

beforeEach(async () => {
  await getTestDb()('feature_flags').del();
  invalidateFeatureFlagCache();
});

// ─────────────────────────────── resolution ────────────────────────────────

describe('flag resolution', () => {
  it('a flag with no row is off for everyone', async () => {
    expect(await isFeatureEnabled(tenantA, FLAG, getTestDb())).toBe(false);
    expect(await isFeatureEnabled(tenantB, FLAG, getTestDb())).toBe(false);
  });

  it("rollout 'tenants' is on only for the tenants listed", async () => {
    await setFlagRollout(getTestDb(), FLAG, 'tenants', [tenantA], 'op@test');
    invalidateFeatureFlagCache();
    expect(await isFeatureEnabled(tenantA, FLAG, getTestDb())).toBe(true);
    expect(await isFeatureEnabled(tenantB, FLAG, getTestDb())).toBe(false);
  });

  it("rollout 'all' ignores the tenant list; 'off' overrides it", async () => {
    await setFlagRollout(getTestDb(), FLAG, 'all', [], 'op@test');
    invalidateFeatureFlagCache();
    expect(await isFeatureEnabled(tenantB, FLAG, getTestDb())).toBe(true);

    // The audience survives a trip through 'off' — an operator pulling a
    // feature back must not have to rebuild the ring to re-release it.
    await setFlagRollout(getTestDb(), FLAG, 'off', [tenantA], 'op@test');
    invalidateFeatureFlagCache();
    expect(await isFeatureEnabled(tenantA, FLAG, getTestDb())).toBe(false);

    await setFlagRollout(getTestDb(), FLAG, 'tenants', [tenantA], 'op@test');
    invalidateFeatureFlagCache();
    expect(await isFeatureEnabled(tenantA, FLAG, getTestDb())).toBe(true);
  });

  it('reports every registered key, and never an unregistered one', async () => {
    const features = await getFeaturesForTenant(tenantA, getTestDb());
    expect(features).toHaveProperty(FLAG);
    expect(features[FLAG]).toBe(false);
    expect(features).not.toHaveProperty(UNKNOWN);
  });

  it('an orphan row cannot enable anything', async () => {
    // A row left behind by a flag that was deleted from the code registry.
    await setFlagRollout(getTestDb(), UNKNOWN, 'all', [], 'op@test');
    invalidateFeatureFlagCache();
    const features = await getFeaturesForTenant(tenantA, getTestDb());
    expect(features[UNKNOWN]).toBeUndefined();
  });
});

// ──────────────────────────── who may change one ────────────────────────────

describe('the operator gate', () => {
  it('lets the operator read the console and change a rollout', async () => {
    const agent = await request();
    const list = await agent
      .get('/api/admin/feature-flags')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.flags.some((f: { key: string }) => f.key === FLAG)).toBe(true);

    const put = await agent
      .put(`/api/admin/feature-flags/${FLAG}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ rollout: 'tenants', tenantIds: [tenantA] });
    expect(put.status).toBe(200);

    invalidateFeatureFlagCache();
    expect(await isFeatureEnabled(tenantA, FLAG, getTestDb())).toBe(true);
  });

  it.each([
    ['admin', () => adminToken],
    ['analyst', () => analystToken],
    ['viewer', () => viewerToken],
  ])('refuses a tenant %s with 404, and changes nothing', async (_role, token) => {
    const agent = await request();
    expect((await agent.get('/api/admin/feature-flags').set('Authorization', `Bearer ${token()}`)).status).toBe(404);

    const put = await agent
      .put(`/api/admin/feature-flags/${FLAG}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ rollout: 'all', tenantIds: [] });
    expect(put.status).toBe(404);

    invalidateFeatureFlagCache();
    expect(await isFeatureEnabled(tenantA, FLAG, getTestDb())).toBe(false);
  });

  it('with no allowlist configured, nobody is an operator', async () => {
    const prev = process.env.PLATFORM_OPERATOR_EMAILS;
    process.env.PLATFORM_OPERATOR_EMAILS = '';
    try {
      expect(isPlatformOperator(operatorEmail)).toBe(false);
      const agent = await request();
      const res = await agent
        .get('/api/admin/feature-flags')
        .set('Authorization', `Bearer ${operatorToken}`);
      expect(res.status).toBe(404);
    } finally {
      process.env.PLATFORM_OPERATOR_EMAILS = prev;
    }
  });

  it('matches the operator email case-insensitively', () => {
    expect(isPlatformOperator(operatorEmail.toUpperCase())).toBe(true);
    expect(isPlatformOperator(`not-${operatorEmail}`)).toBe(false);
    expect(isPlatformOperator(undefined)).toBe(false);
  });
});

// ───────────────────────────── input soundness ─────────────────────────────

describe('what the console refuses', () => {
  it('will not create a flag that does not exist in the code', async () => {
    const agent = await request();
    const res = await agent
      .put(`/api/admin/feature-flags/${UNKNOWN}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ rollout: 'all', tenantIds: [] });
    expect(res.status).toBe(404);
    expect(await getTestDb()('feature_flags').where({ key: UNKNOWN }).first()).toBeUndefined();
  });

  it('rejects an unknown tenant id rather than storing it', async () => {
    const agent = await request();
    const res = await agent
      .put(`/api/admin/feature-flags/${FLAG}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ rollout: 'tenants', tenantIds: [999_999] });
    expect(res.status).toBe(400);
    expect(await getTestDb()('feature_flags').where({ key: FLAG }).first()).toBeUndefined();
  });

  it('rejects a rollout value outside the ladder', async () => {
    const agent = await request();
    const res = await agent
      .put(`/api/admin/feature-flags/${FLAG}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ rollout: 'everyone-please', tenantIds: [] });
    expect(res.status).toBe(400);
  });

  it('deduplicates and sorts the stored audience', async () => {
    await setFlagRollout(getTestDb(), FLAG, 'tenants', [tenantB, tenantA, tenantB], 'op@test');
    const row = await getTestDb()('feature_flags').where({ key: FLAG }).first();
    const ids = typeof row.tenant_ids === 'string' ? JSON.parse(row.tenant_ids) : row.tenant_ids;
    expect(ids).toEqual([tenantA, tenantB].sort((x, y) => x - y));
  });
});

// ────────────────────────────── tenant purge ───────────────────────────────

describe('tenant purge', () => {
  it('strips the tenant from every flag audience', async () => {
    await setFlagRollout(getTestDb(), FLAG, 'tenants', [tenantA, tenantB], 'op@test');
    await removeTenantFromAllFlags(getTestDb(), tenantB);
    invalidateFeatureFlagCache();

    expect(await isFeatureEnabled(tenantA, FLAG, getTestDb())).toBe(true);
    expect(await isFeatureEnabled(tenantB, FLAG, getTestDb())).toBe(false);
  });
});

// ───────────────────────── the tenant-facing endpoint ──────────────────────

describe('GET /api/features', () => {
  it('answers for the caller tenant only, and reports operator status', async () => {
    await setFlagRollout(getTestDb(), FLAG, 'tenants', [tenantA], 'op@test');
    invalidateFeatureFlagCache();

    const agent = await request();
    const mine = await agent.get('/api/features').set('Authorization', `Bearer ${viewerToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.features[FLAG]).toBe(true);
    expect(mine.body.data.isOperator).toBe(false);

    const op = await agent.get('/api/features').set('Authorization', `Bearer ${operatorToken}`);
    expect(op.body.data.isOperator).toBe(true);
  });

  it('requires authentication', async () => {
    const agent = await request();
    expect((await agent.get('/api/features')).status).toBe(401);
  });
});
