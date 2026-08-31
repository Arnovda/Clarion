/**
 * SharePoint connector tests.
 *
 * The load-bearing one is the conformance case. `conformance.test.ts` holds
 * every connector's entity catalog to the framework's invariants, but it does
 * that by importing a STATIC catalog — and this connector has none, because
 * its entities are whatever workbooks the customer keeps. A dynamic catalog
 * would therefore slip past the gate entirely. So the derived entities are run
 * through the same validator here.
 */

import { describe, expect, it, vi } from 'vitest';
import { validateEntityCatalog } from '../conformance';
import { createNoopLogger } from '../logging';
import type { HttpClient } from '../HttpClient';
import { buildXlsxFixture } from '../spreadsheet/__fixtures__/xlsxFixture';
import { readXlsx } from '../spreadsheet/xlsxReader';
import { entitiesForWorkbook, entityNameFor, fileBaseName } from './entities';
import {
  downloadItem,
  GraphError,
  isWorkbookName,
  listWorkbooks,
  parseSiteUrl,
  type DriveFile,
} from './graph';
import { sharePointOAuth, SHAREPOINT_SCOPES } from './oauth';
import { SharePointConnector } from './SharePointConnector';

const file = (over: Partial<DriveFile> = {}): DriveFile => ({
  id: 'item-1',
  name: 'Budget 2026.xlsx',
  path: 'Budgets/Budget 2026.xlsx',
  size: 1024,
  ...over,
});

/** Minimal HttpClient stand-in: only `request` is exercised by graph.ts. */
function stubHttp(handler: (url: string) => unknown): HttpClient {
  return {
    request: vi.fn(async (req: { url: string }) => ({ status: 200, headers: {}, body: handler(req.url) })),
  } as unknown as HttpClient;
}

describe('entity naming', () => {
  it('always carries file AND sheet, even for a one-sheet workbook', () => {
    // Shortening to just the file name would force a rename the day a second
    // tab appears, orphaning the already-synced table.
    expect(entityNameFor('Budget 2026.xlsx', 'Overzicht')).toBe('Budget_2026__Overzicht');
  });

  it('strips only the workbook extension', () => {
    expect(fileBaseName('Budget.2026.xlsx')).toBe('Budget.2026');
    expect(fileBaseName('Budget.xlsm')).toBe('Budget');
  });

  it('survives names with nothing usable in them', () => {
    expect(entityNameFor('📊.xlsx', '🎯')).toBe('workbook__sheet');
  });

  it('keeps the separator that sanitising alone would collapse', () => {
    expect(entityNameFor('A B.xlsx', 'C D')).toBe('A_B__C_D');
  });
});

describe('entitiesForWorkbook', () => {
  const workbook = async () => readXlsx(buildXlsxFixture([
    { name: 'Overzicht', rows: [['Klant', 'Bedrag'], ['Acme', 100], ['Globex', 250]] },
    { name: 'Leeg', rows: [] },
  ]));

  it('describes each sheet with its measured shape', async () => {
    const entities = entitiesForWorkbook(file(), await workbook(), true);
    expect(entities.map((e) => e.name)).toEqual(['Budget_2026__Overzicht', 'Budget_2026__Leeg']);
    expect(entities[0].description).toContain('2 rows, 2 columns');
    expect(entities[0].estimatedRowCount).toBe(2);
  });

  it('lists an empty tab rather than hiding it', async () => {
    const entities = entitiesForWorkbook(file(), await workbook(), true);
    // A silently missing tab reads as "the connector could not see my file".
    expect(entities[1].description).toContain('Empty worksheet');
  });

  it('never declares incremental sync', async () => {
    // A worksheet has no row-level modification stamp and no business key, so
    // a cursor here would make the writer overwrite the table with each delta.
    for (const e of entitiesForWorkbook(file(), await workbook(), true)) {
      expect(e.supportsIncremental).toBe(false);
      expect(e.incrementalCursor).toBeUndefined();
    }
  });

  it('keeps two sheets whose names sanitise alike as two tables', async () => {
    const wb = await readXlsx(buildXlsxFixture([
      { name: 'Q1 2026', rows: [['a'], [1]] },
      { name: 'Q1/2026', rows: [['b'], [2]] },
    ]));
    const names = entitiesForWorkbook(file(), wb, true).map((e) => e.name);
    expect(new Set(names).size).toBe(2);
  });

  it('passes the framework entity invariants, which the static gate cannot check', async () => {
    const entities = entitiesForWorkbook(file(), await workbook(), true);
    expect(validateEntityCatalog('sharepoint', entities)).toEqual([]);
  });
});

