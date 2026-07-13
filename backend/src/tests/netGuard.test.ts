import { describe, it, expect } from 'vitest';
import { assertSafeDbHost, isLinkLocalOrMetadata, UnsafeHostError } from '../utils/netGuard';

describe('assertSafeDbHost', () => {
  it('blocks cloud metadata / link-local addresses', () => {
    for (const h of [
      '169.254.169.254',   // Azure/AWS IMDS
      '169.254.170.2',     // ECS task metadata
      '169.254.0.1',       // link-local
      'metadata.google.internal',
      '[fe80::1]',         // IPv6 link-local (bracketed)
    ]) {
      expect(isLinkLocalOrMetadata(h), h).toBe(true);
      expect(() => assertSafeDbHost(h), h).toThrow(UnsafeHostError);
    }
  });

  it('allows legitimate DB hosts (loopback, private, public, hostnames)', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.20',
      '172.16.4.9',
      'db.customer.example.com',
      'mydb.postgres.database.azure.com',
      '52.10.20.30',
    ]) {
      expect(isLinkLocalOrMetadata(h), h).toBe(false);
      expect(() => assertSafeDbHost(h), h).not.toThrow();
    }
  });

  it('is a no-op for empty/missing host (driver default applies)', () => {
    expect(() => assertSafeDbHost(undefined)).not.toThrow();
    expect(() => assertSafeDbHost('')).not.toThrow();
  });

  it('does not misparse octets above 255 as link-local', () => {
    // 169.2540.0.1 is not a valid IPv4 and must not match the 169.254 rule
    expect(isLinkLocalOrMetadata('169.2540.0.1')).toBe(false);
  });
});
