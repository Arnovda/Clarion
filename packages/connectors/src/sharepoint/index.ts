/**
 * Self-registers the SharePoint connector when this module is imported.
 * The package entry point (`../index.ts`) imports this file for the side effect.
 */

import { registerConnector } from '../registry';
import { SharePointConnector } from './SharePointConnector';

export { SharePointConnector } from './SharePointConnector';
export { sharePointConfigSchema, type SharePointConfig } from './schema';
export { AuthRefreshError, refreshAccessToken, sharePointOAuth, SHAREPOINT_SCOPES } from './oauth';
export { entityNameFor, entitiesForWorkbook, fileBaseName, type SharePointEntity } from './entities';
export {
  GraphError,
  isWorkbookName,
  listWorkbooks,
  parseSiteUrl,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_FOLDER_DEPTH,
  type DriveFile,
} from './graph';

registerConnector(SharePointConnector);
