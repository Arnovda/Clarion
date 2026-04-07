import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';

let adminToken: string;
let tenantId: number;
let userId: number;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'notif-admin@test.com', companyName: 'NotifCo' });
  adminToken = admin.token;
  tenantId = admin.user.tenantId;
  userId = admin.user.id;

  // Insert some test notifications directly
  const db = getTestDb();
  await db('notifications').insert([
    { tenant_id: tenantId, user_id: userId, type: 'job_complete', title: 'Job done', message: 'Transformation completed' },
    { tenant_id: tenantId, user_id: userId, type: 'quality_alert', title: 'Quality drop', message: 'Score dropped below threshold', read: true },
    { tenant_id: tenantId, user_id: userId, type: 'new_gap', title: 'New gap', message: 'Definition gap detected' },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

describe('GET /api/notifications', () => {
  it('returns notifications with unread count', async () => {
    const res = await (await request())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Response shape: { ok, data: [...rows], unreadCount }
    expect(res.body.data.length).toBe(3);
    expect(res.body.unreadCount).toBe(2); // 2 unread, 1 read
  });

  it('filters to unread only', async () => {
    const res = await (await request())
      .get('/api/notifications?unread=true')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
  });
});

describe('PUT /api/notifications/:id/read', () => {
  it('marks a notification as read', async () => {
    // Get unread notifications
    const list = await (await request())
      .get('/api/notifications?unread=true')
      .set('Authorization', `Bearer ${adminToken}`);
    const notifId = list.body.data[0]?.id;

    const res = await (await request())
      .put(`/api/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('PUT /api/notifications/read-all', () => {
  it('marks all notifications as read', async () => {
    const res = await (await request())
      .put('/api/notifications/read-all')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify all are read
    const list = await (await request())
      .get('/api/notifications?unread=true')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(list.body.data.length).toBe(0);
    expect(list.body.unreadCount).toBe(0);
  });
});
