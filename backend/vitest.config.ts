import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: path.resolve(__dirname),
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run test files sequentially — they share a database
    fileParallelism: false,
  },
});
