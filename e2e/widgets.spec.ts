/**
 * Widget render smoke test — the Vega-lesson gate.
 *
 * The Vega-Lite migration shipped silent blank charts repeatedly because
 * every check ran headless against the spec compiler, never against a real
 * browser's rendering. This spec loads /dev/widgets (the fixture gallery,
 * no auth/backend needed) in real Chromium and asserts every widget type in
 * the dashboard DSL actually DREW something — visible marks, rows, or a
 * value — and did not fall into an error/empty state.
 *
 * Adding a widget type? Add it to TYPES here + a fixture in
 * frontend/app/dev/widgets/page.tsx, or this test fails on the count check.
 *
 * Run: frontend on :3000 (next dev or start), then `npx playwright test e2e/widgets.spec.ts`
 */
import { test, expect, type Locator } from '@playwright/test';

const SVG_CHART_TYPES = [
  'bar_chart',
  'vertical_bar_chart',
  'stacked_bar_chart',
  'line_chart',
  'pie_chart',
  'combo_chart',
  'radar_chart',
  'treemap_chart',
  'scatter_chart',
  'bullet_chart',
] as const;

const ALL_TYPES = [
  'kpi_card',
  'top_list',
  'data_table',
  'pivot_table',
  ...SVG_CHART_TYPES,
] as const;

/** Count drawn vector marks (paths/rects/circles/polygons) inside a card. */
async function markCount(card: Locator): Promise<number> {
  return card.locator('svg path, svg rect, svg circle, svg polygon').count();
}

test.describe('widget render gallery', () => {
  test('every widget type renders visible content in a real browser', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      // Resource-load failures (fonts/HMR/network) are environment noise —
      // what this gate cares about is JS/render errors from the widgets.
      if (msg.type() === 'error' && !/Failed to load resource/i.test(msg.text())) {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto('/dev/widgets');
    const gallery = page.getByTestId('widget-gallery');
    await expect(gallery).toBeVisible();

    // The gallery must cover the full DSL — a new widget type that isn't
    // added to the gallery fails here instead of shipping unverified.
    expect(await gallery.getAttribute('data-widget-count')).toBe(String(ALL_TYPES.length));

    for (const type of ALL_TYPES) {
      const card = page.getByTestId(`gallery-${type}`);
      await expect(card, `${type}: card missing`).toBeVisible();

      // No widget may land in the empty or error state on fixture data.
      await expect(card.getByText('No data available'), `${type}: empty state`).toHaveCount(0);
      await expect(card.getByText(/render error|is missing column/i), `${type}: error state`).toHaveCount(0);
    }

    // Vector charts must have actually drawn marks — axes-but-no-marks was
    // the exact silent failure signature of the Vega migration.
    for (const type of SVG_CHART_TYPES) {
      const card = page.getByTestId(`gallery-${type}`);
      await expect
        .poll(() => markCount(card), {
          message: `${type}: expected drawn SVG marks`,
          timeout: 10_000,
        })
        .toBeGreaterThan(3);
    }

    // The two ECharts-rendered types must be on the ECharts engine (SVG
    // renderer) — regression guard against silently falling back to nothing.
    for (const type of ['scatter_chart', 'bullet_chart']) {
      const engine = page.getByTestId(`gallery-${type}`).locator('[data-chart-engine="echarts"] svg');
      await expect(engine, `${type}: echarts svg missing`).toHaveCount(1);
    }

    // Text-based widgets: rows/values visible.
    await expect(page.getByTestId('gallery-kpi_card')).toContainText(/\d/);
    await expect(page.getByTestId('gallery-top_list')).toContainText('Espresso Machine X1');
    await expect(page.getByTestId('gallery-data_table')).toContainText('Acme Corp');
    await expect(page.getByTestId('gallery-pivot_table')).toContainText('Hardware');

    // No console errors during render — blank-chart bugs often surface only here.
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
