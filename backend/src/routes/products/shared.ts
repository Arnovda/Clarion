/**
 * Shared state for the products router modules. The original single-file
 * routes/products.ts had ONE module-level logger child; keeping it in one
 * home avoids each sub-module growing divergent copies of shared state.
 */
import { logger as rootLogger } from '../../utils/logger';

export const log = rootLogger.child({ mod: 'products' });
