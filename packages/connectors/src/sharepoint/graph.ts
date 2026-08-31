/**
 * Microsoft Graph calls the SharePoint connector needs, and nothing else.
 *
 * Kept apart from `SharePointConnector.ts` for the same reason Odoo keeps its
 * transports separate: the connector should read as the lifecycle contract
 * (test / list / sync), not as a pile of REST plumbing. Everything here takes
 * an `HttpClient` so the retry, pacing, 401-refresh and egress rules apply to
 * every call including the file downloads.
 *
 * Bounds are the important part of this file. A document library is not an
 * API with a fixed entity catalog — it is whatever the customer put in it,
 * which can be thousands of files including holiday photos. Every traversal
 * here is capped, and hitting a cap is REPORTED rather than silently obeyed,
 * so the wizard can say "showing the first 100 of more" instead of pretending
 * the library ends there.
 */

import type { HttpClient } from '../HttpClient';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** How far below the starting folder to descend. Nested year folders are common. */
export const MAX_FOLDER_DEPTH = 4;
/** How many spreadsheets to enumerate. Beyond this the user should pick a folder. */
export const MAX_FILES = 100;
/**
 * Largest workbook to download. The reader materialises a sheet before the
 * connector streams it and the sync worker has 1 GiB, so an enormous workbook
 * has to be refused rather than attempted — refusing names the file; an OOM
 * kills the whole sync and names nothing.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  /** Path below the drive root, for display and for entity naming. */
  path: string;
  size: number;
  lastModified?: string;
}

export interface ListResult {
  files: DriveFile[];
  /** True when a cap stopped the walk before the library was exhausted. */
  truncated: boolean;
}

interface GraphList<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
}

/**
 * Split a SharePoint site URL into the hostname + server-relative path Graph
 * addresses sites by.
 *
 * `https://contoso.sharepoint.com/sites/Finance` → host `contoso.sharepoint.com`,
 * path `/sites/Finance`. A bare host (the root site) yields an empty path,
 * which Graph addresses differently — hence the distinction rather than
 * always appending a colon segment.
 */
export function parseSiteUrl(siteUrl: string): { hostname: string; sitePath: string } {
  let u: URL;
  try {
    u = new URL(siteUrl);
  } catch {
    throw new GraphError(`'${siteUrl}' is not a valid URL. Copy it from your browser's address bar.`);
  }
  if (u.protocol !== 'https:') {
    throw new GraphError('The SharePoint site URL must start with https://');
  }
  const path = u.pathname.replace(/\/+$/, '');
  return { hostname: u.hostname, sitePath: path === '/' ? '' : path };
}

/** Resolve a site URL to the Graph site id every later call is keyed on. */
export async function resolveSiteId(http: HttpClient, siteUrl: string): Promise<{ id: string; displayName?: string }> {
  const { hostname, sitePath } = parseSiteUrl(siteUrl);
  // Graph addresses a site as `{hostname}:{server-relative-path}`; the root
  // site of a host is addressed by hostname alone.
  const target = sitePath ? `${hostname}:${sitePath}` : hostname;
  const resp = await http.request<{ id: string; displayName?: string }>({
    url: `${GRAPH_BASE}/sites/${target}`,
  });
  if (!resp.body?.id) {
    throw new GraphError(`Could not find a SharePoint site at ${siteUrl}.`);
  }
  return { id: resp.body.id, displayName: resp.body.displayName };
}

/**
 * Pick the document library to read.
 *
 * With no `libraryName` the site's default library is used, which is what
 * "Documents" means to a user who never renamed it. A named library that does
 * not exist is an error that lists what DOES exist — the alternative is a
 * silent fall back to the default library, which would sync the wrong files
 * and look like it worked.
 */
export async function resolveDriveId(
  http: HttpClient,
  siteId: string,
  libraryName?: string,
): Promise<{ id: string; name: string }> {
  const resp = await http.request<GraphList<{ id: string; name: string }>>({
    url: `${GRAPH_BASE}/sites/${encodeURIComponent(siteId)}/drives`,
  });
  const drives = resp.body?.value ?? [];
  if (drives.length === 0) {
    throw new GraphError('This SharePoint site has no document libraries.');
  }
  if (!libraryName) {
    // Graph returns the default library first for a site.
    return { id: drives[0].id, name: drives[0].name };
  }
  const wanted = libraryName.trim().toLowerCase();
  const hit = drives.find((d) => d.name.toLowerCase() === wanted);
  if (!hit) {
    const names = drives.map((d) => d.name).join(', ');
    throw new GraphError(`No document library called '${libraryName}'. This site has: ${names}.`);
  }
  return { id: hit.id, name: hit.name };
}

