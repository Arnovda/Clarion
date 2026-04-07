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
    user: res.body.data.user as {
      id: number;
      tenantId: number;
      email: string;
      displayName: string;
      role: string;
    },
  };
}

/** Get the semantic DB instance (for direct cleanup queries) */
export function getDb() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../db/knex').semanticDb;
}
