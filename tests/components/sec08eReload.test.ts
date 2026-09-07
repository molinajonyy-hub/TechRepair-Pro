import { describe, expect, it, vi } from 'vitest'
import { hardReload } from '../../src/hooks/useUpdateDetector'

describe('SEC-08E R1 user-triggered reload', () => {
  it('awaits old SW unregistration and replaces the same route with a fresh cache key', async () => {
    let complete!: (value: boolean) => void
    const unregister = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve }))
    const replace = vi.fn()
    vi.stubGlobal('navigator', { serviceWorker: { getRegistrations: async () => [{ unregister }] } })
    vi.stubGlobal('window', { location: { href: 'https://app.test/orders/1?view=parts#notes', replace } })
    vi.spyOn(Date, 'now').mockReturnValue(123456789)
    const pending = hardReload()
    await Promise.resolve()
    expect(unregister).toHaveBeenCalledOnce()
    expect(replace).not.toHaveBeenCalled()
    complete(true)
    await pending
    expect(replace).toHaveBeenCalledWith('https://app.test/orders/1?view=parts&_tr_update=123456789#notes')
  })

  it('uses a fresh document URL without an SW; replaces the prior nonce', async () => {
    const replace = vi.fn()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('window', { location: { href: 'https://app.test/?_tr_update=old', replace } })
    vi.spyOn(Date, 'now').mockReturnValue(456)
    await hardReload()
    expect(replace).toHaveBeenCalledWith('https://app.test/?_tr_update=456')
  })

  it('leaves navigation alone if unregister fails so the UI can offer retry', async () => {
    const replace = vi.fn()
    const failure = new Error('SW unavailable')
    vi.stubGlobal('navigator', { serviceWorker: { getRegistrations: async () => [{ unregister: () => Promise.reject(failure) }] } })
    vi.stubGlobal('window', { location: { replace } })
    await expect(hardReload()).rejects.toBe(failure)
    expect(replace).not.toHaveBeenCalled()
  })
})
