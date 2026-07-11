import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb } from './db-helpers';

beforeAll(async () => {
  await cleanTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('POST /api/auth/register', () => {
  beforeEach(async () => {
    await cleanTestDb();
  });

  it('creates a tenant and admin user, returns JWT', async () => {
    const res = await (await request())
      .post('/api/auth/register')
      .send({
        companyName: 'Acme Corp',
        email: 'admin@acme.com',
        password: 'SecurePass123!',
        displayName: 'John Admin',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe('admin@acme.com');
    expect(res.body.data.user.role).toBe('admin');
    expect(res.body.data.user.tenantId).toBeGreaterThan(0);
  });

  it('rejects duplicate email', async () => {
    await (await request()).post('/api/auth/register').send({
      companyName: 'First Co', email: 'dup@test.com',
      password: 'SecurePass123!', displayName: 'First',
    });

    const res = await (await request()).post('/api/auth/register').send({
      companyName: 'Second Co', email: 'dup@test.com',
      password: 'SecurePass123!', displayName: 'Second',
    });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
  });

  it('rejects missing company name', async () => {
    const res = await (await request()).post('/api/auth/register').send({
      email: 'a@b.com', password: 'SecurePass123!', displayName: 'Test',
    });
    expect(res.status).toBe(400);
  });

  it('rejects short password', async () => {
    const res = await (await request()).post('/api/auth/register').send({
      companyName: 'Co', email: 'a@b.com', password: 'short', displayName: 'Test',
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid email', async () => {
    const res = await (await request()).post('/api/auth/register').send({
      companyName: 'Co', email: 'notanemail', password: 'SecurePass123!', displayName: 'Test',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  const testEmail = 'login-test@acme.com';
  const testPassword = 'SecurePass123!';

  beforeAll(async () => {
    await cleanTestDb();
    await registerUser({
      companyName: 'Login Co',
      email: testEmail,
      password: testPassword,
      displayName: 'Login User',
    });
  });

  it('returns JWT for valid credentials', async () => {
    const res = await (await request()).post('/api/auth/login').send({
      email: testEmail, password: testPassword,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe(testEmail);
  });

  it('rejects wrong password', async () => {
    const res = await (await request()).post('/api/auth/login').send({
      email: testEmail, password: 'WrongPassword123!',
    });
    expect(res.status).toBe(401);
  });

  it('rejects non-existent email', async () => {
    const res = await (await request()).post('/api/auth/login').send({
      email: 'nonexistent@test.com', password: testPassword,
    });
    expect(res.status).toBe(401);
  });

  it('rejects missing fields', async () => {
    const res = await (await request()).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/me', () => {
  it('returns user info with valid token', async () => {
    await cleanTestDb();
    const { token } = await registerUser({ email: 'me-test@acme.com' });

    const res = await (await request())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.email).toBe('me-test@acme.com');
    expect(res.body.data.role).toBe('admin');
  });

  it('rejects request without token', async () => {
    const res = await (await request()).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects invalid token', async () => {
    const res = await (await request())
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid-token-here');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/refresh', () => {
  it('returns a fresh access token from a refresh token', async () => {
    await cleanTestDb();
    // The /refresh contract takes the rotating refresh token in the body
    // (not the access token in the header) — see refreshTokenService.
    const { refreshToken } = await registerUser({ email: 'refresh@test.com' });
    expect(refreshToken).toBeDefined();

    const res = await (await request())
      .post('/api/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.token.split('.')).toHaveLength(3);
  });

  it('rejects a missing refresh token with 400', async () => {
    const res = await (await request()).post('/api/auth/refresh').send({});
    expect(res.status).toBe(400);
  });

  it('rejects a bogus refresh token with 401', async () => {
    const res = await (await request())
      .post('/api/auth/refresh')
      .send({ refreshToken: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('always returns success (prevents email enumeration)', async () => {
    const res = await (await request()).post('/api/auth/forgot-password').send({
      email: 'nonexistent@example.com',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/auth/reset-password', () => {
  it('rejects invalid token', async () => {
    const res = await (await request()).post('/api/auth/reset-password').send({
      email: 'test@test.com',
      token: 'invalid-reset-token',
      newPassword: 'NewPassword123!',
    });
    expect(res.status).toBe(400);
  });

  it('rejects short new password', async () => {
    const res = await (await request()).post('/api/auth/reset-password').send({
      email: 'test@test.com',
      token: 'some-token',
      newPassword: 'short',
    });
    expect(res.status).toBe(400);
  });
});
