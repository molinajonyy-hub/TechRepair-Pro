// ─────────────────────────────────────────────────────────────────────────────
// Setup mínimo de los tests de componentes.
//   · matchers de jest-dom;
//   · cleanup automático entre tests;
//   · fail-closed contra la red: cualquier fetch en un test es un error, así que
//     un componente que se conecte de verdad a Supabase no puede pasar inadvertido;
//   · variables de entorno FALSAS: nunca las de producción.
// ─────────────────────────────────────────────────────────────────────────────
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

// Entorno determinístico y explícitamente falso.
process.env.VITE_SUPABASE_URL = 'http://localhost:0/test-only'
process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key-not-a-real-secret'

beforeEach(() => {
  // Ningún test de componentes puede salir a la red.
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Los tests de componentes no pueden usar la red. Mockeá el hook o el servicio.')
  }))
  // matchMedia no existe en jsdom y varios componentes lo consultan para el tema.
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
