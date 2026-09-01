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
 *   npx tsx backend/src/scripts/backfillGraphTenant.ts --prune  # write + delete orphans
 *
 * PRUNE (also GRAPH_BACKFILL_PRUNE=1) additionally DELETES unstamped nodes
 * that provably belong to nobody: their owner key points at a Postgres row
 * that no longer exists, or they carry no owner key at all. Those are
 * unreachable garbage — every app read resolves graph entities through live
 * Postgres rows — left behind by tenant purges and connection deletions that
 * predate graph cleanup. A leftover whose key IS live is never deleted; it
 * means the apply match is broken and is reported as INVESTIGATE.
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

const PRUNE =
  process.argv.includes('--prune') ||
  (process.env.GRAPH_BACKFILL_PRUNE ?? '').trim() === '1';

const APPLY =
  PRUNE ||
  process.argv.includes('--apply') ||
  (process.env.GRAPH_BACKFILL_MODE ?? '').trim().toLowerCase() === 'apply';

interface Plan {
  label: string;
  /** The node property holding the Postgres owner key; absent for the two
   *  column labels, which inherit from their parent table instead. */
  keyProp?: 'connectionId' | 'dataProductId';
  /** Cypher returning the nodes still missing tenantId, with their owner key. */
  countCypher: string;
  /** Cypher applying a { key → tenantId } map. */
  applyCypher: string;
  /** Postgres lookup: owner key → tenant id. */
  ownerMap(): Promise<Map<number, number>>;
}

/**
 * Neo4j INTEGER values come back as the driver's lossless Integer object
 * (`disableLosslessIntegers` is not set in db/neo4j.ts), and `Number(obj)`
 * on one is NaN. Getting this wrong here would be catastrophic in prune
 * mode: every key would look like it had no Postgres mirror. Convert
 * explicitly, and treat anything unconvertible as null (reported, never
 * matched, never deleted by key).
 */
