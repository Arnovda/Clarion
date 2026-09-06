/**
 * The raw source layer is a curator surface (2026-09-06 evaluation, defect 3).
 *
 * The frontend hid the source-layer toggle from viewers while the API
 * honoured `dataLayer:'source'` from any role. `layerForRole` is the one
 * place the three query routes (POST /, /think, /repair) now decide it; a
 * viewer's request for 'source' is ignored, not refused, so they land on
 * the product layer exactly as the UI gives them.
 */
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { layerForRole } from '../routes/query';

const asReq = (role: string) => ({ user: { role } } as unknown as Request);

describe('layerForRole', () => {
  it('honours the source layer for curators', () => {
    expect(layerForRole(asReq('admin'), 'source')).toBe('source');
    expect(layerForRole(asReq('analyst'), 'source')).toBe('source');
  });

  it('ignores a viewer\'s request for the source layer', () => {
    expect(layerForRole(asReq('viewer'), 'source')).toBeUndefined();
  });

  it('passes product and unset through for every role', () => {
    for (const role of ['admin', 'analyst', 'viewer']) {
      expect(layerForRole(asReq(role), 'product')).toBe('product');
      expect(layerForRole(asReq(role), undefined)).toBeUndefined();
    }
  });
});
