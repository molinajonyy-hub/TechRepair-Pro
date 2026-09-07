import { defineConfig } from 'vitest/config'

// Separate from the component suite's fail-closed, no-network setup.
export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify('r1-local-test'),
    __BUILD_COMMIT__: JSON.stringify('r1-testsha'),
  },
  test: {
    include: ['tests/integration/sec08eR1.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
})
