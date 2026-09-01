/**
 * backfill-graph-tenant — stamp `tenantId` onto graph nodes written before the
 * write paths started setting it.
 *
 * This is the second of three steps towards tenant-scoping the semantic graph:
 *
 *   1. every write stamps tenantId          (done; held by lint-graph-tenant-stamp)
 *   2. existing nodes are backfilled        (this script)
 *   3. reads gain a tenant predicate        (only after 2 reports zero remaining)
 *
 * Step 3 must not land before this reports clean. Neo4j has no tenant scoping,
 * so an unstamped node is not a leak once predicates exist — it is worse in a
 * quieter way: it silently disappears from its owner's catalog. A tenant whose
 * tables were profiled before the stamping change would simply see nothing.
 *
 * Postgres is the source of truth for ownership. Every graph entity reaches a
 * tenant through a mirror row:
 *
 *   SourceTable / SourceColumn   connectionId  → connections.tenant_id
 *   KpiDefinition / QualityRule  connectionId  → connections.tenant_id
 *   ProductTable / ProductColumn dataProductId → data_products.tenant_id
 *   CrossSourceView              connectionId  → connections.tenant_id (nullable)
 *   RELATES_TO                   its source table's connectionId
 *
 * Read-only against Postgres; writes only `tenantId`, only where it is missing.
 * Idempotent — safe to re-run, and re-running is the check.
 *
 *   npx tsx backend/src/scripts/backfillGraphTenant.ts          # report only
 *   npx tsx backend/src/scripts/backfillGraphTenant.ts --apply  # write
 *
 * `GRAPH_BACKFILL_MODE=apply` in the environment means the same as `--apply`.
 * It exists because the Container Apps Job that runs this in production is
 * created with `az containerapp job create`, whose `--args` parser rejects
 * any value beginning with `--` ("unrecognized arguments: --apply", measured
 * 2026-09-01 on the first apply-mode run). Environment variables have no such
 * restriction, so the workflow passes the mode that way.
 *
 * It lives under src/, not scripts/, for one reason: Neo4j runs with
 * `external_enabled = false`, so nothing outside the Container Apps environment
 * can reach it — correctly. Only src/ is compiled into the production image, so
 * this is the difference between a script that can be run against production
 * and one that can only be run against a laptop. `src/syncAllProducts.ts` is
 * here for the same reason.
 */
import { semanticDb } from '../db/knex';
import { getSession, closeDriver } from '../db/neo4j';

const APPLY =
  process.argv.includes('--apply') ||
  (process.env.GRAPH_BACKFILL_MODE ?? '').trim().toLowerCase() === 'apply';

interface Plan {
  label: string;
  /** Cypher returning the nodes still missing tenantId, with their owner key. */
  countCypher: string;
  /** Cypher applying a { key → tenantId } map. */
  applyCypher: string;
  /** Postgres lookup: owner key → tenant id. */
  ownerMap(): Promise<Map<number, number>>;
}

async function connectionOwners(): Promise<Map<number, number>> {
  const rows = await semanticDb('connections').select('id', 'tenant_id');
  return new Map(rows.filter((r) => r.tenant_id != null).map((r) => [Number(r.id), Number(r.tenant_id)]));
}

async function productOwners(): Promise<Map<number, number>> {
  const rows = await semanticDb('data_products').select('id', 'tenant_id');
  return new Map(rows.filter((r) => r.tenant_id != null).map((r) => [Number(r.id), Number(r.tenant_id)]));
}

