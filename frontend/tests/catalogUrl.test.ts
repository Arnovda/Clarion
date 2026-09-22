/**
 * The catalog's deep links (lib/catalogUrl.ts). The catalog was rebuilt in
 * place, so every existing link into it must still land somewhere true —
 * these pin each one, and the glossary facet's move to /definitions.
 */
import { describe, it, expect } from 'vitest';
import { parseCatalogUrl, catalogHref } from '../lib/catalogUrl';

const p = (qs: string) => parseCatalogUrl(new URLSearchParams(qs));

describe('parseCatalogUrl', () => {
  it('an empty query is the landing', () => {
    expect(p('')).toEqual({ kind: 'none' });
  });

  it('?productId= opens the subject (the topic page and the tree write it)', () => {
    expect(p('productId=12')).toEqual({ kind: 'subject', productId: 12 });
  });

  it('?tableId= and ?refTableId= both open a product table — one panel resolves either id space', () => {
    expect(p('tableId=44')).toEqual({ kind: 'table', tableId: 44 });
    expect(p('refTableId=44')).toEqual({ kind: 'table', tableId: 44 });
    // Shared data writes refTableId; the old cards URL carried productId too.
    expect(p('productId=12&tableId=44')).toEqual({ kind: 'table', tableId: 44 });
  });

  it('?table=<name> (the dashboard filter popover) is resolved by name', () => {
    expect(p('table=dim_item')).toEqual({ kind: 'table-by-name', name: 'dim_item' });
  });

  it('a source and a source table', () => {
    expect(p('connectionId=3')).toEqual({ kind: 'source', connectionId: 3 });
    expect(p('connectionId=3&sourceTableId=90')).toEqual({ kind: 'source-table', tableId: 90, connectionId: 3 });
  });

  it('the old glossary facet lands on Definitions; the old trust facet lands on the catalog itself', () => {
    expect(p('facet=glossary')).toEqual({ kind: 'definitions' });
    expect(p('facet=trust')).toEqual({ kind: 'none' });
  });

  it('a malformed id is not a selection', () => {
    expect(p('productId=abc')).toEqual({ kind: 'none' });
    expect(p('tableId=-4')).toEqual({ kind: 'none' });
    expect(p('tableId=1.5')).toEqual({ kind: 'none' });
  });
});

describe('catalogHref', () => {
  it('round-trips every selection through the address bar', () => {
    for (const intent of [
      { kind: 'subject' as const, productId: 7 },
      { kind: 'table' as const, tableId: 9 },
      { kind: 'source' as const, connectionId: 2 },
      { kind: 'source-table' as const, tableId: 5, connectionId: 2 },
      { kind: 'table-by-name' as const, name: 'dim item' },
    ]) {
      const href = catalogHref(intent);
      expect(parseCatalogUrl(new URLSearchParams(href.split('?')[1] ?? ''))).toEqual(intent);
    }
    expect(catalogHref({ kind: 'none' })).toBe('/catalog');
    expect(catalogHref({ kind: 'definitions' })).toBe('/definitions');
  });
});
