/**
 * 7-1 — a dead source is announced, and the sync that never ran is caught
 * by the calendar.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { isStale, allowedStaleMinutes, sweepFreshness, _resetFreshnessState } from '../jobs/freshnessMonitor';
import { cronGapStats } from '../services/tenantLimits';

let tenantId: number;
let adminToken: string;
let adminId: number;

beforeAll(async () => {
  await cleanTestDb();
  const t = await registerUser({ email: `fresh-admin-${Date.now()}@test.com`, companyName: 'FreshCo' });
  tenantId = t.user.tenantId; adminToken = t.token; adminId = t.user.id;
});

afterAll(async () => { await closeTestDb(); });

describe('the freshness rule is measured against the schedule itself', () => {
  it('uses the LONGEST gap: a weekday-morning schedule is not stale on Monday', () => {
    expect(cronGapStats('0 9 * * 1-5')!.max).toBe(72 * 60);
    expect(allowedStaleMinutes('0 9 * * 1-5', 'UTC')).toBe(2 * 72 * 60 + 30);
    expect(allowedStaleMinutes('*/15 * * * *', 'UTC')).toBe(120);  // floored at 2 h
    expect(allowedStaleMinutes('not a cron', 'UTC')).toBe(120 * 12); // unparseable → a day
    const monday = new Date('2026-09-07T10:00:00Z'); // Monday
    const friday = new Date('2026-09-04T09:05:00Z');
    expect(isStale({ lastLandedAt: friday, sinceAt: friday, cron: '0 9 * * 1-5', timezone: 'UTC', now: monday }).stale).toBe(false);
    const nextThursday = new Date('2026-09-10T22:00:00Z');
    expect(isStale({ lastLandedAt: friday, sinceAt: friday, cron: '0 9 * * 1-5', timezone: 'UTC', now: nextThursday }).stale).toBe(true);
    // Never synced: the schedule's creation is the clock.
    const created = new Date('2026-09-01T00:00:00Z');
    expect(isStale({ lastLandedAt: null, sinceAt: created, cron: '*/15 * * * *', timezone: 'UTC', now: new Date('2026-09-01T01:00:00Z') }).stale).toBe(false);
    expect(isStale({ lastLandedAt: null, sinceAt: created, cron: '*/15 * * * *', timezone: 'UTC', now: new Date('2026-09-01T03:00:00Z') }).stale).toBe(true);
  });

  it('the sweep finds the stale source, logs it, notifies the admins once per day, and leaves a fresh one alone', async () => {
    _resetFreshnessState();
    const db = getTestDb();
    const mk = async (name: string, lastSynced: Date | null) => {
      const [c] = await db('connections').insert({
        tenant_id: tenantId, name, type: 'duckdb', connector_type: 'exactonline', selected_entities: ['Accounts'],
        config: JSON.stringify({}), last_synced_at: lastSynced, last_sync_status: lastSynced ? 'succeeded' : null,
      }).returning('id');
      const id = Number((c as { id?: number }).id ?? c);
      await db('connection_sync_schedules').insert({
        tenant_id: tenantId, connection_id: id, cron_expression: '*/30 * * * *', timezone: 'UTC', enabled: true,
        created_at: new Date(Date.now() - 48 * 3_600_000),
      });
      return id;
    };
    const fresh = await mk('Fresh source', new Date(Date.now() - 20 * 60_000));
    const stale = await mk('Silent source', new Date(Date.now() - 10 * 3_600_000));
    const never = await mk('Never synced', null);

    const found = await sweepFreshness(db);
    const ids = found.map((f) => f.connectionId);
    expect(ids).toContain(stale);
    expect(ids).toContain(never);
    expect(ids).not.toContain(fresh);
    const silent = found.find((f) => f.connectionId === stale)!;
    expect(silent.ageMinutes).toBeGreaterThanOrEqual(600);
    expect(silent.allowedMinutes).toBe(120);

    const notes = await db('notifications').where({ tenant_id: tenantId, user_id: adminId, type: 'source_stale' });
    expect(notes.map((n) => n.entity_id).sort()).toEqual([stale, never].sort());
    expect(notes.find((n) => n.entity_id === stale)!.title).toMatch(/Silent source: no new data for 10 hours/);

    // A second sweep the same day does not notify again.
    await sweepFreshness(db);
    const again = await db('notifications').where({ tenant_id: tenantId, user_id: adminId, type: 'source_stale' });
    expect(again.length).toBe(2);
  });
});

describe('a sync that fails tells the admins', () => {
  it('a failed run produces a sync_failed notification naming the source', async () => {
    const db = getTestDb();
    const [c] = await db('connections').insert({
      tenant_id: tenantId, name: 'Broken source', type: 'duckdb', connector_type: 'exactonline',
      selected_entities: ['Accounts'], config: JSON.stringify({}),
    }).returning('id');
    const connectionId = Number((c as { id?: number }).id ?? c);
    const agent = await request();
    const res = await agent.post(`/api/connections/${connectionId}/sync`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect([200, 202]).toContain(res.status);
    // The inline launch fails (no encrypted config) shortly after the response.
    let run: { status: string } | undefined;
    for (let i = 0; i < 40; i++) {
      run = await db('source_sync_runs').where({ connection_id: connectionId }).orderBy('id', 'desc').first();
      if (run && run.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(run?.status).toBe('failed');
    let note;
    for (let i = 0; i < 20; i++) {
      note = await db('notifications').where({ tenant_id: tenantId, user_id: adminId, type: 'sync_failed', entity_id: connectionId }).first();
      if (note) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(note).toBeDefined();
    expect(note.title).toBe('Broken source: sync failed');
    expect(note.link).toBe('/sources');
  });
});
