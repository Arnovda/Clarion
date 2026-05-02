/**
 * Static registry of source connectors.
 *
 * Adding a new connector is two changes:
 *   1. Implement `SourceConnector` in `packages/connectors/src/<vendor>/`.
 *   2. Add a line to `register()` below.
 *
 * No backend route changes, no frontend changes, no migration.
 *
 * The registry intentionally stores connector *constructors* rather than
 * singletons. Connectors should be cheap to instantiate; per-call instantiation
 * keeps each invocation isolated (no shared mutable state between tenants).
 */

import type { SourceConnector } from './types';

type ConnectorCtor = new () => SourceConnector;

const registry = new Map<string, ConnectorCtor>();

/**
 * Register a connector class. Called once at module load (see `register()`).
 * Idempotent — registering the same type twice is a no-op (warns in dev).
 */
export function registerConnector(ctor: ConnectorCtor): void {
  // Instantiate briefly to read metadata. Connector constructors must be
  // side-effect-free, so this is safe and lets us key by `type`.
  const probe = new ctor();
  const key = probe.type;
  if (!key || typeof key !== 'string') {
    throw new Error(`Connector ${ctor.name} did not expose a 'type' string`);
  }
  if (registry.has(key)) {
    // eslint-disable-next-line no-console
    console.warn(`Connector type '${key}' registered twice — ignoring duplicate`);
    return;
  }
  registry.set(key, ctor);
}

/** Look up a connector class by its `type`. Throws if unknown. */
export function getConnector(type: string): SourceConnector {
  const ctor = registry.get(type);
  if (!ctor) {
    throw new Error(`Unknown connector type: ${type}`);
  }
  return new ctor();
}

/** List all registered connector types. */
export function listConnectorTypes(): string[] {
  return Array.from(registry.keys()).sort();
}

/**
 * Catalog metadata for the wizard's "pick a source" page. Returns the
 * minimum each connector exposes — no instantiation cost, no secrets.
 */
export function listConnectorCatalog(): ConnectorCatalogEntry[] {
  return listConnectorTypes().map((type) => {
    const c = getConnector(type);
    return {
      type: c.type,
      displayName: c.displayName,
      iconSvg: c.iconSvg,
      configSchema: c.configSchema,
      egressAllowList: [...c.egressAllowList],
    };
  });
}

export interface ConnectorCatalogEntry {
  type: string;
  displayName: string;
  iconSvg?: string;
  configSchema: SourceConnector['configSchema'];
  egressAllowList: string[];
}

/** For tests: empty the registry. Never call from production code. */
export function _clearRegistryForTests(): void {
  registry.clear();
}

// Connectors self-register at module load via the package entry point
// (`index.ts` imports each connector subfolder — see `index.ts`).
// Adding a new connector: add an `import './<vendor>';` line to `index.ts`.
