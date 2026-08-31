/**
 * Deterministic dashboard edit operations — the fast path for "this dashboard
 * is 90% right, change one thing".
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now every dashboard edit, however small, was a FULL-SPEC
 * REGENERATION: the whole spec (5–15K tokens for a populated dashboard) went
 * to the model, the whole spec came back, and a validation pass then
 * re-executed whatever looked changed. Three consequences, all of which the
 * user feels:
 *
 *  1. It is slow. A one-line request costs a large generation plus a
 *     validation pass — a minute or more, during which the UI could only show
 *     three bouncing dots.
 *  2. It is destructive out of proportion to the ask. "Slice by customer as
 *     well" came back with all twelve widgets rewritten, which meant every
 *     widget re-executed, every cached row dropped and every layout re-emitted
 *     — and a model that rewrites twelve SQL statements gets to make twelve
 *     new mistakes in service of one request.
 *  3. It cannot be shown. A single opaque call has no intermediate states to
 *     report, so the user cannot tell progress from a hang.
 *
 * Most real edits are not generative at all. "Add a customer filter", "make
 * that a line chart", "drop the pie chart", "rename this card", "show 20
 * instead of 10" are STRUCTURAL: they are edits to the spec, and the app can
 * make them itself, exactly, in under a millisecond, with no AI call and no
 * possibility of collateral damage. This module is that catalogue.
 *
 * THE DIVIDING LINE
 * -----------------
 * An op belongs here when applying it correctly requires no judgement about
 * the data — only about the spec. Deciding WHICH ops a sentence means is
 * judgement, and stays with the model (see ai/prompts/dashboardEditPlanPrompt);
 * rewriting a widget's SELECT list is judgement too, and stays with the model
 * (as a small per-widget call). What lands here is the execution: given the
 * decision, perform it precisely.
 *
 * Every op is total: an op that cannot be applied (unknown widget id, a chart
 * type whose column contract differs) is REFUSED and reported back, never
 * half-applied. The caller surfaces refusals to the user rather than
 * pretending the edit happened — a silently-dropped edit is the failure mode
 * this whole path exists to remove.
 */

import type { DashboardSpec, FilterSpec, WidgetSpec } from '../shared/contract';
import { REQUIRED_WIDGET_COLUMNS } from '../shared/widgetContracts';

type WidgetType = WidgetSpec['type'];

// ---------------------------------------------------------------------------
// Op catalogue
// ---------------------------------------------------------------------------

/**
 * A single structural edit. `sql_edit` and `add_widget` are the two that still
 * need the model — they are carried in the same list so a plan is one ordered
 * thing the user can be shown, not two half-plans in different places.
 */
export type DashboardEditOp =
  /** Add a select/date_range filter and wire it into the named widgets' SQL. */
  | { op: 'add_filter'; filter: FilterSpec; widgetIds?: string[] }
  /** Remove a filter and strip its predicate back out of every widget. */
  | { op: 'remove_filter'; filterId: string }
  /** Change a filter's default window / selected value. */
  | { op: 'set_filter_default'; filterId: string; defaultPreset?: string; defaultValue?: string }
  | { op: 'remove_widget'; widgetId: string }
  | { op: 'retitle_widget'; widgetId: string; title: string }
  /** Chart-type swap — allowed only within one column-contract group. */
  | { op: 'set_widget_type'; widgetId: string; widgetType: WidgetType }
  | { op: 'set_widget_format'; widgetId: string; format: 'currency' | 'number' | 'percentage' }
  /** Change a top-N / LIMIT on a widget that has one. */
  | { op: 'set_widget_limit'; widgetId: string; limit: number }
  | { op: 'retitle_dashboard'; title?: string; description?: string }
  /** Needs the model: rewrite ONE widget's SQL against a scoped instruction. */
  | { op: 'sql_edit'; widgetId: string; instruction: string }
  /** Needs the model: generate ONE new widget. */
  | { op: 'add_widget'; instruction: string };

/** Ops this module can apply with no AI call at all. */
export function isDeterministicOp(op: DashboardEditOp): boolean {
  return op.op !== 'sql_edit' && op.op !== 'add_widget';
}

/** One widget's SQL, handed to the model because the app could not do it itself. */
export interface SqlHandover {
  widgetId: string;
  /** What the model is being asked to do, in its own scoped instruction. */
  instruction: string;
  /** Business-language label for the progress checklist. */
  label: string;
}

