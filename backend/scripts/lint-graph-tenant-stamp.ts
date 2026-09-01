/**
 * lint-graph-tenant-stamp — every node or edge written into Neo4j must carry
 * `tenantId`.
 *
 * Why this is a lint and not a code review note:
 *
 * `db/semanticGraph.ts` matches nodes by a globally-unique, enumerable `pgId`.
 * Postgres RLS protects the mirror rows but not the graph, so every MATCH
 * there now carries a `tenantId` predicate (held by the companion
 * lint-graph-tenant-predicate; landed 2026-09-01 after the backfill reported
 * clean). That predicate has one hard precondition: the property must be ON
 * the node. A node written without it does not leak — it silently returns an
 * empty catalog for every affected tenant, which is its own outage.
 *
 * The ordering was: stamp everything → backfill → add predicates. This lint
 * holds the first step in place, permanently. A new write path that forgets
 * `tenantId` would not fail any test — it would just quietly create a node
 * that the tenant-scoped reads cannot see. That is precisely the class
 * of silent, months-later failure this codebase has repeated seven times.
 *
 * The check is deliberately crude — it reads Cypher as text, because that is
 * all it is. It looks at each CREATE/MERGE of a labelled node or relationship
 * and asserts a `tenantId` assignment appears within the same statement.
 *
 * Zero runtime deps beyond Node's fs (run via `npx tsx`).
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const GRAPH_FILE = join('backend', 'src', 'db', 'semanticGraph.ts');

/**
 * Labels that represent tenant-owned data. Anything created with one of these
 * labels, or any relationship carrying a property map, must be stamped.
 */
const TENANT_OWNED = [
  'SourceTable',
  'SourceColumn',
  'ProductTable',
  'ProductColumn',
  'KpiDefinition',
  'QualityRule',
  'CrossSourceView',
];

/** Relationship types that carry their own property map (and so their own id). */
const TENANT_OWNED_EDGES = ['RELATES_TO', 'CROSS_VIEW_LINK'];

function fail(message: string): never {
  process.stderr.write(`lint-graph-tenant-stamp: ${message}\n`);
  process.exit(1);
}

if (!existsSync(GRAPH_FILE)) {
  fail(`missing ${GRAPH_FILE} — run from the repository root.`);
}

const src = readFileSync(GRAPH_FILE, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

/**
 * A "statement" here is the Cypher between a CREATE/MERGE of a tenant-owned
 * entity and the closing of its property map / the next clause. Approximating
 * with a forward window is enough: property maps in this file are written one
 * key per line and never exceed ~30 lines.
 */
const WINDOW = 40;

interface Violation {
  line: number;
  what: string;
  snippet: string;
}

const violations: Violation[] = [];

const nodePattern = new RegExp(
  `\\b(?:CREATE|MERGE)\\s*\\(\\s*\\w*\\s*:(${TENANT_OWNED.join('|')})\\b`,
);
const edgePattern = new RegExp(
  `\\b(?:CREATE|MERGE)\\s*\\([^)]*\\)-\\[\\s*\\w*\\s*:(${TENANT_OWNED_EDGES.join('|')})\\s*\\{`,
);

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const nodeMatch = nodePattern.exec(line);
  const edgeMatch = edgePattern.exec(line);
  if (!nodeMatch && !edgeMatch) continue;

  const label = (nodeMatch ?? edgeMatch)![1];

  // A MERGE that only serves as a lookup key for a following SET block still
  // counts — the SET block is inside the window.
  const window = lines.slice(i, Math.min(i + WINDOW, lines.length)).join('\n');

  // Stop the window at the END of the Cypher template literal so we do not
  // borrow a `tenantId` from the NEXT query in the same function. The matched
  // line often OPENS the literal, so search for the closing backtick from
  // after the opening one rather than from the start of the window.
  const opening = window.indexOf('`');
  const closing = opening >= 0 ? window.indexOf('`', opening + 1) : -1;
  const statement = closing > 0 ? window.slice(0, closing) : window;

  if (!/\btenantId\b/.test(statement)) {
    violations.push({
      line: i + 1,
      what: label,
      snippet: line.trim().slice(0, 100),
    });
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `lint-graph-tenant-stamp: ${violations.length} graph write(s) do not stamp tenantId:\n\n`,
  );
  for (const v of violations) {
    process.stderr.write(`  ${GRAPH_FILE}:${v.line}  ${v.what}\n      ${v.snippet}\n`);
  }
  process.stderr.write(
    '\nEvery node and property-carrying edge written to Neo4j must set tenantId.\n' +
    'Without it the node is invisible to the tenant-scoped reads this codebase is\n' +
    'moving towards — a silent empty catalog rather than a loud failure. Thread the\n' +
    'tenant from the caller (the connection / product row already carries it) and\n' +
    'set it in both the ON CREATE and ON MATCH branches.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `lint-graph-tenant-stamp: OK — every graph write stamps tenantId ` +
  `(${TENANT_OWNED.length} node labels, ${TENANT_OWNED_EDGES.length} edge type).\n`,
);
