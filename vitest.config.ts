import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts'],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
    // Integration tests run serially until proven parallelizable.
    // For now unit tests dominate; they're pure and safe to parallelize.
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
    // Fail the suite on unhandled rejections and module-load failures.
    // Required by the poison-pill bootstrap smoke test.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
