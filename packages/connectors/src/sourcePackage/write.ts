/**
 * Writing package YAML the way a reviewer wants to read it.
 *
 * `yaml.stringify` alone produces correct but verbose output: every small map
 * ({ dataset: Accounts, field: ID }) and short list ([ID]) on its own lines.
 * This writer puts the small, always-together things in flow style and keeps
 * the rest in block style, never folds long lines, and prefixes a header
 * comment. Used by the one-off migration from TypeScript and by the Exact
 * Online docs transcriber when it refreshes a dataset's fields.
 */
import { Document, isMap, isScalar, isSeq, visit, type Pair } from 'yaml';

/** Keys whose value is always a short, together-or-not-at-all map or list. */
const FLOW_KEYS = new Set([
  'references', 'lineage', 'cursor', 'vendor',
  'primary_key', 'from_columns', 'to_columns', 'sourceEntities', 'requiresTables', 'dimensionsUsed',
]);

/** A `clarion` map with at most this many entries, all scalar or flow, renders inline. */
const FLOW_EXT_MAX_ENTRIES = 3;

/** A scalar longer than this (notes, a long description) keeps its map in block style. */
const FLOW_SCALAR_MAX_CHARS = 60;

function allScalarOrFlow(node: unknown): boolean {
  if (isMap(node)) return node.flow === true;
  if (isSeq(node)) return node.flow === true;
  if (!isScalar(node)) return false;
  if (typeof node.value === 'string') return !node.value.includes('\n') && node.value.length <= FLOW_SCALAR_MAX_CHARS;
  return true;
}

export function toYaml(value: unknown, header?: string): string {
  const doc = new Document(value);
  // Children before parents: `visit` is pre-order, so decide flow on the way
  // back up by revisiting pairs after their subtree (visit returns to the
  // pair's parent only after its value is processed, and we set flow on the
  // value, which the parent's check then sees).
  visit(doc, {
    Pair: (_key, pair: Pair) => {
      const k = isScalar(pair.key) ? String(pair.key.value) : '';
      const v = pair.value;
      if (FLOW_KEYS.has(k) && (isMap(v) || isSeq(v))) {
        v.flow = true;
      }
    },
  });
  // Second pass: small `clarion` maps whose members are all scalar or flow.
  visit(doc, {
    Pair: (_key, pair: Pair) => {
      const k = isScalar(pair.key) ? String(pair.key.value) : '';
      const v = pair.value;
      if (k === 'clarion' && isMap(v) && v.items.length <= FLOW_EXT_MAX_ENTRIES
        && v.items.every((p) => allScalarOrFlow(p.value))) {
        v.flow = true;
      }
    },
  });
  if (header) doc.commentBefore = ` ${header.trim().split('\n').join('\n ')}`;
  return doc.toString({ lineWidth: 0, indentSeq: true, blockQuote: 'literal' });
}
