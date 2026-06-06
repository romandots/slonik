import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // SSE/drain teardown shim for the MCP SDK + light-my-request — see file.
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
