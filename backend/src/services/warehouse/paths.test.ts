/**
 * Warehouse path-layer tests.
 *
 * Two goals:
 *   1. Prove that the DEFAULT (shared-container) behaviour is byte-for-byte
 *      unchanged — deploying the per-tenant-container feature must not move
 *      any existing tenant's data.
 *   2. Prove the per-tenant-container mode produces the intended URIs and
 *      that source read paths + worker write prefixes stay in lockstep.
 *
 * Pure functions only — no DuckDB, no DB, no Azure. Safe to run anywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  warehouseContainer,
  warehouseContainerMode,
  productBasePathV2,
  sourceBasePathV2,
  sourceWorkerPathPrefix,
  assertValidContainerName,
} from './paths';
import { capResultRows } from './duckdb';

const AZURE_MARKER = 'AZURE_CONTAINER_APPS_JOB_NAME';

describe('warehouse container mode', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [AZURE_MARKER, 'WAREHOUSE_CONTAINER_MODE', 'AZURE_WAREHOUSE_CONTAINER', 'AZURE_WAREHOUSE_CONTAINER_PREFIX']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('shared mode (default) — behaviour must be unchanged', () => {
    beforeEach(() => { process.env[AZURE_MARKER] = 'sync-worker'; }); // Azure mode on

    it('defaults to shared mode', () => {
      expect(warehouseContainerMode()).toBe('shared');
    });

    it('uses the shared container regardless of tenant', () => {
      expect(warehouseContainer(42)).toBe('warehouse');
      expect(warehouseContainer(undefined)).toBe('warehouse');
    });

    it('honours AZURE_WAREHOUSE_CONTAINER override', () => {
      process.env.AZURE_WAREHOUSE_CONTAINER = 'wh-prod';
      expect(warehouseContainer(42)).toBe('wh-prod');
    });

    it('produces the historical tenant-prefixed source + product URIs', () => {
      expect(sourceBasePathV2(1, 4)).toBe('az://warehouse/tenant_1/conn_4');
      expect(productBasePathV2(1, 3)).toBe('az://warehouse/tenant_1/product_3');
    });

    it('worker path prefix keeps the tenant segment', () => {
      expect(sourceWorkerPathPrefix(1, 4)).toBe('tenant_1/conn_4/');
    });
  });

  describe('per-tenant mode', () => {
    beforeEach(() => {
      process.env[AZURE_MARKER] = 'sync-worker';
      process.env.WAREHOUSE_CONTAINER_MODE = 'per-tenant';
    });

    it('reports per-tenant mode', () => {
      expect(warehouseContainerMode()).toBe('per-tenant');
    });

    it('derives a per-tenant container name', () => {
      expect(warehouseContainer(42)).toBe('tenant-42');
    });

    it('honours a custom container prefix', () => {
      process.env.AZURE_WAREHOUSE_CONTAINER_PREFIX = 'clarion-wh-';
      expect(warehouseContainer(42)).toBe('clarion-wh-42');
    });

    it('rejects a container name made invalid by a bad prefix', () => {
      // Uppercase is illegal in an Azure container name — must fail loudly and
      // locally, not deep inside the Azure SDK.
      process.env.AZURE_WAREHOUSE_CONTAINER_PREFIX = 'Tenant_';
      expect(() => warehouseContainer(42)).toThrow(/Invalid Azure container name/);
    });

    it('falls back to shared container when tenant id is missing', () => {
      // Legacy call-sites that don't thread a tenant id must not crash.
      expect(warehouseContainer(undefined)).toBe('warehouse');
    });

    it('drops the redundant tenant path segment (container encodes the tenant)', () => {
      expect(sourceBasePathV2(1, 4)).toBe('az://tenant-1/conn_4');
      expect(productBasePathV2(1, 3)).toBe('az://tenant-1/product_3');
    });

    it('worker path prefix omits the tenant segment', () => {
      expect(sourceWorkerPathPrefix(1, 4)).toBe('conn_4/');
    });

    it('read path and worker write prefix agree', () => {
      // Backend reads az://tenant-1/conn_4 ; worker writes <container>/conn_4/…
      // where <container> = tenant-1 → same physical location.
      const readPath = sourceBasePathV2(1, 4);
      const container = warehouseContainer(1);
      const prefix = sourceWorkerPathPrefix(1, 4);
      expect(`az://${container}/${prefix}`.replace(/\/$/, '')).toBe(readPath);
    });
  });

  describe('local mode is unaffected by container mode', () => {
    beforeEach(() => { process.env.WAREHOUSE_CONTAINER_MODE = 'per-tenant'; }); // no Azure marker

    it('always uses tenant path segments locally', () => {
      const src = sourceBasePathV2(1, 4);
      const prod = productBasePathV2(1, 3);
      expect(src.replace(/\\/g, '/')).toMatch(/warehouse\/tenant_1\/conn_4$/);
      expect(prod.replace(/\\/g, '/')).toMatch(/warehouse\/tenant_1\/product_3$/);
    });
  });
});

describe('assertValidContainerName', () => {
  it('accepts valid Azure container names', () => {
    for (const n of ['warehouse', 'tenant-42', 'clarion-wh-1', 'abc', 'a1b2c3']) {
      expect(() => assertValidContainerName(n), n).not.toThrow();
    }
  });

  it('rejects invalid names', () => {
    for (const n of [
      'ab',                 // too short (<3)
      'a'.repeat(64),       // too long (>63)
      'Tenant-1',           // uppercase
      'tenant_1',           // underscore
      'tenant--1',          // double hyphen
      '-tenant1',           // leading hyphen
      'tenant1-',           // trailing hyphen
      'tenant 1',           // space
    ]) {
      expect(() => assertValidContainerName(n), n).toThrow(/Invalid Azure container name/);
    }
  });
});

describe('capResultRows', () => {
  it('caps a single SELECT', () => {
    expect(capResultRows('SELECT * FROM t', 1000))
      .toBe('SELECT * FROM (\nSELECT * FROM t\n) AS _clarion_capped LIMIT 1000');
  });

  it('caps a WITH/CTE query', () => {
    const out = capResultRows('WITH x AS (SELECT 1) SELECT * FROM x', 500);
    expect(out).toContain('LIMIT 500');
    expect(out.startsWith('SELECT * FROM (')).toBe(true);
  });

  it('strips a trailing semicolon before wrapping', () => {
    expect(capResultRows('SELECT 1;', 10)).toBe('SELECT * FROM (\nSELECT 1\n) AS _clarion_capped LIMIT 10');
  });

  it('leaves multi-statement scripts alone', () => {
    const sql = 'CREATE TEMP TABLE t AS SELECT 1; SELECT * FROM t';
    expect(capResultRows(sql, 10)).toBe(sql);
  });

  it('leaves non-SELECT statements alone (notebook DDL / PRAGMA / COPY)', () => {
    for (const sql of ['PRAGMA database_list', 'CREATE TABLE t (a int)', "COPY t TO 'x.parquet'"]) {
      expect(capResultRows(sql, 10)).toBe(sql);
    }
  });

  it('is a no-op when the cap is 0 / disabled', () => {
    expect(capResultRows('SELECT * FROM t', 0)).toBe('SELECT * FROM t');
  });
});
