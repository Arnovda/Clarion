/**
 * Self-registers the Odoo connector when this module is imported.
 * The package entry point (`../index.ts`) imports this file for the side effect.
 */

import { registerConnector } from '../registry';
import { OdooConnector } from './OdooConnector';

export { OdooConnector } from './OdooConnector';
export { odooConfigSchema, type OdooConfig } from './schema';
export { ODOO_ENTITIES, ODOO_KNOWN_RELATIONSHIPS, ODOO_ALLOWLIST } from './entities';

registerConnector(OdooConnector);
