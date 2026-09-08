// ─────────────────────────────────────────────────────────────────────────────
// ORDERS-V2-0 — ninguna ruta pública sirve órdenes ficticias.
//
// `/customer-portal` estaba registrada ANTES del guard de sesión y renderizaba
// dos órdenes hardcodeadas en el propio componente («iPhone 13 Pro · $450»).
// No tenía servicio, hook, query ni auth: 154 líneas de JSX con mocks. Nadie
// enlazaba a ella; se llegaba escribiendo la URL, y lo que se veía parecía
// producto.
//
// Esto NO es el seguimiento público: ése se construye en un bloque futuro con
// su propia superficie de datos. La guarda existe para que la ruta no vuelva
// por inercia mientras tanto.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const APP = resolve(process.cwd(), 'src/App.tsx')

function appWithoutComments(): string {
  return readFileSync(APP, 'utf8')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('ORDERS-V2-0 · rutas públicas sin datos ficticios', () => {
  it('no existe una ruta /customer-portal', () => {
    expect(appWithoutComments()).not.toContain('customer-portal')
  })

  it('el componente no quedó importado ni cargado en diferido', () => {
    const app = appWithoutComments()
    expect(app).not.toContain('CustomerPortal')
    expect(app).not.toContain('pages/CustomerPortal')
  })

  it('la página con las órdenes de mentira ya no está en el árbol', () => {
    expect(existsSync(resolve(process.cwd(), 'src/pages/CustomerPortal.tsx'))).toBe(false)
  })
})
