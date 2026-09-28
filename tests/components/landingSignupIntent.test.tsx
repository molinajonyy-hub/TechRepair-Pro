// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — «Probar gratis» abre «Crear cuenta», no «Iniciar sesión».
//
//   LP1 hero → registro          LP2 header → registro
//   LP3 CTA final → registro      LP4 plan de pricing → registro + plan
//   LP5 menú mobile → registro    LP6 «Ingresar» → login normal (sin modo)
//
// Se mockean analytics y el tema: lo que se afirma es a DÓNDE navega cada CTA.
// Que `/login?modo=registro` abre la pestaña de registro lo fija
// tests/components/authUxHardening.test.tsx (L1).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

vi.mock('../../src/lib/analytics', () => ({
  initLandingAnalytics: () => {},
  track: () => {},
}))

vi.mock('../../src/hooks/useTheme', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: () => {} }),
}))

import { LandingPage } from '../../src/pages/LandingPage'

beforeAll(() => {
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO
  if (!window.matchMedia) {
    ;(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: true, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    })
  }
})

function Destino() {
  const l = useLocation()
  return <div data-testid="destino">{l.pathname + l.search}</div>
}

function montar() {
  return render(
    <MemoryRouter initialEntries={['/landing']}>
      <Routes>
        <Route path="/landing" element={<LandingPage />} />
        <Route path="/login" element={<Destino />} />
      </Routes>
    </MemoryRouter>,
  )
}

const REGISTRO = '/login?modo=registro&redirectTo=%2Fonboarding'
const destino = () => screen.getByTestId('destino').textContent

beforeEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
})

describe('PRE-BETA-2D · landing → registro', () => {
  it('LP1. hero «Probar gratis 14 días» → registro con /onboarding', () => {
    const { container } = montar()
    fireEvent.click(within(container.querySelector('#top') as HTMLElement).getByRole('button', { name: /probar gratis 14 días/i }))
    expect(destino()).toBe(REGISTRO)
  })

  it('LP2. header «Probar gratis» → registro', () => {
    const { container } = montar()
    fireEvent.click(within(container.querySelector('.lp-header-actions') as HTMLElement).getByRole('button', { name: 'Probar gratis' }))
    expect(destino()).toBe(REGISTRO)
  })

  it('LP3. CTA final → registro', () => {
    const { container } = montar()
    fireEvent.click(within(container.querySelector('.lp-final') as HTMLElement).getByRole('button', { name: /probar gratis 14 días/i }))
    expect(destino()).toBe(REGISTRO)
  })

  it('LP4. un plan de pricing → registro con el plan preservado', () => {
    const { container } = montar()
    fireEvent.click(within(container.querySelector('#planes .lp-plan.is-featured') as HTMLElement).getByRole('button', { name: /probar gratis 14 días/i }))
    expect(destino()).toBe('/login?modo=registro&redirectTo=%2Fonboarding%3Fplan%3Dpro')
  })

  it('LP5. menú mobile «Probar gratis» → registro', () => {
    const { container } = montar()
    fireEvent.click(container.querySelector('.lp-burger') as HTMLElement)
    fireEvent.click(within(container.querySelector('#lp-mobile-menu') as HTMLElement).getByRole('button', { name: /probar gratis/i }))
    expect(destino()).toBe(REGISTRO)
  })

  it('LP6. «Ingresar» sigue abriendo el login normal', () => {
    const { container } = montar()
    fireEvent.click(within(container.querySelector('.lp-header-actions') as HTMLElement).getByRole('button', { name: 'Ingresar' }))
    expect(destino()).toBe('/login')
  })
})
