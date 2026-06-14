/**
 * JSON Schema for the Odoo connector config.
 *
 * Drives the wizard form and is the validation gate inside
 * `BaseSourceConnector.validateConfig`. Odoo authenticates with an API key
 * (not OAuth and not the account password):
 *
 *   Odoo → Preferences → Account Security → New API Key
 *
 * The API key doubles as the credential for BOTH transports the connector
 * speaks:
 *   • JSON-2 (`/json/2`, Odoo 17+/Online) — sent as `Authorization: bearer <key>`
 *   • XML-RPC (`/xmlrpc/2`, older on-prem) — passed as the password argument
 *
 * No OAuth block: Odoo's external API is API-key based, which keeps the
 * connection setup a single paste-token step (simpler + no callback dance).
 */

import type { JSONSchema7 } from 'json-schema';

export const odooConfigSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://clarion.local/schemas/connectors/odoo.json',
  type: 'object',
  required: ['url', 'db', 'username', 'apiKey'],
  additionalProperties: false,
  properties: {
    url: {
      type: 'string',
      title: 'Odoo URL',
      description: 'Base URL of your Odoo instance, e.g. https://yourcompany.odoo.com',
      pattern: '^https?://[^\\s/]+',
      minLength: 1,
    },
    db: {
      type: 'string',
      title: 'Database',
      description: 'The Odoo database name. On Odoo Online this is usually the subdomain.',
      minLength: 1,
    },
    username: {
      type: 'string',
      title: 'Username',
      description: 'The login (email) of the Odoo user the API key belongs to. Use a dedicated, least-privilege read-only user.',
      minLength: 1,
    },
    apiKey: {
      type: 'string',
      title: 'API Key',
      description: 'Odoo → Preferences → Account Security → New API Key. Encrypted at rest.',
      minLength: 1,
    },
  },
};

/** Strongly-typed config shape that mirrors the schema above. */
export interface OdooConfig {
  /** Base URL, no trailing slash required. */
  url: string;
  db: string;
  username: string;
  apiKey: string;
}

/** Narrowing helper — assumes config has already been validated. */
export function asOdooConfig(raw: Record<string, unknown>): OdooConfig {
  const c = raw as unknown as OdooConfig;
  return { ...c, url: c.url.replace(/\/+$/, '') };
}
