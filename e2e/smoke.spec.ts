import { test, expect } from '@playwright/test';

/**
 * E2E smoke test: register → login → navigate key pages.
 *
 * Requires both frontend (port 3000) and backend (port 3001) to be running.
 * Run with: npx playwright test
 */

const TEST_EMAIL = `e2e-${Date.now()}@test.com`;
const TEST_PASSWORD = 'E2eTestPass123!';
const TEST_COMPANY = 'E2E Test Co';
const TEST_NAME = 'E2E Admin';

test.describe('Smoke test', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/');
    // Should see the login form
    await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible({ timeout: 10_000 });
  });

  test('register → login → navigate', async ({ page }) => {
    // Register
    await page.goto('/register');
    await page.fill('input[name="companyName"], input[placeholder*="company" i]', TEST_COMPANY);
    await page.fill('input[name="displayName"], input[placeholder*="name" i]', TEST_NAME);
    await page.fill('input[name="email"], input[type="email"]', TEST_EMAIL);
    await page.fill('input[name="password"], input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    // Should redirect to setup or dashboard
    await page.waitForURL(/\/(setup|dashboards|semantic)/, { timeout: 15_000 });

    // Navigate to semantic page
    await page.goto('/semantic');
    await expect(page.locator('body')).toContainText(/semantic|definition|table/i, { timeout: 10_000 });

    // Navigate to query page
    await page.goto('/query');
    await expect(page.locator('body')).toContainText(/ask|question|query|chat/i, { timeout: 10_000 });

    // Navigate to dashboards
    await page.goto('/dashboards');
    await expect(page.locator('body')).toContainText(/dashboard/i, { timeout: 10_000 });
  });
});
