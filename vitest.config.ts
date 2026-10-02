import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Fork tests deploy contracts and wait on RPC
    testTimeout: 30_000,
  },
});
