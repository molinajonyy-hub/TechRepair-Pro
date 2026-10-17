import { defineConfig, mergeConfig } from 'vitest/config'
import componentConfig from './vitest.config'

// Keep the established isolated component environment and its network guard.
// Register DOM matchers explicitly for the H01 compatibility suites.
export default mergeConfig(componentConfig, defineConfig({
  test: {
    setupFiles: ['tests/components/h01Setup.ts'],
  },
}))
