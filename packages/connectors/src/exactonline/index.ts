/**
 * Self-registers the ExactOnline connector when this module is imported.
 * The main `registry.register()` function imports this file.
 */

import { registerConnector } from '../registry';
import { ExactOnlineConnector } from './ExactOnlineConnector';

export { ExactOnlineConnector } from './ExactOnlineConnector';
export { exactOnlineConfigSchema } from './schema';
export { EXACT_ONLINE_ENTITIES } from './entities';
export { AuthRefreshError, refreshAccessToken } from './oauth';

registerConnector(ExactOnlineConnector);
