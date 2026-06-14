/**
 * Runtime config validation against a connector's JSON Schema.
 *
 * `BaseSourceConnector.validateConfig` is `protected` (connectors call it
 * internally), so the backend can't reach it from a route. This helper gives
 * the platform a public, network-free way to validate a config blob against the
 * connector's `configSchema` before persisting it — closing the gap where
 * `PATCH /source-config` wrote arbitrary config straight to the encrypted cell.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { getConnector } from './registry';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export interface ConfigValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate `config` against the connector type's schema. Throws only if the
 * connector type is unknown (caller should have checked). Returns a result
 * with human-readable violations otherwise.
 */
export function validateConnectorConfig(type: string, config: unknown): ConfigValidationResult {
  const connector = getConnector(type);
  const validate = ajv.compile(connector.configSchema as object);
  if (validate(config)) return { ok: true, errors: [] };
  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
  );
  return { ok: false, errors };
}
