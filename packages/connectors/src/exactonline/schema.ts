/**
 * JSON Schema for the ExactOnline connector config.
 *
 * Drives the wizard form (rendered with @rjsf in the frontend) and is also
 * the validation gate inside `BaseSourceConnector.validateConfig`.
 *
 * Field choices reflect the MVP we agreed on:
 *   • paste-token model (no OAuth callback)
 *   • single division per connection
 *   • baseUrl picker for .nl / .be / .com etc.
 *
 * If we ever add OAuth callback flow, we add `accessToken` as a managed
 * field and let `refreshToken` be derived. Keep the schema additive.
 */

import type { JSONSchema7 } from 'json-schema';

export const exactOnlineConfigSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://clarion.local/schemas/connectors/exactonline.json',
  type: 'object',
  required: ['clientId', 'clientSecret', 'refreshToken', 'division', 'baseUrl'],
  additionalProperties: false,
  properties: {
    clientId: {
      type: 'string',
      title: 'Client ID',
      description: 'OAuth client ID from your ExactOnline app registration.',
      minLength: 1,
    },
    clientSecret: {
      type: 'string',
      title: 'Client secret',
      description: 'OAuth client secret. Encrypted at rest.',
      minLength: 1,
      // The wizard renders this as a password field via UI hints (rjsf "ui:widget").
      // Schema-level we just declare it sensitive.
    },
    refreshToken: {
      type: 'string',
      title: 'Refresh token',
      description:
        'Long-lived refresh token. Paste from Postman or your existing app. Will be rotated automatically on each sync — the new one is encrypted and persisted.',
      minLength: 1,
    },
    division: {
      type: 'string',
      title: 'Division code',
      description: 'Numeric ExactOnline division code, e.g. 3122948.',
      pattern: '^[0-9]+$',
      minLength: 1,
    },
    baseUrl: {
      type: 'string',
      title: 'Base URL',
      description: 'Region-specific ExactOnline endpoint.',
      enum: [
        'https://start.exactonline.nl',
        'https://start.exactonline.be',
        'https://start.exactonline.com',
        'https://start.exactonline.de',
        'https://start.exactonline.fr',
        'https://start.exactonline.es',
        'https://start.exactonline.co.uk',
        'https://start.exactonline.us',
      ],
      default: 'https://start.exactonline.nl',
    },
    // ─── Internal tokens populated by the OAuth flow ─────────────────────
    // EO rate-limits the refresh endpoint: if the issued access_token is
    // still valid, calling refresh returns 400 access_denied with
    // "access_token not expired". So we store the access_token alongside
    // the refresh_token and only refresh when the access_token is near
    // expiry. Both fields are optional in the schema (paste-token flows
    // don't have them) and hidden from the wizard form (not in OAuth's
    // preAuthFields).
    accessToken: {
      type: 'string',
      title: 'Access token (managed)',
      description: 'Issued during OAuth handshake. Used directly until near expiry.',
    },
    accessTokenExpiresAt: {
      type: 'integer',
      title: 'Access token expiry (managed)',
      description: 'Unix-ms timestamp; refresh fires when within 30s of this.',
    },
  },
};

/** Strongly-typed config shape that mirrors the schema above. */
export interface ExactOnlineConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  division: string;
  baseUrl: string;
  /** Tokens managed by the OAuth flow — undefined for paste-token connections. */
  accessToken?: string;
  /** Unix-ms; refresh fires when within 30s of this value. */
  accessTokenExpiresAt?: number;
}

/** Narrowing helper — assumes config has already been validated against `exactOnlineConfigSchema`. */
export function asExactOnlineConfig(raw: Record<string, unknown>): ExactOnlineConfig {
  return raw as unknown as ExactOnlineConfig;
}