/** Percent-encode a folder path segment-wise, keeping the separators. */
function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

/**
 * Walk a drive for spreadsheets, breadth-first, bounded on every axis.
 *
 * Breadth-first rather than depth-first on purpose: when the caps bite, the
 * files a user sees are the ones nearest the folder they pointed at, which is
 * far more likely to be what they meant than an arbitrary deep branch.
 */
export async function listWorkbooks(
  http: HttpClient,
  driveId: string,
  folderPath = '',
  opts: { maxFiles?: number; maxDepth?: number } = {},
): Promise<ListResult> {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const maxDepth = opts.maxDepth ?? MAX_FOLDER_DEPTH;
  const drive = `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}`;

  const rootUrl = folderPath
    ? `${drive}/root:/${encodePath(folderPath)}:/children`
    : `${drive}/root/children`;

  const files: DriveFile[] = [];
  let truncated = false;
  const queue: Array<{ url: string; path: string; depth: number }> = [
    { url: rootUrl, path: folderPath, depth: 0 },
  ];

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    if (files.length >= maxFiles) { truncated = true; break; }

    let next: string | undefined = node.url;
    while (next) {
      const resp: { body: GraphList<DriveItem> } = await http.request<GraphList<DriveItem>>({ url: next });
      for (const item of resp.body?.value ?? []) {
        const childPath = node.path ? `${node.path}/${item.name}` : item.name;
        if (item.folder) {
          if (node.depth + 1 <= maxDepth) {
            queue.push({
              url: `${drive}/items/${encodeURIComponent(item.id)}/children`,
              path: childPath,
              depth: node.depth + 1,
            });
          } else {
            truncated = true;
          }
          continue;
        }
        if (!isWorkbookName(item.name)) continue;
        if (files.length >= maxFiles) { truncated = true; break; }
        files.push({
          id: item.id,
          name: item.name,
          path: childPath,
          size: item.size ?? 0,
          lastModified: item.lastModifiedDateTime,
        });
      }
      next = resp.body?.['@odata.nextLink'];
      if (files.length >= maxFiles) { truncated = true; break; }
    }
  }

  return { files, truncated };
}

/**
 * Is this a file the connector can read?
 *
 * `.xlsm` is included (a macro-enabled workbook is an ordinary xlsx package
 * plus a macro part the reader ignores); `.xlsb` is NOT — it is a different,
 * binary format, and accepting it would fail confusingly at parse time
 * instead of clearly at listing time. `.xls` is the pre-2007 format and is
 * likewise a different file entirely.
 */
export function isWorkbookName(name: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(name) && !name.startsWith('~$');
}

/** Download one drive item's bytes, refusing anything over the size cap. */
export async function downloadItem(
  http: HttpClient,
  driveId: string,
  item: DriveFile,
  maxBytes = MAX_FILE_BYTES,
): Promise<ArrayBuffer> {
  if (item.size > maxBytes) {
    throw new GraphError(
      `'${item.name}' is ${Math.round(item.size / 1024 / 1024)} MB, over the ${Math.round(maxBytes / 1024 / 1024)} MB limit `
      + 'for a spreadsheet source. Split the file, or load this data from a database instead.',
    );
  }
  const resp = await http.request<ArrayBuffer>({
    url: `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}/content`,
    responseType: 'arraybuffer',
    // Downloads are the slowest call this connector makes; the client's
    // default 60s is tight for a 50 MB workbook over a slow link.
    timeoutMs: 180_000,
  });
  const body = resp.body as unknown;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    const v = body as ArrayBufferView;
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  throw new GraphError(`Downloading '${item.name}' returned an unexpected response.`);
}

/**
 * A Graph interaction failed for a reason the user can act on. Messages are
 * shown verbatim in the wizard and in sync warnings, so they name the thing
 * the user recognises (a site URL, a library, a file) and never an id.
 */
export class GraphError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GraphError';
  }
}
