import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/source/**'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 85,
        branches: 80,
      },
    },
  },
});
