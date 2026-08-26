/// <reference types="vitest" />
// ─────────────────────────────────────────────────────────────────────────────
// P0-A.1U1 — Entorno AISLADO de tests de componentes.
//
// Convive con `node --test` sin tocarlo: los 572 tests unitarios existentes
// siguen corriendo igual, con su propio script. Esta config sólo mira
// tests/components/ y nunca toca tests/unit/.
//
// Sin red, sin Supabase real, sin variables de producción: los mocks van en el
// límite de hooks/servicios, nunca del componente bajo prueba.
// ─────────────────────────────────────────────────────────────────────────────
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Los mismos globals que inyecta vite.config.ts. Sin esto, cualquier test que
  // monte el shell del portal explota con ReferenceError: __BUILD_TIME__ is not
  // defined, porque el detector de versión (useUpdateDetector) lo lee en el
  // scope del módulo. Valores fijos: los tests no comparan builds, sólo
  // necesitan que el símbolo exista.
  define: {
    __BUILD_TIME__: JSON.stringify('test-build-time'),
    __BUILD_COMMIT__: JSON.stringify('testsha'),
  },
  test: {
    include: ['tests/components/**/*.test.ts', 'tests/components/**/*.test.tsx'],
    exclude: ['tests/unit/**', 'tests/e2e/**', 'node_modules/**'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/components/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    css: false,
  },
})