function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && 'toNumber' in (v as object)) {
    const n = (v as { toNumber(): number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
    keyProp: 'connectionId',
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
    keyProp: 'dataProductId',
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
    keyProp: 'connectionId',
    countCypher: `MATCH (n:KpiDefinition) WHERE n.tenantId IS NULL RETURN count(n) AS c`,
    applyCypher: `UNWIND $pairs AS p
                  MATCH (n:KpiDefinition {connectionId: p.key}) WHERE n.tenantId IS NULL
                  SET n.tenantId = p.tenantId RETURN count(n) AS c`,
    ownerMap: connectionOwners,
  },
  {
    label: 'QualityRule',
    keyProp: 'connectionId',
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
    keyProp: 'connectionId',
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

  // ── Whose are the leftovers? ──────────────────────────────────────────────
  // Run #6 (2026-09-01) left 5,089 entities unstamped with no way to tell the
  // two possible stories apart, and they demand opposite responses: an orphan
  // whose Postgres mirror row was deleted should itself be DELETED (it is
  // unreachable garbage — every app read resolves graph entities through live
  // Postgres rows), while a leftover whose key IS live means the apply match
  // is broken and must be debugged, never deleted. So partition every
  // unstamped node by its owner key against the live mirror.
  interface Diag {
    plan: Plan;
    deadKeys: Array<{ key: number; c: number }>;
    liveKeys: Array<{ key: number; tenantId: number; c: number }>;
    nullKeyCount: number;
  }
  const diags: Diag[] = [];
  if (remaining > 0) {
    process.stdout.write('\n  ── leftover ownership ──\n');
    for (const plan of PLANS) {
      if (!plan.keyProp) continue;
      const session = getSession();
      let rows: Array<{ key: number | null; c: number }> = [];
      try {
        const res = await session.run(
          `MATCH (n:${plan.label}) WHERE n.tenantId IS NULL
           RETURN n.${plan.keyProp} AS key, count(*) AS c ORDER BY c DESC`,
        );
        rows = res.records.map((r) => ({
          key: toNum(r.get('key')),
          c: toNum(r.get('c')) ?? 0,
        }));
      } finally {
        await session.close();
      }
      if (rows.length === 0) continue;

      const owners = await plan.ownerMap();
      const diag: Diag = { plan, deadKeys: [], liveKeys: [], nullKeyCount: 0 };
      for (const { key, c } of rows) {
        if (key == null) diag.nullKeyCount += c;
        else if (owners.has(key)) diag.liveKeys.push({ key, tenantId: owners.get(key)!, c });
        else diag.deadKeys.push({ key, c });
      }
      diags.push(diag);

      const fmt = (list: Array<{ key: number; c: number }>) =>
        list.slice(0, 15).map((e) => `${e.key}×${e.c}`).join(', ') + (list.length > 15 ? ', …' : '');
      process.stdout.write(`  ${plan.label}:\n`);
      if (diag.deadKeys.length > 0) {
        process.stdout.write(
          `    mirror DELETED — ${plan.keyProp} ${fmt(diag.deadKeys)} (${diag.deadKeys.reduce((s, e) => s + e.c, 0)} node(s) — orphans, prunable)\n`,
        );
      }
      for (const e of diag.liveKeys) {
        process.stdout.write(
          `    mirror LIVE — ${plan.keyProp} ${e.key} (tenant ${e.tenantId}) ×${e.c} — apply should have stamped these; INVESTIGATE, never prune\n`,
        );
      }
      if (diag.nullKeyCount > 0) {
        process.stdout.write(`    no ${plan.keyProp} at all ×${diag.nullKeyCount} (unattributable by construction)\n`);
      }
    }

    for (const childLabel of ['SourceColumn', 'ProductColumn']) {
      const orphanCols = await countMissing(
        `MATCH (n:${childLabel}) WHERE n.tenantId IS NULL AND NOT ( ()-[:HAS_COLUMN]->(n) ) RETURN count(n) AS c`,
      );
      const attachedCols = await countMissing(
        `MATCH (t)-[:HAS_COLUMN]->(n:${childLabel}) WHERE n.tenantId IS NULL RETURN count(n) AS c`,
      );
      if (orphanCols + attachedCols > 0) {
        process.stdout.write(
          `  ${childLabel}: ${attachedCols} under an unstamped parent table, ${orphanCols} with no parent table at all\n`,
        );
      }
    }
  }

  // ── Prune: delete what provably belongs to nobody ─────────────────────────
  // Only nodes that are BOTH unstamped AND either keyed to a deleted mirror
  // row or carrying no key at all. Live-keyed leftovers are never touched —
  // those are a bug to debug, and this loop cannot reach them by
  // construction. Deletions are counted and reported.
  if (PRUNE && remaining > 0) {
    process.stdout.write('\n  ── prune ──\n');
    for (const diag of diags) {
      const { plan } = diag;
      let deleted = 0;
      if (diag.deadKeys.length > 0) {
        const session = getSession();
        try {
          const res = await session.run(
            `UNWIND $keys AS k
             MATCH (n:${plan.label} {${plan.keyProp}: k}) WHERE n.tenantId IS NULL
             WITH n DETACH DELETE n RETURN count(*) AS c`,
            { keys: diag.deadKeys.map((e) => e.key) },
          );
          deleted += toNum(res.records[0]?.get('c')) ?? 0;
        } finally {
          await session.close();
        }
      }
      if (diag.nullKeyCount > 0) {
        const session = getSession();
        try {
          const res = await session.run(
            `MATCH (n:${plan.label}) WHERE n.tenantId IS NULL AND n.${plan.keyProp} IS NULL
             WITH n DETACH DELETE n RETURN count(*) AS c`,
          );
          deleted += toNum(res.records[0]?.get('c')) ?? 0;
        } finally {
          await session.close();
        }
      }
      if (deleted > 0) process.stdout.write(`  ${plan.label.padEnd(16)} deleted ${deleted} orphan(s)\n`);
    }

    // Columns whose parent table no longer exists (including parents the loop
    // above just removed) are unreachable from every read path.
    for (const childLabel of ['SourceColumn', 'ProductColumn']) {
      const session = getSession();
      try {
        const res = await session.run(
          `MATCH (n:${childLabel}) WHERE n.tenantId IS NULL AND NOT ( ()-[:HAS_COLUMN]->(n) )
           WITH n DETACH DELETE n RETURN count(*) AS c`,
        );
        const deleted = toNum(res.records[0]?.get('c')) ?? 0;
        if (deleted > 0) process.stdout.write(`  ${childLabel.padEnd(16)} deleted ${deleted} parentless orphan(s)\n`);
      } finally {
        await session.close();
      }
    }

    // Edges touching pruned tables died with DETACH DELETE; any survivor with
    // a now-stamped source table can inherit.
    {
      const session = getSession();
      try {
        await session.run(EDGE_PLAN.applyCypher);
      } finally {
        await session.close();
      }
    }

    // The recount IS the verdict — never report prune arithmetic as clean.
    remaining = 0;
    process.stdout.write('\n  ── after prune ──\n');
    for (const plan of PLANS) {
      const left = await countMissing(plan.countCypher);
      process.stdout.write(`  ${plan.label.padEnd(16)} ${left === 0 ? 'clean' : `${left} still unstamped`}\n`);
      remaining += left;
    }
    const edgesLeft = await countMissing(EDGE_PLAN.countCypher);
    process.stdout.write(`  ${EDGE_PLAN.label.padEnd(16)} ${edgesLeft === 0 ? 'clean' : `${edgesLeft} still unstamped`}\n`);
    remaining += edgesLeft;
  }

  process.stdout.write('\n');
  if (remaining === 0) {
    process.stdout.write(
      'Every graph entity carries tenantId — the tenant-scoped reads in\n' +
      'db/semanticGraph.ts (step 3, shipped 2026-09-01) can see all of it.\n',
    );
  } else {
    process.stdout.write(
      `${remaining} entit(ies) still unstamped.\n\n` +
      'The read path is tenant-scoped now (step 3 shipped 2026-09-01), so these are\n' +
      'ALREADY INVISIBLE to their owner\'s catalog — this is live breakage, not a\n' +
      'pending hazard. Unattributable rows are usually orphans whose Postgres\n' +
      'mirror was deleted, or a CrossSourceView with no connectionId. Inspect them\n' +
      'individually and either attribute (apply) or delete (prune) them; do not\n' +
      'guess an owner.\n',
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