export interface AppliedEdit {
  op: DashboardEditOp;
  /** Widget ids whose `sql`, `type` or `title` this op changed. */
  changedWidgetIds: string[];
  /** Present when the op could NOT be applied — shown to the user verbatim. */
  refusal?: string;
  /**
   * Work this op could not do deterministically and is handing to a scoped
   * model call. NOT a refusal — the user asked for something achievable and
   * will get it, one AI call per widget, so these are deliberately kept out
   * of `realRefusals`. An op may produce SEVERAL: one `add_filter` on a
   * dashboard of KPI cards hands over every card it could not inject into.
   */
  handovers?: SqlHandover[];
}

export interface ApplyEditOpsResult {
  spec: DashboardSpec;
  applied: AppliedEdit[];
}

// ---------------------------------------------------------------------------
// SQL surgery — the shared WHERE-clause boundary logic
// ---------------------------------------------------------------------------

/**
 * The boundary between a statement's FROM/WHERE region and its
 * post-aggregation clauses. An injected predicate must land before GROUP BY /
 * HAVING / ORDER BY / LIMIT or it changes the meaning of whichever clause it
 * lands inside.
 */
const BOUNDARY_RE = /\s+(GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|QUALIFY|WINDOW)\b/i;
const WHERE_RE = /\bWHERE\b/i;

/**
 * Add `predicate` to a single-SELECT statement's WHERE clause.
 *
 * Returns null — never a mangled statement — when the shape is one this cannot
 * safely reason about: a CTE (`WITH …`), a statement with no FROM, or one with
 * a set operator (UNION/EXCEPT/INTERSECT), where a top-level WHERE does not
 * exist in the sense the caller means. Callers escalate a null to a scoped
 * model call rather than guessing, because a predicate injected into the wrong
 * arm of a query is a WRONG NUMBER, and a wrong number that renders is worse
 * than an edit that says it could not be made.
 *
 * This is the same logic the cross-filter path has used in production since
 * Phase 3; it lives here so there is exactly ONE implementation of it, and
 * `injectCrossFilter` is now a caller.
 */
export function injectWherePredicate(sql: string, predicate: string): string | null {
  if (!sql || !predicate) return null;
  if (/^\s*WITH\s+/i.test(sql)) return null;
  if (/\b(UNION|INTERSECT|EXCEPT)\b/i.test(sql)) return null;

  const fromMatch = sql.match(/\bFROM\b/i);
  if (!fromMatch || fromMatch.index == null) return null;

  const tail = sql.slice(fromMatch.index);
  const boundaryInTail = tail.match(BOUNDARY_RE);
  const hasWhere = WHERE_RE.test(tail);
  const keyword = hasWhere ? 'AND' : 'WHERE';

  if (boundaryInTail && boundaryInTail.index != null) {
    const splitPoint = fromMatch.index + boundaryInTail.index;
    return sql.slice(0, splitPoint) + ` ${keyword} ${predicate}` + sql.slice(splitPoint);
  }
  // No post-aggregation clause: append, minding a trailing semicolon.
  const trimmed = sql.trimEnd();
  const semi = trimmed.endsWith(';');
  const body = semi ? trimmed.slice(0, -1).trimEnd() : trimmed;
  return `${body} ${keyword} ${predicate}${semi ? ';' : ''}`;
}

/**
 * Identifier gate — REJECTS rather than sanitises. The cross-filter path
 * strips disallowed characters and proceeds; here a name that needed cleaning
 * is refused outright, because a stripped identifier is a DIFFERENT identifier
 * — the op would then filter on a column the caller never named, silently.
 */
