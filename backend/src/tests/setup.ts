/**
 * Vitest global setup — runs before all test files.
 *
 * Sets environment variables so the app connects to the test database
 * and uses a known JWT secret. Runs migrations to ensure schema is current.
 */

import dotenv from 'dotenv';
import path from 'path';

// Load .env first so DATABASE_URL etc. have defaults
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Override to use test database
const baseUrl = process.env.DATABASE_URL ?? 'postgresql://databridge:databridge@localhost:5432/databridge';
const testDbUrl = baseUrl.replace(/\/[^/]+$/, '/databridge_test');
process.env.DATABASE_URL = testDbUrl;
process.env.JWT_SECRET = 'test-secret-key-do-not-use-in-production';
process.env.JWT_ACCESS_EXPIRES_IN = '1h';
process.env.NODE_ENV = 'test';

// Disable Neo4j in tests (avoid connection errors)
process.env.NEO4J_URI = '';

// No Redis in tests, whatever the developer's .env says — the suite asserts
// inline-execution and "no data" behaviours (rate-limit MemoryStore fallback,
// null traffic stats on /admin/tenants), which a live Redis would flip.
process.env.REDIS_URL = '';
