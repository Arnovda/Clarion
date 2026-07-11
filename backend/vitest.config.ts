import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: path.resolve(__dirname),
    include: ['src/**/*.test.ts'],
    // Never discover stale git-worktree copies under .claude/worktrees/*
    // (leftover isolated agent sessions each carry a full backend/ tree).
    // Without this, a path-filtered run (`vitest src/tests/x.test.ts`) matches
    // every worktree's copy too and fails on their unmigrated databases.
    exclude: ['**/node_modules/**', '**/.claude/**', '**/dist/**'],
    setupFiles: ['src/tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run test files sequentially — they share a database
    fileParallelism: false,
  },
});