const PLANS: Plan[] = [
  {
    label: 'SourceTable',
    countCypher: `MATCH (n:SourceTable) WHERE n.tenantId IS NULL RETURN count(n) AS c`,
    applyCypher: `UNWIND $pairs AS p
                  MATCH (n:SourceTable {connectionId: p.key}) WHERE n.tenantId IS NULL
                  SET n.tenantId = p.tenantId RETURN count(n) AS c`,
    ownerMap: connectionOwners,
  },
  {
    // Columns hang off their table, so they inherit rather than needing a key
    // of their own — and inheriting is more robust than re-deriving, because
    // the table's own tenantId has just been set (or was already correct).
    label: 'SourceColumn',
    countCypher: `MATCH (n:SourceColumn) WHERE n.tenantId IS NULL RETURN count(n) AS c`,
    applyCypher: `MATCH (t:SourceTable)-[:HAS_COLUMN]->(n:SourceColumn)
                  WHERE n.tenantId IS NULL AND t.tenantId IS NOT NULL
                  SET n.tenantId = t.tenantId RETURN count(n) AS c`,
    ownerMap: async () => new Map(),
  },
  {
    label: 'ProductTable',
    countCypher: `MATCH (n:ProductTable) WHERE n.tenantId IS NULL RETURN count(n) AS c`,
    applyCypher: `UNWIND $pairs AS p
                  MATCH (n:ProductTable {dataProductId: p.key}) WHERE n.tenantId IS NULL
                  SET n.tenantId = p.tenantId RETURN count(n) AS c`,
    ownerMap: productOwners,
  },
  {
    label: 'ProductColumn',
    countCypher: `MATCH (n:ProductColumn) WHERE n.tenantId IS NULL RETURN count(n) AS c`,
    applyCypher: `MATCH (t:ProductTable)-[:HAS_COLUMN]->(n:ProductColumn)
                  WHERE n.tenantId IS NULL AND t.tenantId IS NOT NULL
                  SET n.tenantId = t.tenantId RETURN count(n) AS c`,
    ownerMap: async () => new Map(),
  },
  {
    label: 'KpiDefinition',
    countCypher: `MATCH (n:KpiDefinition) WHERE n.tenantId IS NULL RETURN count(n) AS c`,
    applyCypher: `UNWIND $pairs AS p
                  MATCH (n:KpiDefinition {connectionId: p.key}) WHERE n.tenantId IS NULL
                  SET n.tenantId = p.tenantId RETURN count(n) AS c`,
    ownerMap: connectionOwners,
  },
  {
    label: 'QualityRule',
    countCypher: `MATCH (n:QualityRule) WHERE n.tenantId IS NULL RETURN count(n) AS c`,
    applyCypher: `UNWIND $pairs AS p
                  MATCH (n:QualityRule {connectionId: p.key}) WHERE n.tenantId IS NULL
                  SET n.tenantId = p.tenantId RETURN count(n) AS c`,
    ownerMap: connectionOwners,
  },
  {
    // connectionId is nullable on this label — a view spanning sources has
    // none. Those cannot be attributed from Postgres and are reported, not
    // guessed: assigning the wrong tenant is worse than leaving it unstamped.
    label: 'CrossSourceView',
    countCypher: `MATCH (n:CrossSourceView) WHERE n.tenantId IS NULL RETURN count(n) AS c`,
    applyCypher: `UNWIND $pairs AS p
                  MATCH (n:CrossSourceView {connectionId: p.key}) WHERE n.tenantId IS NULL
                  SET n.tenantId = p.tenantId RETURN count(n) AS c`,
    ownerMap: connectionOwners,
  },
];

const EDGE_PLAN = {
  label: 'RELATES_TO',
  countCypher: `MATCH ()-[r:RELATES_TO]->() WHERE r.tenantId IS NULL RETURN count(r) AS c`,
  applyCypher: `MATCH (ft:SourceTable)-[r:RELATES_TO]->()
                WHERE r.tenantId IS NULL AND ft.tenantId IS NOT NULL
                SET r.tenantId = ft.tenantId RETURN count(r) AS c`,
};

