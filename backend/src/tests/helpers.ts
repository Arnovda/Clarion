/**
 * Test helpers — shared utilities for all integration tests.
 *
 * Provides functions to:
 * - Get a supertest agent bound to the Express app
 * - Register a test tenant + user and get a JWT
 * - Clean up test data between tests
 */

import supertest from 'supertest';
import { signToken } from '../middleware/auth';

// Cache the app import
let _app: unknown = null;

export async function getApp() {
  if (!_app) {
    const mod = await import('../index');
    _app = mod.default;
  }
  return _app;
}

export async function request() {
  const app = await getApp();
  return supertest(app as Parameters<typeof supertest>[0]);
}

/** Generate a JWT for testing with given params */
export function makeToken(opts: {
  sub?: number;
  tenantId?: number;
  email?: string;
  displayName?: string;
  role?: 'admin' | 'analyst' | 'viewer';
} = {}) {
  return signToken({
    sub: opts.sub ?? 1,
    tenantId: opts.tenantId ?? 1,
    email: opts.email ?? 'test@example.com',
    displayName: opts.displayName ?? 'Test User',
    role: opts.role ?? 'admin',
  });
}

/** Register a new tenant+user via the API and return the token + user info */
export async function registerUser(overrides: {
  companyName?: string;
  email?: string;
  password?: string;
  displayName?: string;
} = {}) {
  const agent = await request();
  const res = await agent
    .post('/api/auth/register')
    .send({
      companyName: overrides.companyName ?? `TestCo-${Date.now()}`,
      email: overrides.email ?? `test-${Date.now()}@example.com`,
      password: overrides.password ?? 'TestPassword123!',
      displayName: overrides.displayName ?? 'Test Admin',
    });

  if (res.status !== 201) {
    throw new Error(`Registration failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    token: res.body.data.token as string,
    refreshToken: res.body.data.refreshToken as string,
    user: res.body.data.user as {
      id: number;
      tenantId: number;
      email: string;
      displayName: string;
      role: string;
    },
  };
}

/**
 * Insert a REAL user row and forge a token for it.
 *
 * Since P1-3, requireAuth re-validates that the (tenant, user) pair
 * exists and is active — a token for a nonexistent user (the old
 * `makeToken({ sub: 999 })` trick) is refused with 401 before any route
 * runs, so tests exercising role gates or tenant behaviour must forge
 * tokens for rows that exist.
 */
export async function createUserWithToken(opts: {
  tenantId: number;
  role?: 'admin' | 'analyst' | 'viewer';
  email?: string;
}): Promise<{ id: number; token: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (await import('../db/knex')).semanticDb as any;
  const role = opts.role ?? 'viewer';
  const email = opts.email ?? `forged-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
  const [row] = await db('users')
    .insert({
      tenant_id: opts.tenantId,
      email,
      password_hash: 'x',
      display_name: role,
      role,
    })
    .returning('id');
  const id = typeof row === 'object' ? (row as { id: number }).id : (row as number);
  return { id, token: makeToken({ sub: id, tenantId: opts.tenantId, role, email }) };
}

/** Get the semantic DB instance (for direct cleanup queries) */
export function getDb() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../db/knex').semanticDb;
}
