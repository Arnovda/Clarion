/**
 * HttpClient tests — focused on the hardening behaviours:
 *   • egress allow-list enforcement (exact + wildcard; blocks off-list hosts)
 *   • error-excerpt redaction (secrets in error bodies don't leak into the
 *     thrown message)
 */

process.env.HTTP_CLIENT_RATE_LIMIT_DISABLED = '1';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import { HttpClient, HttpError } from './HttpClient';
import { createNoopLogger } from './logging';

const log = createNoopLogger();

beforeAll(() => { nock.disableNetConnect(); });
afterEach(() => { nock.cleanAll(); });
afterAll(() => { nock.enableNetConnect(); });

describe('HttpClient egress enforcement', () => {
  it('allows a request to an allow-listed host', async () => {
    nock('https://allowed.example').get('/ping').reply(200, { ok: true });
    const c = new HttpClient({ baseUrl: 'https://allowed.example', log, egressAllowList: ['allowed.example'] });
    const r = await c.request<{ ok: boolean }>({ url: '/ping' });
    expect(r.body.ok).toBe(true);
  });

  it('blocks a request to a host outside the allow-list (SSRF guard)', async () => {
    const c = new HttpClient({ baseUrl: 'https://allowed.example', log, egressAllowList: ['allowed.example'] });
    // Absolute off-list URL — like a tampered server-provided next link.
    await expect(c.request({ url: 'https://evil.example/steal' })).rejects.toThrow(/egress blocked/i);
  });

  it('supports leading-wildcard host patterns', async () => {
    nock('https://start.exactonline.nl').get('/x').reply(200, {});
    const c = new HttpClient({ baseUrl: 'https://start.exactonline.nl', log, egressAllowList: ['*.exactonline.nl'] });
    await expect(c.request({ url: '/x' })).resolves.toBeTruthy();
  });

  it('does not enforce when no allow-list is set (legacy behaviour)', async () => {
    nock('https://anywhere.example').get('/y').reply(200, {});
    const c = new HttpClient({ baseUrl: 'https://anywhere.example', log });
    await expect(c.request({ url: '/y' })).resolves.toBeTruthy();
  });
});

describe('HttpClient error redaction', () => {
  it('redacts secrets in an error response body before they reach the message', async () => {
    nock('https://allowed.example')
      .get('/boom')
      .reply(400, { error: 'bad', access_token: 'supersecretvalue1234567890' });
    const c = new HttpClient({ baseUrl: 'https://allowed.example', log, egressAllowList: ['allowed.example'], maxRetries: 0 });
    try {
      await c.request({ url: '/boom' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      const msg = (e as HttpError).message;
      expect(msg).not.toContain('supersecretvalue1234567890');
      expect(msg).toContain('<redacted>');
    }
  });
});