async function countMissing(cypher: string): Promise<number> {
  const session = getSession();
  try {
    const res = await session.run(cypher);
    return Number(res.records[0]?.get('c') ?? 0);
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  process.stdout.write(
    `backfill-graph-tenant — ${APPLY ? 'APPLY' : 'REPORT ONLY (pass --apply to write)'}\n\n`,
  );

  // Configuration visibility — names and lengths only, never values. The
  // first production execution failed with a Neo4j auth rejection and there
  // was no way to tell from the output whether the cloned job was missing
  // NEO4J_PASSWORD (falling back to the dev default) or carrying a mangled
  // one. A run's report must make that distinction itself.
  const present = (name: string) =>
    process.env[name] ? `set(${(process.env[name] as string).length})` : 'MISSING→default';
  process.stdout.write(
    `  config: NEO4J_URI ${present('NEO4J_URI')} · NEO4J_USER ${present('NEO4J_USER')}` +
    ` · NEO4J_PASSWORD ${present('NEO4J_PASSWORD')} · DATABASE_URL ${present('DATABASE_URL')}\n\n`,
  );

  // Postgres first, so a Neo4j failure is legible as exactly that — the
  // ownership source being readable is this script's precondition anyway.
  const tenantCount = await semanticDb('tenants').count<{ c: string }[]>('id as c');
  process.stdout.write(`  postgres reachable — ${Number(tenantCount[0]?.c ?? 0)} tenant(s)\n\n`);

  let remaining = 0;

  for (const plan of PLANS) {
    const before = await countMissing(plan.countCypher);
    if (before === 0) {
      process.stdout.write(`  ${plan.label.padEnd(16)} clean\n`);
      continue;
    }

    if (!APPLY) {
      process.stdout.write(`  ${plan.label.padEnd(16)} ${before} node(s) missing tenantId\n`);
      remaining += before;
      continue;
    }

    const owners = await plan.ownerMap();
    const pairs = [...owners.entries()].map(([key, tenantId]) => ({ key, tenantId }));
    const session = getSession();
    try {
      await session.run(plan.applyCypher, { pairs });
    } finally {
      await session.close();
    }
    const after = await countMissing(plan.countCypher);
    process.stdout.write(
      `  ${plan.label.padEnd(16)} ${before} → ${after}${after > 0 ? '  (unattributable — see below)' : ''}\n`,
    );
    remaining += after;
  }

  // Edges last: they inherit from their source table, which must be stamped first.
  const edgeBefore = await countMissing(EDGE_PLAN.countCypher);
  if (edgeBefore === 0) {
    process.stdout.write(`  ${EDGE_PLAN.label.padEnd(16)} clean\n`);
  } else if (!APPLY) {
    process.stdout.write(`  ${EDGE_PLAN.label.padEnd(16)} ${edgeBefore} edge(s) missing tenantId\n`);
    remaining += edgeBefore;
  } else {
    const session = getSession();
    try {
      await session.run(EDGE_PLAN.applyCypher);
    } finally {
      await session.close();
    }
    const after = await countMissing(EDGE_PLAN.countCypher);
    process.stdout.write(`  ${EDGE_PLAN.label.padEnd(16)} ${edgeBefore} → ${after}\n`);
    remaining += after;
  }

  process.stdout.write('\n');
  if (remaining === 0) {
    process.stdout.write(
      'Every graph entity carries tenantId. This is the precondition for adding a\n' +
      'tenant predicate to the read queries in db/semanticGraph.ts (step 3).\n',
    );
  } else {
    process.stdout.write(
      `${remaining} entit(ies) still unstamped.\n\n` +
      'DO NOT add tenant predicates to the read path yet — these would vanish from\n' +
      'their owner\'s catalog. Unattributable rows are usually orphans whose Postgres\n' +
      'mirror was deleted, or a CrossSourceView with no connectionId. Inspect them\n' +
      'individually and either attribute or delete them; do not guess an owner.\n',
    );
  }

  await closeDriver();
  await semanticDb.destroy();
  process.exit(remaining === 0 ? 0 : 1);
}

main().catch(async (err) => {
  process.stderr.write(`backfill-graph-tenant failed: ${err instanceof Error ? err.message : String(err)}\n`);
  await closeDriver().catch(() => {});
  await semanticDb.destroy().catch(() => {});
  process.exit(2);
});
