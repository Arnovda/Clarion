/**
 * P0-5 of the 2026-09-05 market-readiness assessment (v2): the services the
 * jobs-worker calls (SyncOrchestrator, pipelineService, busMatrixOrchestrator,
 * deltaWriter, auditService, notificationService, productGraphSync,
 * autoApproveService) set tenant context with a SESSION-level
 * `SET app.current_tenant` on the shared pool. BullMQ runs jobs from
 * different tenants concurrently, so a query could be handed a pooled
 * connection carrying ANOTHER tenant's id — RLS satisfied, wrong tenant.
 * Every read/write in those files is a short transaction now.
 *
 * The suite's `semanticDb` is the superuser, for whom RLS is inert and the
 * defect is invisible. This file flips DATABASE_URL to `databridge_app`
 * BEFORE the services (and the app) are imported, then drives them with NO
 * ambient tenant context — the exact situation inside a worker. A service
 * still on the bare pool returns zero rows or fails its RLS WITH CHECK here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';

// The superuser handle must be created BEFORE the env flip — db-helpers reads
// DATABASE_URL lazily on first call.
const superDb = getTestDb();
const superUrl = process.env.DATABASE_URL!;
process.env.DATABASE_URL = superUrl.replace(/\/\/[^@]+@/, '//databridge_app:databridge@');

type Svc = {
  notifyAdmins: typeof import('../services/notificationService').notifyAdmins;
  notify: typeof import('../services/notificationService').notify;
  recordSystemAudit: typeof import('../services/auditService').recordSystemAudit;
  autoApproveStaleDrafts: typeof import('../services/autoApproveService').autoApproveStaleDrafts;
  getDag: typeof import('../services/pipelineService').getDag;
  resolveScope: typeof import('../services/pipelineService').resolveScope;
  topoSortProducts: typeof import('../services/pipelineService').topoSortProducts;
  triggerSync: typeof import('../orchestrator/SyncOrchestrator').triggerSync;
  recordTenantAiUsage: typeof import('../services/aiBudget').recordTenantAiUsage;
  checkTenantAiBudget: typeof import('../services/aiBudget').checkTenantAiBudget;
  withTenantAiContext: typeof import('../services/aiBudget').withTenantAiContext;
  logAiCall: typeof import('../services/aiCallLogger').logAiCall;
  requestCancellation: typeof import('../orchestrator/SyncOrchestrator').requestCancellation;
};
let svc: Svc;

interface Fixture { tenantId: number; adminId: number; connectionId: number; dimId: number; factId: number }
let A: Fixture;
let B: Fixture;

const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);

async function seed(label: string): Promise<Fixture> {
  const helpers = await import('./helpers');
  const admin = await helpers.registerUser({ email: `${label}@approle.test`, companyName: `AppRole ${label}` });
  const tenantId = admin.user.tenantId;
  const [conn] = await superDb('connections').insert({
    tenant_id: tenantId, name: `${label} source`, type: 'duckdb', connector_type: 'exactonline',
    selected_entities: ['Accounts'], config: JSON.stringify({}),
  }).returning('id');
  // The FACT is inserted first so it gets the LOWER id: a topo sort that
  // cannot see the dependency edge falls back to id order and puts the fact
  // first, so "dim before fact" below proves the edge was actually read.
  const [fact] = await superDb('data_products').insert({
    tenant_id: tenantId, connection_id: idOf(conn), name: `${label} Sales`, description: 'x', status: 'approved', kind: 'analytics',
  }).returning('id');
  const [dim] = await superDb('data_products').insert({
    tenant_id: tenantId, connection_id: idOf(conn), name: `${label} Core`, description: 'x', status: 'approved', kind: 'reference',
  }).returning('id');
  await superDb('data_product_dependencies').insert({
    tenant_id: tenantId, dependent_product_id: idOf(fact), source_product_id: idOf(dim),
  });
  return { tenantId, adminId: admin.user.id, connectionId: idOf(conn), dimId: idOf(dim), factId: idOf(fact) };
}

beforeAll(async () => {
  await cleanTestDb();
  A = await seed('alpha');
  B = await seed('beta');
  const [n, a, ap, p, o, b, c] = await Promise.all([
    import('../services/notificationService'),
    import('../services/auditService'),
    import('../services/autoApproveService'),
    import('../services/pipelineService'),
    import('../orchestrator/SyncOrchestrator'),
    import('../services/aiBudget'),
    import('../services/aiCallLogger'),
  ]);
  svc = {
    notifyAdmins: n.notifyAdmins, notify: n.notify, recordSystemAudit: a.recordSystemAudit,
    autoApproveStaleDrafts: ap.autoApproveStaleDrafts, getDag: p.getDag, resolveScope: p.resolveScope,
    topoSortProducts: p.topoSortProducts, triggerSync: o.triggerSync, requestCancellation: o.requestCancellation,
    recordTenantAiUsage: b.recordTenantAiUsage, checkTenantAiBudget: b.checkTenantAiBudget,
    withTenantAiContext: b.withTenantAiContext, logAiCall: c.logAiCall,
  };
});

afterAll(async () => {
  const { semanticDb } = await import('../db/knex');
  await semanticDb.destroy().catch(() => undefined);
  await closeTestDb();
});

describe('worker-reachable services under databridge_app with no ambient tenant context', () => {
  it('the app-role pool really has no context: a bare read of an RLS table returns nothing', async () => {
    const { semanticDb } = await import('../db/knex');
    expect(await semanticDb('data_products')).toHaveLength(0);
    expect(await superDb('data_products')).toHaveLength(4);
  });

  it('notifyAdmins / notify land rows under the right tenant', async () => {
    await svc.notifyAdmins(A.tenantId, 'job_complete', 'alpha done');
    await svc.notify({ tenantId: B.tenantId, userId: B.adminId, type: 'job_complete', title: 'beta done' });
    const rows = await superDb('notifications').select('tenant_id', 'title').orderBy('id');
    expect(rows).toEqual([
      { tenant_id: A.tenantId, title: 'alpha done' },
      { tenant_id: B.tenantId, title: 'beta done' },
    ]);
  });

  it('two tenants notifying concurrently never cross', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0
        ? svc.notifyAdmins(A.tenantId, 'approval', `A-${i}`)
        : svc.notifyAdmins(B.tenantId, 'approval', `B-${i}`)));
    const rows = await superDb('notifications').where('title', 'like', '_-%').select('tenant_id', 'title');
    for (const r of rows) expect(r.tenant_id).toBe(r.title.startsWith('A') ? A.tenantId : B.tenantId);
    expect(rows).toHaveLength(12);
  });


  /**
   * The 2026-09-10 prod-logs run caught this live: 19 `42501` lines in five
   * days, all of them aiBudget's `ai_usage` INSERT being refused by its own
   * RLS policy on the bare pool. `recordTenantAiUsage` swallows the failure
   * as a warn, and — worse — `checkTenantAiBudget` reads the same table the
   * same way, where RLS returns ZERO ROWS WITH NO ERROR: `used` reads 0,
   * `allowed` reads true, and the spend cap never bites. The write failing
   * loudly was visible; the read failing silently was not.
   */
  it('recordTenantAiUsage actually writes ai_usage (it was failing RLS and swallowing it)', async () => {
    await svc.recordTenantAiUsage(A.tenantId, 100, 40);
    await svc.recordTenantAiUsage(A.tenantId, 10, 5);
    const rows = await superDb('ai_usage').where({ tenant_id: A.tenantId }).select('total_tokens', 'call_count');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_tokens)).toBe(155);
    expect(Number(rows[0].call_count)).toBe(2);
  });

  it('checkTenantAiBudget SEES that usage, so the cap can bite', async () => {
    await svc.recordTenantAiUsage(B.tenantId, 900, 100);
    await superDb('tenants').where({ id: B.tenantId }).update({ monthly_token_budget: 1000 });

    const at = await svc.checkTenantAiBudget(B.tenantId);
    expect(at.used).toBe(1000);          // read 0 on the bare pool
    expect(at.allowed).toBe(false);      // and so was always true

    await superDb('tenants').where({ id: B.tenantId }).update({ monthly_token_budget: 5000 });
    const under = await svc.checkTenantAiBudget(B.tenantId);
    expect(under.used).toBe(1000);
    expect(under.remaining).toBe(4000);
    expect(under.allowed).toBe(true);
  });

  it('one tenant\'s usage is never counted against another', async () => {
    const a = await svc.checkTenantAiBudget(A.tenantId);
    expect(a.used).toBe(155);
  });


  /**
   * The SECOND bare-pool writer on the same table family, found by the same
   * prod-logs run once the RLS/grant labels were told apart. The comment that
   * stood over this insert argued tenantQuery was unnecessary "because we set
   * tenant_id explicitly" — but the policy's WITH CHECK compares tenant_id
   * against `app.current_tenant`, so an explicit value makes it `<value> =
   * NULL` and the row is refused. `ai_call_log` is what /admin/ai-usage and
   * the monthly usage CSV read for cost, so the rows were lost silently.
   */
  it('logAiCall actually writes ai_call_log (it was failing RLS and swallowing it)', async () => {
    await svc.withTenantAiContext({ tenantId: A.tenantId, userId: A.adminId }, async () => {
      svc.logAiCall({
        model: 'claude-sonnet-4-6', callLabel: 'nl-to-sql',
        inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0,
        durationMs: 900,
      });
    });
    // logAiCall is fire-and-forget by contract; give its promise a turn.
    await new Promise((r) => setTimeout(r, 300));
    const rows = await superDb('ai_call_log').where({ tenant_id: A.tenantId })
      .select('model', 'input_tokens', 'output_tokens');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].input_tokens)).toBe(120);
    expect(Number(rows[0].output_tokens)).toBe(30);
  });

  it('recordSystemAudit writes the audit row', async () => {
    await svc.recordSystemAudit(A.tenantId, { action: 'sync.reaped', entityType: 'source_sync_run', entityId: 7 }, { source: 'reaper' });
    const row = await superDb('audit_events').where({ tenant_id: A.tenantId, action: 'sync.reaped' }).first();
    expect(row).toBeTruthy();
    expect(row.actor_email).toBe('system:reaper');
  });

  it('autoApproveStaleDrafts approves the stale draft (it matched zero rows on the bare pool)', async () => {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const [t] = await superDb('source_tables').insert({
      tenant_id: A.tenantId, connection_id: A.connectionId, table_name: 'Accounts', ai_draft: true,
      approval_status: 'pending', created_at: old,
    }).returning('id');
    await superDb('tenants').where({ id: A.tenantId }).update({ auto_approve_ai_drafts: true, auto_approve_delay_days: 7 });
    expect(await svc.autoApproveStaleDrafts(A.tenantId)).toBe(1);
    const row = await superDb('source_tables').where({ id: idOf(t) }).first();
    expect(row.approval_status).toBe('approved');
    expect(row.ai_draft).toBe(false);
  });

  it('getDag sees exactly the tenant\'s sources, products and edges', async () => {
    const dag = await svc.getDag(A.tenantId);
    expect(dag.sources.map((s) => s.id)).toEqual([A.connectionId]);
    expect(dag.products.map((p) => p.id).sort()).toEqual([A.dimId, A.factId].sort());
    expect(dag.edges).toContainEqual({ source: { kind: 'product', id: A.dimId }, target: { kind: 'product', id: A.factId } });
    expect(dag.products.some((p) => p.id === B.factId)).toBe(false);
  });

  it('resolveScope + topoSortProducts resolve through the dependency edge', async () => {
    const scope = await svc.resolveScope({ type: 'from-source', sourceId: A.connectionId }, A.tenantId);
    expect(scope.productIds.sort()).toEqual([A.dimId, A.factId].sort());
    const ordered = await svc.topoSortProducts([A.factId, A.dimId], A.tenantId);
    expect(ordered).toEqual([A.dimId, A.factId]);
    // Under the OTHER tenant's context the edge is invisible, so the sort
    // degrades to id order — fact first. Same ids, different tenant, different answer.
    expect(await svc.topoSortProducts([A.factId, A.dimId], B.tenantId)).toEqual([A.factId, A.dimId]);
  });

  it('triggerSync queues the run, and the orchestrator can mark it failed from its catch path', async () => {
    const { syncRunId, started } = await svc.triggerSync({ connectionId: A.connectionId, tenantId: A.tenantId });
    expect(started).toBe(true);
    // The connection has no encrypted config, so runSyncInBackground throws
    // before launching a worker and persists `failed` — through tenantQuery.
    let row: { status: string; tenant_id: number } | undefined;
    for (let i = 0; i < 40 && row?.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      row = await superDb('source_sync_runs').where({ id: syncRunId }).first();
    }
    expect(row?.tenant_id).toBe(A.tenantId);
    expect(row?.status).toBe('failed');
    // A finished run is not cancellable — and the lookup proves ownership.
    expect(await svc.requestCancellation(syncRunId, A.tenantId)).toBe('not_found');
  });
});
