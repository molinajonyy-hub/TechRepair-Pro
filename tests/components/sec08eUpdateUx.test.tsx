import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from '../../src/components/UpdateBanner'
import { createClientContractFetch } from '../../src/lib/clientContract'
import { clientUpdateSignal } from '../../src/lib/clientUpdateSignal'

const reload = vi.hoisted(() => vi.fn())
vi.mock('../../src/hooks/useUpdateDetector', () => ({ useUpdateDetector: () => ({ updateAvailable: true, reload }) }))

describe('SEC-08E R1 mandatory update', () => {
  it('overrides dismissal, persists through remount, deduplicates, retries only on user action and preserves local data', async () => {
    localStorage.setItem('r1-draft', 'keep me')
    sessionStorage.setItem('r1-session', 'keep session')
    const listener = vi.fn()
    const unsubscribe = clientUpdateSignal.subscribe(listener)
    const view = render(<UpdateBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar aviso de actualización' }))
    expect(screen.queryByTestId('update-banner')).toBeNull()
    const response = new Response('{"code":"CLIENT_UPDATE_REQUIRED"}', { status: 409 })
    const transport = createClientContractFetch('http://localhost:54321', vi.fn().mockResolvedValue(response))
    await act(async () => { await transport('http://localhost:54321/rest/v1/orders') })
    expect(screen.getByRole('alert')).toHaveTextContent('Actualizá la aplicación para continuar.')
    expect(screen.queryByRole('button', { name: /Cerrar/ })).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    await act(async () => { await transport('http://localhost:54321/rest/v1/rpc/get_my_profile') })
    expect(listener).toHaveBeenCalledOnce()
    view.unmount()
    render(<UpdateBanner />)
    expect(screen.getByRole('alert')).toHaveAttribute('data-update-mode', 'mandatory')
    reload.mockRejectedValueOnce(new Error('SW lookup failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No se pudo actualizar'))
    expect(reload).toHaveBeenCalledOnce()
    reload.mockImplementationOnce(() => new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }))
    expect(screen.getByRole('button', { name: 'Actualizando…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Actualizando…' }))
    expect(reload).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem('r1-draft')).toBe('keep me')
    expect(sessionStorage.getItem('r1-session')).toBe('keep session')
    unsubscribe()
  })
})
