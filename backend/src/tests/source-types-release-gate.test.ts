/**
 * The new spreadsheet connectors ship behind the current release train.
 *
 * Deploying is not releasing: a push reaches production for every tenant at
 * once, so anything a customer can SEE hangs off `CURRENT_RELEASE` until the
 * operator switches it on for them.
 *
 * The third test is the one that matters most. The edit dialog reads an
 * existing connection's config schema from this same catalog, so filtering a
 * gated type away unconditionally would make an already-created source
 * unmanageable the moment the flag moved back off. The carve-out is not a
 * nicety; it is what keeps the gate from being destructive.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { semanticDb } from '../db/knex';
import { invalidateFeatureFlagCache } from '../services/featureFlags';
import { CURRENT_RELEASE } from '../shared/contract';
import { request, registerUser } from './helpers';

async function setRelease(rollout: 'off' | 'all', tenantIds: number[] = []) {
  await semanticDb('feature_flags')
    .insert({ key: CURRENT_RELEASE, rollout, tenant_ids: JSON.stringify(tenantIds) })
    .onConflict('key')
    .merge(['rollout', 'tenant_ids']);
  // The service caches flag state for 20s; without this the second test in a
  // file would read the first one's answer.
  invalidateFeatureFlagCache();
}

describe('source-types catalog is gated on the release train', () => {
  let agent: Awaited<ReturnType<typeof request>>;
  let user: Awaited<ReturnType<typeof registerUser>>;

  beforeEach(async () => {
    agent = await request();
    user = await registerUser({ companyName: `GateCo-${Date.now()}` });
  });

  afterAll(async () => {
    await semanticDb('feature_flags').where({ key: CURRENT_RELEASE }).delete();
    invalidateFeatureFlagCache();
  });

  async function types(): Promise<string[]> {
    const res = await agent.get('/api/source-types').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    return (res.body.data as { type: string }[]).map((t) => t.type);
  }

  it('hides the new connectors from a tenant not on the train', async () => {
    await setRelease('off');
    const listed = await types();
    expect(listed).not.toContain('excel');
    expect(listed).not.toContain('sharepoint');
  });

  it('leaves the established connectors alone', async () => {
    // The gate must never touch what already worked for everybody.
    await setRelease('off');
    const listed = await types();
    expect(listed).toContain('exactonline');
    expect(listed).toContain('odoo');
  });

  it('offers them once the train is on', async () => {
    await setRelease('all');
    const listed = await types();
    expect(listed).toContain('excel');
    expect(listed).toContain('sharepoint');
  });

  it('keeps a gated type a tenant already uses, so it stays manageable', async () => {
    await setRelease('all');
    await semanticDb('connections').insert({
      tenant_id: user.user.tenantId,
      name: 'Budget workbook',
      type: 'duckdb',
      connector_type: 'excel',
      config: JSON.stringify({}),
    });

    // Operator pulls the release back to nobody.
    await setRelease('off');

    const listed = await types();
    // Still listed — the edit dialog reads its config schema from here.
    expect(listed).toContain('excel');
    // But a type they never adopted stays hidden.
    expect(listed).not.toContain('sharepoint');
  });
});
