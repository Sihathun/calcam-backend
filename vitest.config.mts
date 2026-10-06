import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // Pure functions and parsers: no database, runs in a second.
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // HTTP-level tests against a real PostgreSQL (embedded, or TEST_DATABASE_URL), with in-memory queue,
        // storage, push and AI fakes.
        test: {
          name: 'integration',
          include: ['tests/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/global-setup.mts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
          // Each test file creates its own users, so files can share one database safely.
          fileParallelism: true,
        },
      },
    ],
  },
});
