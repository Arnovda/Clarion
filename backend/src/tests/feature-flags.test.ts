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
import { CURRENT_RELEASE, FEATURE_FLAGS, featureMeta, daysFullyReleased, gateIsRemovable, type FeatureKey } from '../shared/contract';

// THE SUITE REGISTERS ITS OWN KEY rather than borrowing a real product flag.
// It used to use `preview_banner`, which meant retiring that flag took the
// whole flag-machinery suite with it — the tests were coupled to what happened
// to be shipping rather than to the mechanism they test. The registry is empty
// today (nothing is gated), and these still run.
const FLAG = 'test_release' as FeatureKey;
const UNKNOWN = 'not_a_real_flag';   // a key nothing ever declares

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

  // Declare the suite's own flag for the duration of the run. The console
  // route refuses any key that is not in the registry — correctly, since a
  // typo must never mint a flag that is off forever — so the routes need a
  // real entry to exercise. Registering one here rather than borrowing a
  // product flag keeps the mechanism tested no matter what is shipping.
  (FEATURE_FLAGS as Record<string, unknown>)[FLAG] = {
    kind: 'release',
    name: 'Test release',
    description: 'Only exists while this suite runs.',
  };
});

afterAll(async () => {
  delete (FEATURE_FLAGS as Record<string, unknown>)[FLAG];
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

  it('an orphan row cannot enable anything, and is not shown', async () => {
    // A row left behind by a flag that was deleted from the code registry.
    await setFlagRollout(getTestDb(), UNKNOWN, 'all', [], 'op@test');
    invalidateFeatureFlagCache();
    const features = await getFeaturesForTenant(tenantA, getTestDb());
    expect(features[UNKNOWN]).toBeUndefined();

    // It also stays off the console: it enables nothing, so showing it would
    // put a code-cleanup chore on a screen for choosing an audience.
    const agent = await request();
    const list = await agent
      .get('/api/admin/feature-flags')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(list.body.data.flags.some((f: { key: string }) => f.key === UNKNOWN)).toBe(false);
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
    const row = list.body.data.flags.find((f: { key: string }) => f.key === FLAG);
    expect(row).toBeDefined();
    // The screen renders `name`; a flag that shipped without one would show a
    // developer key like `preview_banner` to whoever is choosing an audience.
    expect(typeof row.name).toBe('string');
    expect(row.name.length).toBeGreaterThan(0);
    // `kind` drives which rows the console queues for an audience decision.
    // Missing or misspelled, a shipped release stops appearing in the "live
    // but nobody can see it" banner — the one thing that says work is waiting.
    expect(['release', 'feature']).toContain(row.kind);

    const put = await agent
      .put(`/api/admin/feature-flags/${FLAG}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ rollout: 'tenants', tenantIds: [tenantA] });
    expect(put.status).toBe(200);

    invalidateFeatureFlagCache();
    expect(await isFeatureEnabled(tenantA, FLAG, getTestDb())).toBe(true);
  });

  it('CURRENT_RELEASE is either null or names a real release', () => {
    // Two legitimate states, and the test has to allow both. NULL means no
    // train is open, which is where this deployment sits deliberately while it
    // has no customers: work ships to everyone. A STRING means a train is open
    // and it is the key the next gate should name — pointing it at a key that
    // does not exist would send the next person to write a gate that resolves
    // false for every tenant, i.e. a silent, total rollout failure with nothing
    // on screen to explain it. What must never happen is the third state: a
    // name that looks real and is not.
    if (CURRENT_RELEASE === null) return;
    const entry = (FEATURE_FLAGS as Record<string, { kind: string } | undefined>)[CURRENT_RELEASE];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('release');
  });

  // ── the end of a release's life ───────────────────────────────────────────
  //
  // A release toggle that is never removed is the standard way a flag system
  // rots, and the only reliable defence is for the console to SAY when one is
  // finished rather than trust anyone to notice. These are the rules it says
  // it by. Pure, so they run without touching the database.
  describe('lifecycle reporting', () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

    it('reports how long everyone has had a release, and when the gate is dead code', () => {
      const old = { kind: 'release' as const, rollout: 'all' as const, updated_at: daysAgo(30) };
      expect(daysFullyReleased(old)).toBe(30);
      expect(gateIsRemovable(old)).toBe(true);

      const fresh = { kind: 'release' as const, rollout: 'all' as const, updated_at: daysAgo(2) };
      expect(daysFullyReleased(fresh)).toBe(2);
      expect(gateIsRemovable(fresh)).toBe(false);
    });

    it('says nothing about a release that is not out to everyone', () => {
      // Mid-rollout is not "finished slowly" — it is a different state, and
      // advising removal there would delete a gate still doing its job.
      for (const rollout of ['off', 'tenants'] as const) {
        const f = { kind: 'release' as const, rollout, updated_at: daysAgo(90) };
        expect(daysFullyReleased(f)).toBeNull();
        expect(gateIsRemovable(f)).toBe(false);
      }
    });

    it('never advises removing a standing feature', () => {
      // `kind: 'feature'` is a permanent capability, not scaffolding. Counting
      // it here would put a permanent "this can be deleted" note against
      // something that must not be.
      const f = { kind: 'feature' as const, rollout: 'all' as const, updated_at: daysAgo(365) };
      expect(daysFullyReleased(f)).toBeNull();
      expect(gateIsRemovable(f)).toBe(false);
    });

    it('treats a missing or unparseable timestamp as "do not know"', () => {
      // A row written before this column meant anything, or a corrupted value.
      // Guessing would be worse than staying quiet.
      expect(daysFullyReleased({ kind: 'release', rollout: 'all', updated_at: null })).toBeNull();
      expect(daysFullyReleased({ kind: 'release', rollout: 'all', updated_at: 'not a date' })).toBeNull();
    });
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
