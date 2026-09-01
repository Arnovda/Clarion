/**
 * Frontend unit-test harness (P1-7) — the first one this app has had.
 *
 * jsdom + React Testing Library for components, plain Node semantics for
 * the pure modules (steps derivation, SQL formatting, import parsing —
 * the logic that used to be verified only by throwaway dry-run scripts
 * that were deleted after each session). Tests live in `tests/` so the
 * Next build never sweeps them up.
 *
 * Runs in CI inside test.yml's `frontend-checks` job, which the deploy
 * gate blocks on — the same job that runs `tsc --noEmit`, closing P1-7's
 * "a frontend type error can reach production".
 */

import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Testing Library's between-test DOM cleanup registers itself on the
    // GLOBAL afterEach — without this, one test's render leaks into the
    // next (found on this harness's very first run: a link from test 1
    // failed test 2's "no link" assertion).
    globals: true,
  },
  resolve: {
    // Mirror tsconfig's `@/*` → repo-relative imports used across the app.
    alias: { '@': path.resolve(__dirname) },
  },
});
