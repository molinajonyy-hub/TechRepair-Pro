import { defineConfig } from 'vitest/config'

// Only the disposable Docker runner supplies this suite's loopback endpoint.
// Keep the normal component suite's no-network setup untouched.
export default defineConfig({
  test: {
    include: ['tests/integration/sec08eRollout.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
})
