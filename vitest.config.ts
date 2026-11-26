import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    setupFiles: ['plugins/ssh-console/tests/setup.ts'],
    include: ['plugins/*/tests/**/*.test.{ts,tsx}', 'sdk/tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
