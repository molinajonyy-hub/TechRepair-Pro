// ─────────────────────────────────────────────────────────────────────────────
// P0 FASE 2 · §5 — Detección de bundle viejo en el shell del portal.
//
// Después del lockdown, un bundle anterior a la FASE 1 que consulte la tabla
// recibe 42501. La pantalla de error ya ofrece «Actualizar», pero el usuario
// también tiene que poder enterarse SIN chocarse con un error: eso lo hace el
// detector de versión que ya existe (useUpdateDetector + /version.json), que
// hasta ahora NO se montaba en el dominio dedicado del portal —App.tsx devuelve
// el router del portal antes de llegar a <UpdateBanner/>—.
//
// Se reusa ese detector; no se crea un segundo sistema. Estos tests fijan las
// dos mitades del contrato: que esté montado donde faltaba y que NO se duplique
// donde App.tsx ya lo monta.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { PortalRouter } from '../../src/portal/PortalRouter'

const rpcMock = vi.fn()

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }), order: () => q, gt: () => q, limit: () => q }
      return q
    },
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({ error: null }),
    },
  },
}))

// Marcador: lo que importa es SI el shell monta el detector, no cómo se ve.
// (El banner real sólo pinta cuando /version.json difiere, y en los tests el
// fetch está bloqueado a propósito.)
vi.mock('../../src/components/UpdateBanner', () => ({
  UpdateBanner: () => <div data-testid="update-banner-montado" />,
}))

const FILA_OK = {
  id: 'biz-1', name: 'Clic Mayorista', logo_url: null,
  wholesale_portal_enabled: true, wholesale_portal_slug: 'clic',
  wholesale_whatsapp: null, wholesale_portal_theme: null,
}

beforeEach(() => {
  rpcMock.mockReset()
  rpcMock.mockResolvedValue({ data: [FILA_OK], error: null, status: 200 })
})

describe('detección de versión en el shell del portal', () => {
  test('el dominio dedicado del portal monta el detector existente', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/*" element={<PortalRouter forcedSlug="clic" />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('update-banner-montado')).toBeInTheDocument()
    })
  })

  test('en el dominio principal NO se monta de nuevo (App.tsx ya lo monta)', async () => {
    render(
      <MemoryRouter initialEntries={['/mayorista/clic']}>
        <Routes>
          <Route path="/mayorista/:slug/*" element={<PortalRouter />} />
        </Routes>
      </MemoryRouter>,
    )
    // Se espera a que el portal resuelva para no medir un árbol a medio montar.
    await waitFor(() => expect(rpcMock).toHaveBeenCalled())
    expect(screen.queryByTestId('update-banner-montado')).toBeNull()
  })

  test('el detector sigue visible cuando el portal falla con 42501', async () => {
    // El caso real: bundle viejo → 42501 → pantalla de error. El aviso de
    // versión nueva tiene que convivir con esa pantalla, no desaparecer con ella.
    rpcMock.mockResolvedValue({
      data: null, error: { code: '42501', message: 'permission denied' }, status: 403,
    })
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/*" element={<PortalRouter forcedSlug="clic" />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByTestId('portal-error')
    expect(screen.getByTestId('update-banner-montado')).toBeInTheDocument()
    // Y la pantalla de error ofrece su propia recarga dura.
    expect(screen.getByRole('button', { name: /Actualizar/i })).toBeInTheDocument()
  })
})
