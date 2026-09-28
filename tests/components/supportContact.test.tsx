// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — contacto de soporte canónico (`CONTACTO_SOPORTE`).
//
//   SC1 /subscription/suspended muestra el canónico como mailto
//   SC2 la casilla vieja `soporte@techrepairpro.com` (dominio `.com` sin MX, que
//       no es del producto) no vuelve a ningún archivo de src/
//   SC3 las plantillas de correo usan el mismo literal que la constante
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CONTACTO_SOPORTE } from '../../src/config/contacto'

vi.mock('../../src/hooks/useSubscription', () => ({
  useSubscription: () => ({ subscription: { subscription_status: 'suspended' } }),
}))
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ signOut: async () => {} }),
}))

import { SubscriptionSuspended } from '../../src/pages/SubscriptionSuspended'

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap(e => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? archivos(p) : /\.(ts|tsx|css|html)$/.test(p) ? [p] : []
  })
}

describe('PRE-BETA-2D · soporte canónico', () => {
  it('SC1. la pantalla de cuenta suspendida muestra CONTACTO_SOPORTE como mailto', () => {
    render(<MemoryRouter><SubscriptionSuspended /></MemoryRouter>)
    const linea = screen.getByTestId('subscription-suspended-soporte')
    expect(linea.textContent).toContain(CONTACTO_SOPORTE)
    expect(linea.querySelector('a')?.getAttribute('href')).toBe(`mailto:${CONTACTO_SOPORTE}`)
    expect(document.body.textContent).not.toContain('soporte@techrepairpro.com')
  })

  it('SC2. ningún archivo de src/ vuelve a usar una casilla @techrepairpro.com', () => {
    const culpables = archivos('src').filter(p => /@techrepairpro\.com\b/i.test(readFileSync(p, 'utf8')))
    expect(culpables).toEqual([])
  })

  it('SC3. las plantillas de correo usan exactamente CONTACTO_SOPORTE', () => {
    for (const archivo of ['supabase/templates/confirmation.html', 'supabase/templates/recovery.html']) {
      const html = readFileSync(archivo, 'utf8')
      expect(html).toContain(`mailto:${CONTACTO_SOPORTE}`)
      const emails = [...html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map(m => m[0])
      expect(new Set(emails)).toEqual(new Set([CONTACTO_SOPORTE]))
    }
  })
})
