// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — contacto de soporte canónico (`CONTACTO_SOPORTE`).
//
//   SC1 /subscription/suspended ofrece soporte por Ayuda, no por la casilla legal
//   SC2 la casilla vieja `soporte@techrepairpro.com` (dominio `.com` sin MX, que
//       no es del producto) no vuelve a ningún archivo de src/
//   SC3 las plantillas de correo ofrecen ayuda por el WhatsApp canónico (hasta
//       BETA-UX-1A: «usan el mismo literal que la constante», la casilla)
//
// BETA-1 cambió SC1: la pantalla mostraba `CONTACTO_SOPORTE` como mailto, pero
// esa casilla es el contacto LEGAL y no un canal atendido. Ahora la línea de
// soporte lleva a /ayuda, que resuelve el canal con `canalSoporte()`. La
// autoridad sigue siendo `config/contacto.ts`.
//
// BETA-UX-1A: el correo dejó de ser respaldo del canal de ayuda, y tampoco es
// la ayuda de las plantillas de Auth (SC3): esas enlazan al WhatsApp canónico.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CONTACTO_SOPORTE, validarWhatsAppSoporte } from '../../src/config/contacto'
import { PLANTILLAS, WHATSAPP_SOPORTE, analizarPlantilla, enlaceSoporteDe } from '../../scripts/guards/auth-email-templates.mjs'

vi.mock('../../src/hooks/useSubscription', () => ({
  useSubscription: () => ({
    subscription: { subscription_status: 'suspended' },
    loading: false,
    isSuspended: true,
    isCanceled: false,
  }),
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
  it('SC1. la pantalla de cuenta suspendida ofrece soporte por Ayuda', () => {
    render(<MemoryRouter><SubscriptionSuspended /></MemoryRouter>)

    // El testid de PRE-BETA-2D se conserva; ahora lleva a Ayuda. El negocio de
    // este test está suspendido sin trial vencido ni billing, así que Ayuda es
    // su CTA primario («Contactar soporte»).
    const linea = screen.getByTestId('subscription-suspended-soporte')
    expect(linea.textContent).toContain('Contactar soporte')
    expect(linea.querySelector('a')?.getAttribute('href')).toBe('/ayuda')

    // La casilla legal no se presenta como soporte en el muro.
    expect(document.body.textContent).not.toContain(CONTACTO_SOPORTE)
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull()
    expect(document.body.textContent).not.toContain('soporte@techrepairpro.com')
  })

  it('SC2. ningún archivo de src/ vuelve a usar una casilla @techrepairpro.com', () => {
    const culpables = archivos('src').filter(p => /@techrepairpro\.com\b/i.test(readFileSync(p, 'utf8')))
    expect(culpables).toEqual([])
  })

  // BETA-UX-1A cambió SC3: las plantillas ofrecían la casilla institucional como
  // ayuda. El owner confirmó que no se atiende como soporte: ahora enlazan al
  // WhatsApp canónico, con un mensaje fijo, y no traen ninguna casilla.
  it('SC3. las plantillas de correo ofrecen ayuda por el WhatsApp canónico, sin ninguna casilla', () => {
    for (const { archivo, tipo, ayuda } of Object.values(PLANTILLAS)) {
      const html = readFileSync(archivo, 'utf8')

      // Dos enlaces y nada más: el de Auth (token_hash, intacto) y el de ayuda.
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1])
      expect(hrefs, archivo).toEqual([`{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=${tipo}`, enlaceSoporteDe(tipo)])

      const soporte = new URL(enlaceSoporteDe(tipo))
      expect(soporte.origin + soporte.pathname, archivo).toBe(`https://wa.me/${WHATSAPP_SOPORTE}`)
      // Mensaje fijo, codificado, sin datos del usuario ni parámetros de tracking.
      expect(soporte.searchParams.get('text'), archivo).toBe(ayuda)
      expect([...soporte.searchParams.keys()], archivo).toEqual(['text'])
      expect(soporte.search.slice('?text='.length), archivo).toMatch(/^[A-Za-z0-9%.,_~!*'()-]+$/)
      expect(ayuda, archivo).toMatch(/^Hola, [^@\d{}$<>]+\.$/)
      expect(html, archivo).toContain('Escribinos por WhatsApp')

      // Ni el Gmail institucional ni ningún otro correo, ni como enlace ni como texto.
      expect(html, archivo).not.toMatch(/mailto:/i)
      expect(html, archivo).not.toContain(CONTACTO_SOPORTE)
      expect(html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g), archivo).toBeNull()

      expect(analizarPlantilla(html, tipo, CONTACTO_SOPORTE), archivo).toEqual([])
    }
  })

  it('SC3b. el número escrito en las plantillas cumple la regla de la app (549 + 10 dígitos)', () => {
    // Supabase Auth no lee VITE_CONTACT_WHATSAPP: el número está versionado en
    // las plantillas. Tiene que ser una configuración que la app aceptaría.
    expect(validarWhatsAppSoporte(WHATSAPP_SOPORTE)).toEqual({ ok: true, numero: WHATSAPP_SOPORTE })
  })

  it('SC3c. el guard rechaza la ayuda por correo si alguien la vuelve a poner', () => {
    const { archivo, tipo } = PLANTILLAS.confirmation
    const anterior = readFileSync(archivo, 'utf8').replace(
      /<a href="https:\/\/wa\.me\/[^"]*"[^>]*>Escribinos por WhatsApp<\/a>/,
      `Escribinos a <a href="mailto:${CONTACTO_SOPORTE}">${CONTACTO_SOPORTE}</a>`,
    )
    const hallazgos = analizarPlantilla(anterior, tipo, CONTACTO_SOPORTE)
    expect(hallazgos.join('\n')).toMatch(/mailto como ayuda/)
    expect(hallazgos.join('\n')).toMatch(/casilla institucional/)
    expect(hallazgos.join('\n')).toMatch(/falta el enlace de ayuda al WhatsApp canónico/)
  })
})
