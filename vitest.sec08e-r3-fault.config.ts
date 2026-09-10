import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: { __BUILD_TIME__: JSON.stringify('r3-local-test'), __BUILD_COMMIT__: JSON.stringify('r3-testsha') },
  test: { include: ['tests/integration/sec08eR3Fault.test.ts'], environment: 'node', testTimeout: 15000 },
})
