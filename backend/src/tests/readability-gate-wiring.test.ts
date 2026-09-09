/**
 * The readability gate is only worth anything if the validation pass actually
 * calls it. These are SOURCE-level assertions on routes/dashboards.ts, the
 * same shape as authoring-surface-guard.test.ts: they pin that the gate runs
 * inside `validateAndRepairSpec` (generate, refine-spec, fix-widget), that a
 * SQL-kind finding is what makes the repair call fire, that the repair is
 * re-checked afterwards, and that the user-steered stream path ANNOTATES
 * rather than changes. Each slice is bounded at the next top-level
 * declaration so a test cannot match a definition elsewhere in the file
 * (the 2026-09-07 trap: a slice to end-of-file matched the wrong thing).
 *
 * Verified red: deleting the `applyReadabilityFixes(` call from
 * validateAndRepairSpec fails the first test; deleting `r.readabilityIssue`
 * from `hasIssues` fails the second.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');
const routes = readFileSync(join(SRC, 'routes', 'dashboards.ts'), 'utf8');
const prompt = readFileSync(join(SRC, 'ai', 'prompts', 'dashboardPrompt.ts'), 'utf8');

/** The body of a top-level `async function NAME(` up to the next top-level function/router declaration. */
function bodyOf(name: string): string {
  const start = routes.indexOf(`async function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const rest = routes.slice(start + 1);
  const next = rest.search(/\n(?:async function |function |router\.(?:get|post|put|patch|delete)\(|\/\/ -{20,})/);
  return next === -1 ? routes.slice(start) : routes.slice(start, start + 1 + next);
}

describe('the readability gate is wired into the validation pass', () => {
  it('validateAndRepairSpec runs the gate on every executed widget and hands SQL findings to the model', () => {
    const body = bodyOf('validateAndRepairSpec');
    expect(body).toContain('applyReadabilityFixes(');
    expect(body).toContain('r.readabilityIssue = issue');
    // the old inline pie rule is gone — the module owns it now
    expect(body).not.toContain("r.type === 'pie_chart'");
  });

  it('a readability finding is enough to trigger the repair call', () => {
    const body = bodyOf('validateAndRepairSpec');
    const hasIssues = body.slice(body.indexOf('const hasIssues'), body.indexOf('if (hasIssues)'));
    expect(hasIssues).toContain('r.readabilityIssue');
  });

  it('the row profile never reaches the model', () => {
    const body = bodyOf('validateAndRepairSpec');
    expect(body).toContain('profile: _profile, ...rest');
    expect(body).toContain('validateAndFixDashboardSpec(\n        spec, forModel');
  });

  it('the repair is re-checked: still-unreadable widgets get a note, a broken repair is reverted', () => {
    const body = bodyOf('validateAndRepairSpec');
    expect(body).toContain('settleReadability(repaired, spec, readability');
    const settle = bodyOf('settleReadability');
    expect(settle).toContain('executeSpecForValidation(');
    expect(settle).toContain('readabilityNote: readabilityNoteText(outcome.remaining)');
    expect(settle).toContain('before.widgets.find');
  });

  it('every execution carries the profile the gate reads — from ALL rows, not the 3-row sample', () => {
    const exec = bodyOf('executeSpecForValidation');
    expect(exec).toContain('profile: profileRows(rows)');
    expect(exec).toContain('sampleRows: rows.slice(0, 3)');
  });

  it('the user-steered stream path annotates and never changes the widget', () => {
    const start = routes.indexOf("router.post('/refine-spec-stream'");
    const end = routes.indexOf("router.post('/fix-widget'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const stream = routes.slice(start, end);
    expect(stream).toContain('assessReadability(bare, r.profile)');
    expect(stream).toContain('may be hard to read');
    expect(stream).not.toContain('applyReadabilityFixes(');
  });

  it('the repair prompt knows the field and carries the rule', () => {
    expect(prompt).toContain('readabilityIssue?: string');
    expect(prompt).toMatch(/9\. UNREADABLE \(readabilityIssue present\)/);
    expect(prompt).toContain('a contractIssue or a readabilityIssue');
  });
});
