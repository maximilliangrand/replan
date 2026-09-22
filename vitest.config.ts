import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'web/**/*.test.tsx'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