describe('parseSiteUrl', () => {
  it('splits host from server-relative path', () => {
    expect(parseSiteUrl('https://contoso.sharepoint.com/sites/Finance')).toEqual({
      hostname: 'contoso.sharepoint.com',
      sitePath: '/sites/Finance',
    });
  });

  it('treats a bare host as the root site', () => {
    expect(parseSiteUrl('https://contoso.sharepoint.com/')).toEqual({
      hostname: 'contoso.sharepoint.com',
      sitePath: '',
    });
  });

  it('refuses a non-https or unparseable URL with a user-facing message', () => {
    expect(() => parseSiteUrl('http://contoso.sharepoint.com')).toThrow(/https/);
    expect(() => parseSiteUrl('contoso.sharepoint.com')).toThrow(GraphError);
  });
});

describe('isWorkbookName', () => {
  it('accepts the formats the reader can actually parse', () => {
    expect(isWorkbookName('Budget.xlsx')).toBe(true);
    expect(isWorkbookName('Budget.XLSM')).toBe(true);
  });

  it('rejects formats that only look close', () => {
    // .xlsb and .xls are different file formats; accepting them would fail
    // confusingly at parse time instead of clearly at listing time.
    expect(isWorkbookName('Budget.xlsb')).toBe(false);
    expect(isWorkbookName('Budget.xls')).toBe(false);
    expect(isWorkbookName('Budget.csv')).toBe(false);
  });

  it('ignores Excel lock files', () => {
    expect(isWorkbookName('~$Budget.xlsx')).toBe(false);
  });
});

describe('listWorkbooks', () => {
  it('walks folders breadth-first and returns only workbooks', async () => {
    const http = stubHttp((url) => {
      if (url.includes('/root/children')) {
        return {
          value: [
            { id: 'f1', name: 'Budgets', folder: {} },
            { id: 'x1', name: 'Notes.docx', file: {} },
            { id: 'x2', name: 'Top.xlsx', size: 10, file: {} },
          ],
        };
      }
      if (url.includes('/items/f1/children')) {
        return { value: [{ id: 'x3', name: 'Nested.xlsx', size: 20, file: {} }] };
      }
      return { value: [] };
    });
    const res = await listWorkbooks(http, 'drive-1');
    expect(res.files.map((f) => f.name)).toEqual(['Top.xlsx', 'Nested.xlsx']);
    expect(res.files[1].path).toBe('Budgets/Nested.xlsx');
    expect(res.truncated).toBe(false);
  });

  it('follows pagination', async () => {
    const http = stubHttp((url) => {
      if (url.includes('/root/children')) {
        return { value: [{ id: 'a', name: 'A.xlsx', size: 1, file: {} }], '@odata.nextLink': 'https://graph.microsoft.com/page2' };
      }
      return { value: [{ id: 'b', name: 'B.xlsx', size: 1, file: {} }] };
    });
    const res = await listWorkbooks(http, 'drive-1');
    expect(res.files.map((f) => f.name)).toEqual(['A.xlsx', 'B.xlsx']);
  });

  it('reports hitting the file cap instead of pretending the library ended', async () => {
    const http = stubHttp(() => ({
      value: Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, name: `F${i}.xlsx`, size: 1, file: {} })),
    }));
    const res = await listWorkbooks(http, 'drive-1', '', { maxFiles: 3 });
    expect(res.files).toHaveLength(3);
    expect(res.truncated).toBe(true);
  });

  it('stops descending at the depth cap and says so', async () => {
    // Every folder contains another folder — without the cap this never ends.
    const http = stubHttp(() => ({ value: [{ id: 'deeper', name: 'Sub', folder: {} }] }));
    const res = await listWorkbooks(http, 'drive-1', '', { maxDepth: 2 });
    expect(res.files).toHaveLength(0);
    expect(res.truncated).toBe(true);
  });

  it('encodes folder paths with spaces', async () => {
    const seen: string[] = [];
    const http = {
      request: vi.fn(async (req: { url: string }) => {
        seen.push(req.url);
        return { status: 200, headers: {}, body: { value: [] } };
      }),
    } as unknown as HttpClient;
    await listWorkbooks(http, 'drive-1', 'Budgets/FY 2026');
    expect(seen[0]).toContain('root:/Budgets/FY%202026:/children');
  });
});

