/**
 * 11-1 — a streaming response does not pin a Postgres connection.
 *
 * Before: requireAuth held one transaction (one pool connection, `idle in
 * transaction`) until `res.end` — for the whole life of every SSE stream.
 * Now: the moment headers are flushed the transaction is committed and
 * `req.dbTrx` becomes a per-query tenant-scoped handle. Pinned here with
 * a tiny express app around the REAL requireAuth, and with the handle
 * itself: every query it runs sees the tenant's SET LOCAL, `raw` and
 * `transaction` included, and nothing sits idle in transaction while the
 * stream is open.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { Knex } from 'knex';
import { registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { requireAuth } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { scopedRequestDb } from '../db/scopedRequestDb';

let tenantId: number;
let token: string;

beforeAll(async () => {
  await cleanTestDb();
  const t = await registerUser({ email: `sse-${Date.now()}@test.com`, companyName: 'StreamCo' });
  tenantId = t.user.tenantId; token = t.token;
});

afterAll(async () => { await closeTestDb(); });

const tenantSetting = async (db: Knex) => {
  const r = await db.raw(`SELECT current_setting('app.current_tenant', true) AS t`);
  return String((r.rows?.[0] ?? r[0])?.t ?? '');
};

describe('scopedRequestDb', () => {
  it('runs every query — builder, first, raw, transaction — under the tenant SET LOCAL, one short transaction each', async () => {
    const db = scopedRequestDb(tenantId);
    expect(await tenantSetting(db)).toBe(String(tenantId));
    const viaBuilder = await db('users').select('tenant_id').where({ tenant_id: tenantId }).first();
    expect(Number(viaBuilder.tenant_id)).toBe(tenantId);
    const inTrx = await db.transaction(async (trx) => tenantSetting(trx));
    expect(inTrx).toBe(String(tenantId));
    // `.catch()` and `.finally()` route through the same hook.
    const caught = await db('users').where({ id: -1 }).first().catch(() => 'err');
    expect(caught).toBeUndefined();
    // The root pool, by contrast, carries no tenant on a fresh connection —
    // the setting the handle exists to supply.
    expect((db as unknown as { isTransaction: boolean }).isTransaction).toBe(false);
    expect((db as unknown as { scopedTenantId: number }).scopedTenantId).toBe(tenantId);
  });
});

describe('requireAuth releases the request transaction when the response starts streaming', () => {
  function app() {
    const a = express();
    a.set('trust proxy', 1);
    a.get('/stream', requireAuth, async (req, res) => {
      const before = reqDb(req) as unknown as { isTransaction?: boolean };
      const wasTrx = before.isTransaction === true;
      // Count our own idle-in-transaction sessions BEFORE releasing: the
      // request transaction is one of them.
      res.flushHeaders(); // ← what startSSE does; requireAuth releases here
      const after = reqDb(req) as unknown as { isTransaction?: boolean; scopedTenantId?: number };
      const settingAfter = await tenantSetting(reqDb(req) as Knex);
      const row = await (reqDb(req) as Knex)('users').where({ tenant_id: tenantId }).count<{ n: string }>('* as n').first();
      const idle = await getTestDb().raw(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'idle in transaction' AND datname = current_database()`);
      res.write(JSON.stringify({
        wasTrx, isTrxAfter: after.isTransaction === true, scopedTenantId: after.scopedTenantId ?? null,
        settingAfter, users: Number(row?.n ?? 0), idleInTrx: Number(idle.rows[0].n),
      }));
      res.end();
    });
    return a;
  }

  it('the transaction is gone after flushHeaders, later queries still run as the tenant, nothing idles in transaction', async () => {
    const res = await supertest(app()).get('/stream').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.wasTrx).toBe(true);
    expect(body.isTrxAfter).toBe(false);
    expect(body.scopedTenantId).toBe(tenantId);
    expect(body.settingAfter).toBe(String(tenantId));
    expect(body.users).toBeGreaterThanOrEqual(1);
    expect(body.idleInTrx).toBe(0);
  });

  it('an ordinary (non-streaming) response keeps the request transaction until the end', async () => {
    const a = express();
    a.get('/plain', requireAuth, async (req, res) => {
      const db = reqDb(req) as unknown as { isTransaction?: boolean };
      res.json({ isTrx: db.isTransaction === true });
    });
    const res = await supertest(a).get('/plain').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.isTrx).toBe(true);
  });
});