export function safeIdentifier(name: string): string | null {
  const raw = String(name ?? '');
  if (raw.length === 0) return null;
  return /^[a-zA-Z0-9_."`[\]]+$/.test(raw) ? raw : null;
}

/**
 * The predicate a dashboard SELECT filter contributes.
 *
 * `('{{customer}}' = 'all' OR customer_name = '{{customer}}')` — the shape the
 * generation prompt already produces, so a filter added this way is
 * indistinguishable from one the model wrote, including to a later
 * full-regeneration refine that reads the spec back.
 */
export function selectFilterPredicate(filterId: string, column: string): string | null {
  const col = safeIdentifier(column);
  const id = safeIdentifier(filterId);
  if (!col || !id) return null;
  return `('{{${id}}}' = 'all' OR ${col} = '{{${id}}}')`;
}

/** The predicate a dashboard DATE RANGE filter contributes. */
export function dateFilterPredicate(filterId: string, column: string): string | null {
  const col = safeIdentifier(column);
  const id = safeIdentifier(filterId);
  if (!col || !id) return null;
  return `${col} BETWEEN '{{${id}_from}}' AND '{{${id}_to}}'`;
}

export function filterPredicate(filter: FilterSpec): string | null {
  return filter.type === 'date_range'
    ? dateFilterPredicate(filter.id, filter.column)
    : selectFilterPredicate(filter.id, filter.column);
}

/**
 * The scoped instruction for wiring a filter into a query the textual
 * injection could not touch.
 *
 * Worth stating what this fixes, because the failure was invisible: the
 * dashboard generation prompt REQUIRES every `kpi_card` to compute its
 * prior-period delta with a `WITH curr AS (…), prev AS (…)` — and
 * `injectWherePredicate` refuses `WITH` on purpose, since a predicate landed
 * in the wrong arm of a CTE is a wrong number. So adding a filter to a
 * dashboard used to wire up the charts and silently leave every headline KPI
 * unfiltered: the filter bar said "Customer: Commerce 5 Sa" above four numbers
 * for ALL customers. The card is not unfilterable — the predicate just has to
 * go inside each arm that scans the fact table, which is a judgement about
 * that query, so it goes to the model rather than to a regex.
 */
export function filterWireInstruction(filter: FilterSpec, predicate: string): string {
  const placeholders = filter.type === 'date_range'
    ? `{{${filter.id}_from}} and {{${filter.id}_to}}`
    : `{{${filter.id}}} (the literal value 'all' means "no filtering" and must still return every row)`;
  return [
    `Apply the dashboard filter "${filter.label || filter.column}" to this query, so this card responds to it like the rest of the dashboard.`,
    `Use exactly this predicate: ${predicate}`,
    `It references ${placeholders}.`,
    'The query has a shape the app could not edit safely on its own — most often a CTE. Put the predicate inside EVERY branch that reads the underlying rows (each CTE arm, each side of a UNION), not only the final SELECT, or the comparison periods will disagree with each other.',
    `Add whatever JOIN is needed to reach ${filter.column}. Keep every other {{placeholder}} that is already in the query, and keep the exact same output columns.`,
  ].join(' ');
}

/**
 * Ceiling on how many widgets one filter may hand to the model at once.
 *
 * Each handover is a separate Sonnet call. They run in parallel, so the cost
 * is tokens rather than time, but "add a filter" must not silently become
 * forty AI calls on a large dashboard. Past the cap the remainder is a real,
 * VISIBLE refusal — the user can then ask for those cards by name.
 */
export const MAX_FILTER_HANDOVERS = 12;

/**
 * Strip every predicate that references `{{filterId}}` back out of a SQL
 * statement, leaving the rest of the WHERE intact.
 *
 * Removal has to be textual because the predicate was inserted textually, and
 * it is deliberately conservative: it removes only whole `AND <predicate>` /
 * `WHERE <predicate> AND` shapes it can identify, and returns null when the
 * placeholder survives anywhere afterwards. A leftover `{{x}}` would be
 * substituted with the literal `all` at execution time (see
 * resolveWidgetFilters) and quietly change the result, so "could not remove it
 * cleanly" must escalate rather than approximate.
 */
export function stripFilterPredicate(sql: string, filterId: string): string | null {
  const id = safeIdentifier(filterId);
  if (!id) return null;
  const ph = `{{${id}`;
  if (!sql.includes(ph)) return sql; // nothing to do — already absent

  // A predicate is the text between boolean connectives at nesting depth 0.
  // Walk the WHERE region, split it into top-level conjuncts, drop the ones
  // mentioning the placeholder, and reassemble.
  const fromMatch = sql.match(/\bFROM\b/i);
  if (!fromMatch || fromMatch.index == null) return null;
  const tail = sql.slice(fromMatch.index);
  const whereMatch = tail.match(WHERE_RE);
  if (!whereMatch || whereMatch.index == null) return null;

  const whereStart = fromMatch.index + whereMatch.index + whereMatch[0].length;
  const boundaryInTail = tail.slice(whereMatch.index).match(BOUNDARY_RE);
  const whereEnd = boundaryInTail && boundaryInTail.index != null
    ? fromMatch.index + whereMatch.index + boundaryInTail.index
    : sql.length;

  const clause = sql.slice(whereStart, whereEnd);
  const conjuncts = splitTopLevelAnd(clause);
  if (conjuncts === null) return null; // unbalanced / OR at top level — don't guess
  const kept = conjuncts.filter((c) => !c.includes(ph));
  if (kept.length === conjuncts.length) return null; // placeholder is nested somewhere else

  const rebuilt = kept.length === 0
    ? ''
    : ` WHERE ${kept.map((c) => c.trim()).join(' AND ')}`;
  const head = sql.slice(0, whereStart - whereMatch[0].length).replace(/\s+$/, '');
  const rest = sql.slice(whereEnd);
  const out = head + rebuilt + (rest && !/^\s/.test(rebuilt + rest) ? ' ' : '') + rest;
  return out.includes(ph) ? null : out;
}

/**
 * Split a WHERE clause into its top-level AND conjuncts.
 * Returns null when the clause has a top-level OR (the conjuncts are then not
 * independently removable) or unbalanced parentheses / quotes.
 */
function splitTopLevelAnd(clause: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (inStr) {
      if (ch === "'") inStr = clause[i + 1] === "'" ? (i++, true) : false;
      continue;
    }
    if (ch === "'") { inStr = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; if (depth < 0) return null; continue; }
    if (depth !== 0) continue;
    // Top-level connective?
    const rest = clause.slice(i);
    const andM = /^\s+AND\s+/i.exec(rest);
    if (andM) { parts.push(clause.slice(start, i)); i += andM[0].length - 1; start = i + 1; continue; }
    if (/^\s+OR\s+/i.test(rest)) return null;
  }
  if (depth !== 0 || inStr) return null;
  parts.push(clause.slice(start));
  return parts.filter((p) => p.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Chart-type swap groups
// ---------------------------------------------------------------------------

/**
 * Two widget types are interchangeable without touching SQL exactly when they
 * require the SAME result columns. Derived from REQUIRED_WIDGET_COLUMNS rather
 * than hand-listed, so adding a widget type to the contract automatically
 * places it in the right group and a contract change can never leave a stale
 * copy here.
 *
 * `data_table` is excluded despite its empty contract: it accepts ANY columns,
 * so swapping something into it is safe but swapping OUT of it is not, and a
 * one-way relation is not a group.
 */
export function typeSwapGroup(type: WidgetType): Set<WidgetType> {
  const required = REQUIRED_WIDGET_COLUMNS[type];
  const key = [...required].sort().join(',');
  const group = new Set<WidgetType>();
  if (key === '') return group; // data_table / free-column types: no group
  for (const [t, cols] of Object.entries(REQUIRED_WIDGET_COLUMNS) as [WidgetType, string[]][]) {
    if (cols.length > 0 && [...cols].sort().join(',') === key) group.add(t);
  }
  return group;
}

export function canSwapType(from: WidgetType, to: WidgetType): boolean {
  if (from === to) return true;
  return typeSwapGroup(from).has(to);
}

// ---------------------------------------------------------------------------
// Applying a plan
// ---------------------------------------------------------------------------

/** Replace a trailing `LIMIT n` (top-level only). Null when there is none. */
function setLimit(sql: string, limit: number): string | null {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) return null;
  const trimmed = sql.trimEnd();
  const semi = trimmed.endsWith(';');
  const body = semi ? trimmed.slice(0, -1).trimEnd() : trimmed;
  if (!/\bLIMIT\s+\d+\s*$/i.test(body)) return null;
  return body.replace(/\bLIMIT\s+\d+\s*$/i, `LIMIT ${limit}`) + (semi ? ';' : '');
}

/**
 * Apply the deterministic ops of a plan to a spec. Ops needing the model
 * (`sql_edit`, `add_widget`) are returned untouched in `applied` with no
 * refusal, for the caller to execute; everything else is done here.
 *
 * The input spec is never mutated.
 */
export function applyEditOps(spec: DashboardSpec, ops: DashboardEditOp[]): ApplyEditOpsResult {
  let widgets: WidgetSpec[] = spec.widgets.map((w) => ({ ...w }));
  let filters: FilterSpec[] = spec.filters.map((f) => ({ ...f }));
  let title = spec.title;
  let description = spec.description;
  const applied: AppliedEdit[] = [];

  const byId = () => new Map(widgets.map((w, i) => [w.id, i]));

  for (const op of ops) {
    const record = (changedWidgetIds: string[], refusal?: string, handovers?: SqlHandover[]) =>
      applied.push({
        op,
        changedWidgetIds,
        ...(refusal ? { refusal } : {}),
        ...(handovers?.length ? { handovers } : {}),
      });

    switch (op.op) {
      case 'sql_edit':
      case 'add_widget':
        record([]); // caller's job
        break;

      case 'retitle_dashboard': {
        if (op.title) title = op.title;
        if (op.description) description = op.description;
        record([]);
        break;
      }

      case 'add_filter': {
        const f = op.filter;
        if (!safeIdentifier(f.id) || !safeIdentifier(f.column)) {
          record([], `Could not add the "${f.label ?? f.id}" filter: its column name is not one I can safely use.`);
          break;
        }
        if (filters.some((x) => x.id === f.id)) {
          record([], `A "${f.label ?? f.id}" filter is already on this dashboard.`);
          break;
        }
        const predicate = filterPredicate(f);
        if (!predicate) {
          record([], `Could not build a filter on ${f.column}.`);
          break;
        }
        // Default scope: every widget. A dashboard filter the user can see but
        // that only moves half the charts is worse than no filter at all.
        const targets = op.widgetIds?.length ? new Set(op.widgetIds) : new Set(widgets.map((w) => w.id));
        const changed: string[] = [];
        const skipped: WidgetSpec[] = [];
        widgets = widgets.map((w) => {
          if (!targets.has(w.id)) return w;
          if (w.sql.includes(`{{${f.id}`)) return w; // already wired
          const next = injectWherePredicate(w.sql, predicate);
          if (next === null) { skipped.push(w); return w; }
          changed.push(w.id);
          return { ...w, sql: next };
        });
        filters = [...filters, f];
        // A card the app could not edit textually is HANDED OVER, not skipped.
        // Leaving it alone was the old behaviour and it produced the worst
        // outcome available: a filter on screen that a headline number quietly
        // ignores. Beyond the cap it becomes a stated refusal instead.
        const handedOver = skipped.slice(0, MAX_FILTER_HANDOVERS);
        const overflow = skipped.slice(MAX_FILTER_HANDOVERS);
        record(
          changed,
          overflow.length
            ? `Added the ${f.label} filter, but ${overflow.length} more card(s) — ${overflow.map((w) => `"${w.title}"`).join(', ')} — need their queries rewritten to use it. Ask me to apply it to those cards and I will.`
            : undefined,
          handedOver.map((w) => ({
            widgetId: w.id,
            instruction: filterWireInstruction(f, predicate),
            label: `Apply the ${f.label || f.column} filter to "${w.title}"`,
          })),
        );
        break;
      }

      case 'remove_filter': {
        const idx = filters.findIndex((f) => f.id === op.filterId);
        if (idx === -1) { record([], `There is no "${op.filterId}" filter on this dashboard.`); break; }
        const changed: string[] = [];
        const failed: string[] = [];
        const nextWidgets = widgets.map((w) => {
          if (!w.sql.includes(`{{${op.filterId}`)) return w;
          const next = stripFilterPredicate(w.sql, op.filterId);
          if (next === null) { failed.push(w.title); return w; }
          changed.push(w.id);
          return { ...w, sql: next };
        });
        if (failed.length) {
          // Leaving a dangling {{placeholder}} behind would silently substitute
          // 'all' at execution time. Refuse the whole op instead.
          record([], `Could not remove the "${op.filterId}" filter cleanly from ${failed.join(', ')} — left it in place.`);
          break;
        }
        widgets = nextWidgets;
        filters = filters.filter((f) => f.id !== op.filterId);
        record(changed);
        break;
      }

      case 'set_filter_default': {
        const idx = filters.findIndex((f) => f.id === op.filterId);
        if (idx === -1) { record([], `There is no "${op.filterId}" filter on this dashboard.`); break; }
        filters = filters.map((f, i) => i === idx
          ? {
            ...f,
            ...(op.defaultPreset ? { defaultPreset: op.defaultPreset } : {}),
            ...(op.defaultValue ? { defaultValue: op.defaultValue } : {}),
          }
          : f);
        record([]);
        break;
      }

      case 'remove_widget': {
        const i = byId().get(op.widgetId);
        if (i === undefined) { record([], `Could not find the widget to remove.`); break; }
        widgets = widgets.filter((_, k) => k !== i);
        record([]);
        break;
      }

      case 'retitle_widget': {
        const i = byId().get(op.widgetId);
        if (i === undefined) { record([], `Could not find the widget to rename.`); break; }
        if (!op.title?.trim()) { record([], `No new name was given.`); break; }
        widgets = widgets.map((w, k) => (k === i ? { ...w, title: op.title.trim() } : w));
        record([op.widgetId]);
        break;
      }

      case 'set_widget_type': {
        const i = byId().get(op.widgetId);
        if (i === undefined) { record([], `Could not find the widget to change.`); break; }
        const w = widgets[i];
        if (!canSwapType(w.type, op.widgetType)) {
          // Not a refusal of the request — a handover. The caller turns this
          // into a scoped model call, because the SQL genuinely has to change:
          // the target type wants columns this one does not return.
          const asType = op.widgetType.replace(/_/g, ' ');
          record([], undefined, [{
            widgetId: op.widgetId,
            instruction: `Change "${w.title}" to a ${asType} — return the columns that chart type needs.`,
            label: `Rewrite "${w.title}" for a ${asType.replace(' chart', '')} chart`,
          }]);
          break;
        }
        widgets = widgets.map((x, k) => (k === i ? { ...x, type: op.widgetType } : x));
        record([op.widgetId]);
        break;
      }

      case 'set_widget_format': {
        const i = byId().get(op.widgetId);
        if (i === undefined) { record([], `Could not find the widget to change.`); break; }
        widgets = widgets.map((x, k) => (k === i ? { ...x, format: op.format } : x));
        record([op.widgetId]);
        break;
      }

      case 'set_widget_limit': {
        const i = byId().get(op.widgetId);
        if (i === undefined) { record([], `Could not find the widget to change.`); break; }
        const next = setLimit(widgets[i].sql, op.limit);
        if (next === null) {
          record([], undefined, [{
            widgetId: op.widgetId,
            instruction: `Show ${op.limit} rows in "${widgets[i].title}" — this query has no top-level LIMIT to change.`,
            label: `Rewrite "${widgets[i].title}" to return ${op.limit} rows`,
          }]);
          break;
        }
        widgets = widgets.map((x, k) => (k === i ? { ...x, sql: next } : x));
        record([op.widgetId]);
        break;
      }

      default: {
        // Exhaustiveness: a new op variant must be handled above.
        const never: never = op;
        void never;
      }
    }
  }

  return { spec: { ...spec, title, description, filters, widgets }, applied };
}

/**
 * Work the deterministic pass handed to the model — declared `sql_edit` ops,
 * plus everything an op discovered it could not do itself (a filter that would
 * not inject, a cross-contract chart swap, a limit with nowhere to go).
 *
 * `planIndex` is the index in `applied` of the op that produced the handover,
 * so the caller can hang each one under the right line of the plan the user is
 * already watching. One op can produce many: `add_filter` on a dashboard of
 * KPI cards hands over each card separately, and each gets its own step.
 */
export function pendingSqlEdits(
  applied: AppliedEdit[],
): Array<{ widgetId: string; instruction: string; label: string; planIndex: number }> {
  const out: Array<{ widgetId: string; instruction: string; label: string; planIndex: number }> = [];
  applied.forEach((a, planIndex) => {
    if (a.op.op === 'sql_edit') {
      out.push({ widgetId: a.op.widgetId, instruction: a.op.instruction, label: '', planIndex });
    }
    for (const h of a.handovers ?? []) out.push({ ...h, planIndex });
  });
  return out;
}

/**
 * Refusals to show the user verbatim. A handover is deliberately NOT one: the
 * request is being carried out, just by the model instead of by a regex, and
 * telling someone their edit "could not be made" while it is being made is the
 * bug this whole path exists to remove.
 */
export function realRefusals(applied: AppliedEdit[]): string[] {
  return applied.map((a) => a.refusal).filter((r): r is string => !!r);
}
