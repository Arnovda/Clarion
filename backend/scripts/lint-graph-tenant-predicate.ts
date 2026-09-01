/**
 * lint-graph-tenant-predicate — every MATCH on a tenant-owned label in
 * `db/semanticGraph.ts` must carry a `tenantId` predicate.
 *
 * Why this is a lint and not a code review note:
 *
 * Neo4j has no row-level security. A `pgId` is globally unique and enumerable,
 * so a MATCH keyed on it (or on `connectionId`, equally guessable) reaches
 * whichever tenant owns that id. The 2026-09-01 remediation added a
 * `tenantId: $tenantId` predicate to every read and every id-addressed write
 * anchor — after the writes had been stamping (`lint-graph-tenant-stamp`) and
 * the backfill had verified every existing entity clean. A NEW query added
 * without the predicate would fail no test: it would just quietly read (or
 * mutate) across tenants again, which is exactly how the P0-2 finding was born.
 *
 * The rule, mirroring how the file is written:
 *
 *   • A MATCH / OPTIONAL MATCH clause whose FIRST node pattern carries a
 *     tenant-owned label must reference `tenantId` somewhere in the clause
 *     segment (its property maps or the WHERE that belongs to it — i.e. the
 *     text up to the next MATCH or the end of the Cypher literal).
 *   • A clause whose first node is a BARE BOUND VARIABLE — `(v)-[...]` — is
 *     anchored on something an earlier clause already scoped, and passes.
 *     An EMPTY first node `()` does NOT count as bound: edge-addressed
 *     matches like `()-[r:RELATES_TO {pgId: …}]` must scope via an endpoint
 *     node or the edge property.
 *   • A clause containing a tenant-owned EDGE type with a property map is
 *     held to the same rule even when its nodes are label-free.
 *
 * Deliberate exemptions carry a `// tenant-exempt:` comment (with the reason)
 * within the few lines above the clause inside the same function; today those
 * are the ownership resolver (`getRelationshipConnectionId`, which exists to
 * DISCOVER an owner) and the two purge paths that are scoped by owner keys
 * collected from RLS-scoped Postgres rows (`deleteTenantGraph`,
 * `deleteProductGraph`) — where a tenantId predicate would strand mis-stamped
 * nodes forever instead of deleting them.
 *
 * The check is deliberately crude — it reads Cypher as text, the same posture
 * as lint-graph-tenant-stamp. Zero runtime deps beyond Node's fs.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const GRAPH_FILE = join('backend', 'src', 'db', 'semanticGraph.ts');

const TENANT_OWNED = [
  'SourceTable',
  'SourceColumn',
  'ProductTable',
  'ProductColumn',
  'KpiDefinition',
  'QualityRule',
  'CrossSourceView',
];

const TENANT_OWNED_EDGES = ['RELATES_TO', 'CROSS_VIEW_LINK'];

function fail(message: string): never {
  process.stderr.write(`lint-graph-tenant-predicate: ${message}\n`);
  process.exit(1);
}

if (!existsSync(GRAPH_FILE)) {
  fail(`missing ${GRAPH_FILE} — run from the repository root.`);
}

const src = readFileSync(GRAPH_FILE, 'utf8').replace(/\r\n/g, '\n');

/**
 * Extract template literals with their start offsets. Good enough for this
 * file: its Cypher templates contain `${…}` interpolations but never nested
 * backticks, so pairing backticks positionally is sound.
 */
interface Literal { start: number; text: string }
const literals: Literal[] = [];
{
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('`', i);
    if (open < 0) break;
    const close = src.indexOf('`', open + 1);
    if (close < 0) break;
    literals.push({ start: open, text: src.slice(open + 1, close) });
    i = close + 1;
  }
}

function lineOf(offset: number): number {
  return src.slice(0, offset).split('\n').length;
}

