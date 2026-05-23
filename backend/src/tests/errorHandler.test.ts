/**
 * Tests the runtime guard added to errorHandler that detects
 * Postgres 25P02 ("current transaction is aborted") and surfaces
 * a diagnostic message instead of letting the error masquerade as
 * a generic 500.
 *
 * The guard is what protects future debugging sessions from chasing
 * the wrong error — the user-visible error is always the SECOND
 * failure; the first (real) one is somewhere earlier in the request
 * and would otherwise be silent.
 */

import { describe, it, expect, vi } from 'vitest';
import { errorHandler } from '../middleware/errorHandler';
import type { Request, Response } from 'express';

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    url: '/api/test',
    method: 'POST',
    user: { sub: 1, tenantId: 1, email: 't@x.com', displayName: 'T', role: 'admin' },
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

describe('errorHandler — 25P02 trx-poison diagnostic', () => {
  it('recognises Postgres 25P02 by .code property', () => {
    const { res, status, json } = makeRes();
    const err = Object.assign(new Error('whatever'), { code: '25P02' });

    errorHandler(err, makeReq(), res, vi.fn());

    expect(status).toHaveBeenCalledWith(500);
    const payload = json.mock.calls[0][0];
    // Admin user gets the diagnostic message pointing at the upstream cause.
    expect(payload.error).toMatch(/current transaction is aborted/i);
    expect(payload.error).toMatch(/earlier query/i);
  });

  it('recognises Postgres 25P02 by message text (fallback when .code missing)', () => {
    const { res, status, json } = makeRes();
    const err = new Error('current transaction is aborted, commands ignored until end of transaction block');

    errorHandler(err, makeReq(), res, vi.fn());

    expect(status).toHaveBeenCalledWith(500);
    const payload = json.mock.calls[0][0];
    expect(payload.error).toMatch(/earlier query/i);
  });

  it('non-admin users still get a generic message for 25P02 (no diagnostic leak)', () => {
    const { res, status, json } = makeRes();
    const err = Object.assign(new Error('current transaction is aborted'), { code: '25P02' });

    errorHandler(err, makeReq({
      user: { sub: 2, tenantId: 1, email: 'v@x.com', displayName: 'V', role: 'viewer' },
    } as unknown as Partial<Request>), res, vi.fn());

    expect(status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].error).toBe('Something went wrong. Please try again.');
  });

  it('non-25P02 Postgres errors get the normal admin-message path', () => {
    const { res, status, json } = makeRes();
    const err = Object.assign(new Error('relation "foo" does not exist'), { code: '42P01' });

    errorHandler(err, makeReq(), res, vi.fn());

    expect(status).toHaveBeenCalledWith(500);
    // Admin sees the real message — NOT the 25P02 diagnostic.
    expect(json.mock.calls[0][0].error).toBe('relation "foo" does not exist');
  });

  it('non-DB errors are unaffected', () => {
    const { res, status, json } = makeRes();
    const err = new TypeError('something blew up in app code');

    errorHandler(err, makeReq(), res, vi.fn());

    expect(status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].error).toBe('something blew up in app code');
  });
});
