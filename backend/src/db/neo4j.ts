import neo4j, { Driver, Session } from 'neo4j-driver';

let _driver: Driver | null = null;

function getDriver(): Driver {
  if (!_driver) {
    const uri      = process.env.NEO4J_URI      ?? 'bolt://localhost:7687';
    const user     = process.env.NEO4J_USER     ?? 'neo4j';
    const password = process.env.NEO4J_PASSWORD ?? 'databridge_secret';
    _driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }
  return _driver;
}

export function getSession(): Session {
  const database = process.env.NEO4J_DATABASE ?? 'neo4j';
  return getDriver().session({ database });
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
      ];

      // Indexes on tenantId for future multi-tenant Neo4j filtering
      const indexes: string[] = [
        'CREATE INDEX sourceTable_tenantId   IF NOT EXISTS FOR (n:SourceTable)      ON (n.tenantId)',
        'CREATE INDEX sourceColumn_tenantId  IF NOT EXISTS FOR (n:SourceColumn)     ON (n.tenantId)',
        'CREATE INDEX kpiDef_tenantId        IF NOT EXISTS FOR (n:KpiDefinition)    ON (n.tenantId)',
        'CREATE INDEX crossView_tenantId     IF NOT EXISTS FOR (n:CrossSourceView)  ON (n.tenantId)',
        'CREATE INDEX qualityRule_tenantId   IF NOT EXISTS FOR (n:QualityRule)      ON (n.tenantId)',
      ];
      for (const [, cypher] of constraints) {
        await session.run(cypher);
      }
      for (const cypher of indexes) {
        await session.run(cypher);
      }
      console.log('Neo4j constraints verified.');
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        console.log(`Neo4j not ready yet (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in 3s…`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.error('Neo4j failed to become ready after all retries:', msg);
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