/** Is there a `// tenant-exempt:` comment shortly before this literal? */
function isExempt(literalStart: number): boolean {
  const before = src.slice(Math.max(0, literalStart - 700), literalStart);
  const lastLines = before.split('\n').slice(-12).join('\n');
  return /\/\/\s*tenant-exempt:/.test(lastLines);
}

// First node pattern of a MATCH clause. Handles `MATCH (a:Label {…})`,
// `MATCH path = shortestPath((a:Label …))`, `OPTIONAL MATCH (t)-[…]` and the
// empty anchor `MATCH ()-[…]`.
const CLAUSE_RE = /(?:OPTIONAL\s+)?MATCH\s+(?:\w+\s*=\s*)?(?:allShortestPaths|shortestPath)?\s*\(+\s*(\w*)\s*(?::\s*(\w+))?/g;

interface Violation { line: number; what: string; snippet: string }
const violations: Violation[] = [];
let inspected = 0;

for (const lit of literals) {
  if (!/\bMATCH\b/.test(lit.text)) continue;
  const exempt = isExempt(lit.start);

  // Split into clause segments: each segment runs from its MATCH keyword to
  // the next MATCH keyword (or the literal's end) — a WHERE stays with the
  // MATCH it belongs to.
  CLAUSE_RE.lastIndex = 0;
  const matches: Array<{ index: number; varName: string; label: string | undefined }> = [];
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_RE.exec(lit.text)) !== null) {
    matches.push({ index: m.index, varName: m[1], label: m[2] });
  }

  for (let k = 0; k < matches.length; k++) {
    const clause = matches[k];
    const segmentEnd = k + 1 < matches.length ? matches[k + 1].index : lit.text.length;
    const segment = lit.text.slice(clause.index, segmentEnd);

    const firstNodeIsBoundVar = clause.varName !== '' && clause.label === undefined;
    const labelIsOwned = clause.label !== undefined && TENANT_OWNED.includes(clause.label);
    const hasOwnedEdge = TENANT_OWNED_EDGES.some((e) => segment.includes(`:${e}`));

    const needsPredicate = (labelIsOwned || (!firstNodeIsBoundVar && hasOwnedEdge)) && !firstNodeIsBoundVar;
    if (!needsPredicate) continue;
    inspected++;
    if (/\btenantId\b/.test(segment)) continue;
    if (exempt) continue;

    violations.push({
      line: lineOf(lit.start) + lit.text.slice(0, clause.index).split('\n').length - 1,
      what: clause.label ?? TENANT_OWNED_EDGES.find((e) => segment.includes(`:${e}`)) ?? 'MATCH',
      snippet: segment.split('\n')[0].trim().slice(0, 100),
    });
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `lint-graph-tenant-predicate: ${violations.length} MATCH clause(s) lack a tenantId predicate:\n\n`,
  );
  for (const v of violations) {
    process.stderr.write(`  ${GRAPH_FILE}:${v.line}  ${v.what}\n      ${v.snippet}\n`);
  }
  process.stderr.write(
    '\nEvery MATCH on a tenant-owned label must filter on tenantId (property map or\n' +
    'WHERE), take the tenant as an explicit function parameter, and let a wrong\n' +
    'tenant match nothing. Anchor traversals on an already-scoped bound variable\n' +
    'where possible. A deliberately tenant-free query needs a `// tenant-exempt:`\n' +
    'comment naming the reason, directly above the Cypher literal.\n',
  );
  process.exit(1);
}

// A check that inspected nothing reports exactly what a healthy file reports —
// the `.ops/prod-logs` lesson. Refuse to call an empty scan clean.
if (inspected < 30) {
  fail(`only ${inspected} anchored MATCH clauses found — the parser is broken, not the file clean.`);
}

process.stdout.write(
  `lint-graph-tenant-predicate: OK — every anchored MATCH on a tenant-owned label carries a tenantId predicate ` +
  `(${inspected} clauses checked, ${TENANT_OWNED.length} node labels, ${TENANT_OWNED_EDGES.length} edge types).\n`,
);
