import neo4j, { Driver, Session } from 'neo4j-driver';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'neo4j' });

let _driver: Driver | null = null;

function getDriver(): Driver {
  if (!_driver) {
    const uri      = process.env.NEO4J_URI      ?? 'bolt://localhost:7687';
    const user     = process.env.NEO4J_USER     ?? 'neo4j';
    const password = process.env.NEO4J_PASSWORD ?? 'databridge_secret';
    _driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      // Bound a hung connect so the cold-start retry in getSession() paces
      // correctly while Neo4j is scaling up from zero (Container Apps idle).
      connectionTimeout: 15000,
    });
  }
  return _driver;
}

/**
 * Transient connection errors worth retrying — these are what a Neo4j that has
 * scaled to zero throws while it wakes (connection refused / service
 * unavailable during the ~30–60s JVM cold start).
 */
const TRANSIENT_NEO4J = /ServiceUnavailable|SessionExpired|routing|connection|ECONNREFUSED|ECONNRESET|Failed to connect|WebSocket|Connection acquisition|Pool is closed/i;

export function getSession(): Session {
  const database = process.env.NEO4J_DATABASE ?? 'neo4j';
  const session = getDriver().session({ database });

  // Wrap run() with bounded exponential backoff so the FIRST semantic query
  // after the Neo4j container has scaled to zero waits for it to wake instead
  // of erroring. Every call site does `await session.run(...)` and reads
  // `.records` / `.summary`, so transparently returning a Promise<QueryResult>
  // is safe (a neo4j Result already is a thenable resolving to QueryResult).
  // Total worst-case wait ≈ 39s across 8 attempts — roughly a JVM cold start.
  const rawRun = session.run.bind(session);
  (session as unknown as { run: (...a: Parameters<Session['run']>) => Promise<unknown> }).run =
    async (...args: Parameters<Session['run']>) => {
      let delayMs = 1000;
      const maxAttempts = 8;
      for (let attempt = 1; ; attempt++) {
        try {
          return await rawRun(...args);
        } catch (err) {
          const code = (err as { code?: string })?.code ?? '';
          const msg = err instanceof Error ? err.message : String(err);
          const transient =
            code === 'ServiceUnavailable' || code === 'SessionExpired' || TRANSIENT_NEO4J.test(msg);
          if (!transient || attempt >= maxAttempts) throw err;
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs = Math.min(delayMs * 2, 8000);
        }
      }
    };

  return session;
}

// Call once at app startup — idempotent, safe to re-run.
export async function ensureNeo4jConstraints(): Promise<void> {
  // Retry up to 10 times with 3-second delays — Neo4j container takes ~30s to be ready.
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const session = getSession();
    try {
      const constraints: Array<[string, string]> = [
        ['SourceTable_pgId',       'CREATE CONSTRAINT sourceTable_pgId    IF NOT EXISTS FOR (n:SourceTable)      REQUIRE n.pgId IS UNIQUE'],
        ['SourceColumn_pgId',      'CREATE CONSTRAINT sourceColumn_pgId   IF NOT EXISTS FOR (n:SourceColumn)     REQUIRE n.pgId IS UNIQUE'],
        ['KpiDefinition_pgId',     'CREATE CONSTRAINT kpiDefinition_pgId  IF NOT EXISTS FOR (n:KpiDefinition)    REQUIRE n.pgId IS UNIQUE'],
        ['CrossSourceView_pgId',   'CREATE CONSTRAINT crossView_pgId      IF NOT EXISTS FOR (n:CrossSourceView)  REQUIRE n.pgId IS UNIQUE'],
        ['QualityRule_pgId',       'CREATE CONSTRAINT qualityRule_pgId    IF NOT EXISTS FOR (n:QualityRule)      REQUIRE n.pgId IS UNIQUE'],
        ['ProductTable_pgId',      'CREATE CONSTRAINT productTable_pgId   IF NOT EXISTS FOR (n:ProductTable)     REQUIRE n.pgId IS UNIQUE'],
        ['ProductColumn_pgId',     'CREATE CONSTRAINT productColumn_pgId  IF NOT EXISTS FOR (n:ProductColumn)    REQUIRE n.pgId IS UNIQUE'],
      ];

      // Indexes on tenantId for future multi-tenant Neo4j filtering
      const indexes: string[] = [
        'CREATE INDEX sourceTable_tenantId   IF NOT EXISTS FOR (n:SourceTable)      ON (n.tenantId)',
        'CREATE INDEX sourceColumn_tenantId  IF NOT EXISTS FOR (n:SourceColumn)     ON (n.tenantId)',
        'CREATE INDEX kpiDef_tenantId        IF NOT EXISTS FOR (n:KpiDefinition)    ON (n.tenantId)',
        'CREATE INDEX crossView_tenantId     IF NOT EXISTS FOR (n:CrossSourceView)  ON (n.tenantId)',
        'CREATE INDEX qualityRule_tenantId   IF NOT EXISTS FOR (n:QualityRule)      ON (n.tenantId)',
        'CREATE INDEX productTable_productId IF NOT EXISTS FOR (n:ProductTable)     ON (n.dataProductId)',
        'CREATE INDEX productColumn_tablePgId IF NOT EXISTS FOR (n:ProductColumn)   ON (n.tablePgId)',
        'CREATE INDEX productTable_tenantId  IF NOT EXISTS FOR (n:ProductTable)     ON (n.tenantId)',
        'CREATE INDEX productColumn_tenantId IF NOT EXISTS FOR (n:ProductColumn)    ON (n.tenantId)',
      ];
      for (const [, cypher] of constraints) {
        await session.run(cypher);
      }
      for (const cypher of indexes) {
        await session.run(cypher);
      }
      log.info('Neo4j constraints verified.');
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        log.info(`Neo4j not ready yet (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in 3s…`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        log.error({ msg }, 'Neo4j failed to become ready after all retries');
        // Non-fatal — app can still start; Neo4j writes will fail gracefully.
      }
    } finally {
      await session.close();
    }
  }
}

export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}
