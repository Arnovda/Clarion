/**
 * JSON Schema for the SharePoint connector config.
 *
 * Drives the wizard form and is the validation gate inside
 * `BaseSourceConnector.validateConfig`. Shape mirrors the ExactOnline
 * connector deliberately: pre-auth fields the user fills in, then tokens the
 * OAuth handshake fills in and the platform keeps encrypted.
 *
 * The user registers an app once in Entra ID (formerly Azure AD) and pastes
 * its client id + secret, exactly as they do for Exact Online. Required
 * delegated permissions: `Files.Read.All`, `Sites.Read.All`, `offline_access`.
 * Read-only by construction — the connector never requests a write scope, so
 * no consent it holds can modify a customer's documents.
 */

import type { JSONSchema7 } from 'json-schema';

export const sharePointConfigSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://clarion.local/schemas/connectors/sharepoint.json',
  type: 'object',
  required: ['clientId', 'clientSecret', 'directory', 'siteUrl'],
  additionalProperties: false,
  properties: {
    clientId: {
      type: 'string',
      title: 'Application (client) ID',
      description: 'From your Entra ID app registration — Overview → Application (client) ID.',
      minLength: 1,
    },
    clientSecret: {
      type: 'string',
      title: 'Client secret',
      description: 'Entra ID app registration → Certificates & secrets. Encrypted at rest.',
      minLength: 1,
    },
    directory: {
      type: 'string',
      title: 'Directory (tenant) ID',
      description:
        "Your Entra ID directory ID, or 'common' for a multi-tenant app registration. "
        + 'Found on the app registration Overview page.',
      // Either a GUID or one of Microsoft's reserved words. Anything else is a
      // typo that would otherwise fail deep in the OAuth redirect with a
      // Microsoft error page rather than a wizard message.
      pattern: '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|common|organizations|consumers|[A-Za-z0-9.-]+\\.[A-Za-z]{2,})$',
      default: 'common',
      minLength: 1,
    },
    siteUrl: {
      type: 'string',
      title: 'SharePoint site URL',
      description:
        'The site holding your files, e.g. https://contoso.sharepoint.com/sites/Finance. '
        + 'For files on personal OneDrive use your OneDrive URL.',
      pattern: '^https://[^\\s/]+/?.*$',
      minLength: 1,
    },
    folderPath: {
      type: 'string',
      title: 'Folder (optional)',
      description:
        'Restrict to one folder inside the document library, e.g. Budgets/2026. '
        + 'Leave empty to read the whole library.',
      default: '',
    },
    libraryName: {
      type: 'string',
      title: 'Document library (optional)',
      description:
        "Name of the document library to read. Leave empty for the site's default library "
        + '(usually "Documents").',
      default: '',
    },
    headerRow: {
      type: 'boolean',
      title: 'First row contains column names',
      description:
        'Almost always true. Turn it off for sheets that start straight into data — '
        + 'columns are then named by position.',
      default: true,
    },
    // ─── Tokens populated by the OAuth flow ─────────────────────────────
    // Not in `preAuthFields`, so the wizard never renders them as inputs.
    refreshToken: {
      type: 'string',
      title: 'Refresh token (managed)',
      description: 'Issued during the OAuth handshake. Rotated automatically and re-encrypted on each use.',
    },
    accessToken: {
      type: 'string',
      title: 'Access token (managed)',
      description: 'Issued during the OAuth handshake. Used directly until near expiry.',
    },
    accessTokenExpiresAt: {
      type: 'integer',
      title: 'Access token expiry (managed)',
      description: 'Unix-ms timestamp; a refresh fires when within 60s of this.',
    },
  },
};

/** Strongly-typed config shape that mirrors the schema above. */
export interface SharePointConfig {
  clientId: string;
  clientSecret: string;
  /** Entra ID directory id, or one of Microsoft's reserved words. */
  directory: string;
  siteUrl: string;
  folderPath?: string;
  libraryName?: string;
  headerRow?: boolean;
  /** Managed by the OAuth flow. */
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
}

/**
 * Narrowing helper — assumes the config has already been validated.
 * Normalises the two fields whose trailing/leading slashes would otherwise
 * change the Graph URLs they are spliced into.
 */
export function asSharePointConfig(raw: Record<string, unknown>): SharePointConfig {
  const c = raw as unknown as SharePointConfig;
  return {
    ...c,
    siteUrl: c.siteUrl.replace(/\/+$/, ''),
    folderPath: (c.folderPath ?? '').replace(/^\/+|\/+$/g, ''),
  };
}
