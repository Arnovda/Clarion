import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runRetentionSweep, retentionDays, RETENTION_RULES } from '../services/retention';
import { semanticDb } from '../db/knex';
import { registerUser } from './helpers';

describe('retentionDays', () => {
  const rule = { table: 'notifications', column: 'created_at', envVar: 'RETENTION_TEST_DAYS', defaultDays: 90 };

  afterEach(() => { delete process.env.RETENTION_TEST_DAYS; });

  it('uses the default when the env var is unset', () => {
    expect(retentionDays(rule)).toBe(90);
  });
  it('honours a valid env override', () => {
    process.env.RETENTION_TEST_DAYS = '30';
    expect(retentionDays(rule)).toBe(30);
  });
  it('treats 0 as disabled', () => {
    process.env.RETENTION_TEST_DAYS = '0';
    expect(retentionDays(rule)).toBe(0);
  });
  it('falls back to the default on garbage input', () => {
    process.env.RETENTION_TEST_DAYS = 'nonsense';
    expect(retentionDays(rule)).toBe(90);
  });
});

describe('runRetentionSweep', () => {
  // Use a real rule against the test DB's notifications table.
  const RULE = [{ table: 'notifications', column: 'created_at', envVar: 'RETENTION_NOTIFICATION_DAYS', defaultDays: 90 }];
  let userId = 0;
  let tenantId = 0;

  beforeEach(async () => {
    const { user } = await registerUser();
    userId = user.id;
    tenantId = user.tenantId;
    await semanticDb('notifications').where({ user_id: userId }).del();
  });
  afterEach(async () => {
    await semanticDb('notifications').where({ user_id: userId }).del();
    delete process.env.RETENTION_NOTIFICATION_DAYS;
  });

  it('deletes rows older than the window and keeps newer ones', async () => {
    process.env.RETENTION_NOTIFICATION_DAYS = '30';
    const base = { tenant_id: tenantId, user_id: userId, type: 'system', title: 't', message: 'x', read: false };
    await semanticDb('notifications').insert([
      { ...base, created_at: semanticDb.raw(`NOW() - INTERVAL '60 days'`) }, // stale
      { ...base, created_at: semanticDb.raw(`NOW() - INTERVAL '10 days'`) }, // fresh
    ]);

    const deleted = await runRetentionSweep(semanticDb, RULE);
    expect(deleted.notifications).toBe(1);

    const remaining = await semanticDb('notifications').where({ user_id: userId }).count<{ count: string }[]>('* as count');
    expect(Number(remaining[0].count)).toBe(1);
  });

  it('is a no-op when the window is disabled (0)', async () => {
    process.env.RETENTION_NOTIFICATION_DAYS = '0';
    await semanticDb('notifications').insert({
      tenant_id: tenantId, user_id: userId, type: 'system', title: 't', message: 'x', read: false,
      created_at: semanticDb.raw(`NOW() - INTERVAL '999 days'`),
    });
    const deleted = await runRetentionSweep(semanticDb, RULE);
    expect(deleted.notifications).toBeUndefined();
    const remaining = await semanticDb('notifications').where({ user_id: userId }).count<{ count: string }[]>('* as count');
    expect(Number(remaining[0].count)).toBe(1);
  });

  it('ships default rules for the unbounded tables', () => {
    const tables = RETENTION_RULES.map((r) => r.table);
    expect(tables).toContain('notifications');
    expect(tables).toContain('ai_call_log');
    expect(tables).toContain('query_log');
    expect(tables).toContain('conversation_messages');
  });
});