describe('downloadItem', () => {
  it('refuses an oversized workbook by name, before spending the download', async () => {
    const http = stubHttp(() => new ArrayBuffer(8));
    await expect(downloadItem(http, 'd', file({ size: 999_000_000 }))).rejects.toThrow(/Budget 2026\.xlsx/);
    await expect(downloadItem(http, 'd', file({ size: 999_000_000 }))).rejects.toBeInstanceOf(GraphError);
  });

  it('returns the bytes for a file within the cap', async () => {
    const bytes = new ArrayBuffer(16);
    const http = stubHttp(() => bytes);
    await expect(downloadItem(http, 'd', file())).resolves.toBe(bytes);
  });
});

describe('OAuth spec', () => {
  it('requests offline_access, without which there is no refresh token', () => {
    expect(SHAREPOINT_SCOPES).toContain('offline_access');
  });

  it('requests only read scopes', () => {
    // A consent this connector holds must not be able to modify documents.
    expect(SHAREPOINT_SCOPES).not.toMatch(/ReadWrite|Write\b/);
  });

  it('builds an authorize URL Microsoft accepts', () => {
    const url = sharePointOAuth.buildAuthUrl(
      { clientId: 'abc', directory: 'common' },
      'state-token',
      'https://app.example.com/callback',
    );
    expect(url).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(url).toContain('response_mode=query');
    expect(url).toContain('state=state-token');
    // Several tenants per user is the norm for the accountancy firms this is
    // aimed at; silently reusing the browser's account picks the wrong one.
    expect(url).toContain('prompt=select_account');
  });

  it('names every pre-auth field on the config schema', () => {
    const props = Object.keys(
      (new SharePointConnector().configSchema as { properties: Record<string, unknown> }).properties,
    );
    for (const f of sharePointOAuth.preAuthFields) expect(props).toContain(f);
  });
});

describe('connector surface', () => {
  const c = new SharePointConnector();

  it('declares every host it reaches, including redirect targets', () => {
    // /content answers with a redirect to the tenant's own SharePoint host or
    // Microsoft's CDN. A list naming only Graph would mislead whoever
    // provisions the network policy from it.
    expect(c.egressAllowList).toContain('graph.microsoft.com');
    expect(c.egressAllowList).toContain('login.microsoftonline.com');
    expect(c.egressAllowList.some((h) => h.includes('sharepoint.com'))).toBe(true);
  });

  it('refuses a config that is missing required fields', async () => {
    await expect(
      c.testConnection({ clientId: 'a' }, { log: createNoopLogger() }),
    ).rejects.toThrow(/Config validation failed/);
  });

  it('does not implement probeEntities', () => {
    // Nothing to probe: a file we could list is a file we can read, so a probe
    // would issue a download per entity to learn nothing.
    expect((c as { probeEntities?: unknown }).probeEntities).toBeUndefined();
  });
});
