import { expect } from 'vitest'
import * as matchers from '@testing-library/jest-dom/matchers'

// Bind the official matchers directly to the expect used by the H01 suites.
expect.extend(matchers)
