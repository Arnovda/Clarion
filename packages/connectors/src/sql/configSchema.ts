/**
 * One config schema for every SQL source.
 *
 * The fields a relational database needs are the same everywhere — host, port,
 * database, credentials, which schema, whether to encrypt — so they are
 * described once. Three hand-maintained copies would drift in wording and
 * defaults, and the wizard would end up explaining the same choice three
 * different ways to the same user.
 *
 * Dialects vary only the labels that are genuinely dialect-specific (MySQL has
 * no schema layer; SQL Server says "encrypt" where Postgres says "SSL").
 */

import type { JSONSchema7 } from 'json-schema';

export interface SqlConfigSchemaOptions {
  /** Connector type, used for the schema `$id`. */
  id: string;
  displayName: string;
  defaultPort: number;
  /** Label + help for the schema/database selector. */
  schemaField: { title: string; description: string; default?: string } | null;
  /** Label + help for the transport-encryption toggle. */
  sslField: { title: string; description: string };
}

export function sqlConfigSchema(opts: SqlConfigSchemaOptions): JSONSchema7 {
  const properties: Record<string, JSONSchema7> = {
    host: {
      type: 'string',
      title: 'Host',
      description: `Hostname or IP address of the ${opts.displayName} server.`,
      minLength: 1,
    },
    port: {
      type: 'integer',
      title: 'Port',
      description: `Defaults to ${opts.defaultPort}.`,
      minimum: 1,
      maximum: 65535,
      default: opts.defaultPort,
    },
    database: {
      type: 'string',
      title: 'Database',
      description: 'The database to read from.',
      minLength: 1,
    },
    user: {
      type: 'string',
      title: 'Username',
      description:
        'Use a dedicated account with read permission only. Clarion never writes to your database, ' +
        'and a read-only account is the one guarantee of that which does not depend on Clarion.',
      minLength: 1,
    },
    password: {
      type: 'string',
      title: 'Password',
      description: 'Encrypted at rest with AES-256-GCM.',
      minLength: 1,
    },
    ssl: {
      type: 'boolean',
      title: opts.sslField.title,
      description: opts.sslField.description,
      default: false,
    },
    includeViews: {
      type: 'boolean',
      title: 'Include views',
      description:
        'Also offer views, not just tables. A view is recomputed on every read, so a slow one makes for a slow sync.',
      default: false,
    },
    incrementalDetection: {
      type: 'string',
      title: 'Incremental sync',
      description:
        'Clarion syncs a table incrementally when it finds a NOT NULL modified-timestamp column ' +
        '(updated_at, modified_date and similar) alongside a single-column primary key. ' +
        'Choose "off" if your application does not reliably maintain those — every table is then read ' +
        'in full each time, which is slower but cannot miss a change.',
      enum: ['auto', 'off'],
      default: 'auto',
    },
  };

  if (opts.schemaField) {
    properties.schema = {
      type: 'string',
      title: opts.schemaField.title,
      description: opts.schemaField.description,
      ...(opts.schemaField.default ? { default: opts.schemaField.default } : {}),
    };
  }

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `https://clarion.local/schemas/connectors/${opts.id}.json`,
    type: 'object',
    required: ['host', 'database', 'user', 'password'],
    additionalProperties: false,
    properties,
  };
}
