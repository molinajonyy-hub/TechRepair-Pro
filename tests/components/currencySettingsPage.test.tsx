// ─────────────────────────────────────────────────────────────────────────────
// P0-DÓLAR — La pantalla de Configuración de Moneda.
//
// El bug reportado se ve exactamente acá: el usuario configura una fuente, y al
// volver la pantalla muestra otra. Estos tests montan la página real y miden lo
// que ve el usuario.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── Dobles en el límite de servicios ─────────────────────────────────────────

const getBusinessSettings = vi.fn()
const upsertBusinessSettings = vi.fn()
const getCurrentExchangeRate = vi.fn(async () => 1500)
const getExchangeRateHistory = vi.fn(async () => [])
const upsertExchangeRate = vi.fn(async () => ({}))
const syncDollarizedProducts = vi.fn(async () => ({ updated: 0, skipped: 0, changed: false, prevRate: null, newRate: 0, source: 'manual' }))
const fetchQuote = vi.fn()
const fetchCordoba = vi.fn()

vi.mock('../../src/services/currencyService', () => ({
  currencyService: {
    getBusinessSettings, upsertBusinessSettings, getCurrentExchangeRate,
    getExchangeRateHistory, upsertExchangeRate, syncDollarizedProducts,
  },
}))

vi.mock('../../src/services/exchangeRateService', () => ({
  exchangeRateService: { fetchQuote, fetchCordoba },
}))

vi.mock('../../src/services/dollarRateService', () => ({ clearDollarCache: vi.fn() }))

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', isOwner: true, isAdmin: false }),
}))

const { CurrencySettings } = await import('../../src/pages/CurrencySettings')

function settings(dolar_source: 'nacional' | 'cordoba') {
  return {
    id: 's1', business_id: 'biz-1', default_currency: 'ARS',
    show_usd_price: false, auto_update_rate: true, rate_api_url: null,
    rate_update_frequency_hours: 24, dolar_source,
    updated_at: '2026-08-25T12:00:00Z', created_at: '2026-08-25T12:00:00Z',
  }
}

/** El botón de una fuente, y si está marcado. */
function sourceButton(source: 'nacional' | 'cordoba') {
  return document.querySelector(`[data-dolar-source="${source}"]`) as HTMLElement
}

beforeEach(() => {
  getBusinessSettings.mockReset()
  upsertBusinessSettings.mockReset()
  fetchQuote.mockReset()
  fetchCordoba.mockReset()
})

describe('CurrencySettings — fuente configurada', () => {
  // EL BUG: con 'cordoba' guardado, la pantalla mostraba 'Blue Nacional'.
  it('marca como seleccionada la fuente REALMENTE persistida', async () => {
    getBusinessSettings.mockResolvedValue(settings('cordoba'))
    render(<CurrencySettings />)

    await waitFor(() => expect(sourceButton('cordoba')).toBeTruthy())
    expect(sourceButton('cordoba')).toHaveAttribute('aria-checked', 'true')
    expect(sourceButton('nacional')).toHaveAttribute('aria-checked', 'false')
  })

  it('marca Nacional cuando es la persistida', async () => {
    getBusinessSettings.mockResolvedValue(settings('nacional'))
    render(<CurrencySettings />)

    await waitFor(() => expect(sourceButton('nacional')).toBeTruthy())
    expect(sourceButton('nacional')).toHaveAttribute('aria-checked', 'true')
    expect(sourceButton('cordoba')).toHaveAttribute('aria-checked', 'false')
  })

  it('al guardar manda la fuente elegida explícitamente', async () => {
    const user = userEvent.setup()
    getBusinessSettings.mockResolvedValue(settings('cordoba'))
    upsertBusinessSettings.mockResolvedValue(settings('nacional'))

    render(<CurrencySettings />)
    await waitFor(() => expect(sourceButton('nacional')).toBeTruthy())

    await user.click(sourceButton('nacional'))
    await user.click(screen.getByRole('button', { name: /Guardar Configuración/i }))

    await waitFor(() => expect(upsertBusinessSettings).toHaveBeenCalled())
    expect(upsertBusinessSettings.mock.calls[0][0]).toMatchObject({
      business_id: 'biz-1', dolar_source: 'nacional',
    })
  })

  // GATE: guardar sin tocar el selector NO puede mandar otra fuente.
  it('guardar sin tocar el selector conserva la fuente persistida', async () => {
    const user = userEvent.setup()
    getBusinessSettings.mockResolvedValue(settings('cordoba'))
    upsertBusinessSettings.mockResolvedValue(settings('cordoba'))

    render(<CurrencySettings />)
    await waitFor(() => expect(sourceButton('cordoba')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: /Guardar Configuración/i }))

    await waitFor(() => expect(upsertBusinessSettings).toHaveBeenCalled())
    expect(upsertBusinessSettings.mock.calls[0][0].dolar_source).toBe('cordoba')
    expect(upsertBusinessSettings.mock.calls[0][0].dolar_source).not.toBe('nacional')
  })
})

describe('CurrencySettings — estados de la cotización', () => {
  it('muestra el valor y la fuente cuando la consulta sale bien', async () => {
    const user = userEvent.setup()
    getBusinessSettings.mockResolvedValue(settings('nacional'))
    fetchQuote.mockResolvedValue({
      ok: true, source: 'nacional', sell: 1565, buy: 1532,
      fetchedAt: '2026-08-25T20:00:00Z', strategy: 'bluelytics:v2-latest',
    })

    render(<CurrencySettings />)
    await waitFor(() => expect(sourceButton('nacional')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: /Actualizar · Blue Nacional/i }))

    const status = await screen.findByTestId('currency-status')
    expect(status).toHaveAttribute('data-status-kind', 'ok')
    expect(status).toHaveTextContent(/Cotización actualizada/)
    expect(status).toHaveTextContent(/Blue Nacional/)
    expect(status).toHaveTextContent(/1\.565/)
  })

  // GATE: un fallo del proveedor NO puede mostrarse como cotización, y el
  // mensaje no puede ser el error crudo.
  it('ante un fallo del proveedor muestra el motivo y ninguna cotización', async () => {
    const user = userEvent.setup()
    getBusinessSettings.mockResolvedValue(settings('nacional'))
    fetchQuote.mockResolvedValue({
      ok: false, source: 'nacional', reason: 'timeout',
      message: 'No pudimos obtener Blue Nacional: la fuente tardó demasiado en responder. No se actualizaron precios.',
    })

    render(<CurrencySettings />)
    await waitFor(() => expect(sourceButton('nacional')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: /Actualizar · Blue Nacional/i }))

    const status = await screen.findByTestId('currency-status')
    expect(status).toHaveAttribute('data-status-kind', 'error')
    expect(status).toHaveTextContent(/No pudimos obtener Blue Nacional/)
    expect(status).toHaveTextContent(/No se actualizaron precios/)
    expect(status.textContent).not.toMatch(/Failed to fetch|Function invocation|500|undefined/)
    // No se guardó ninguna cotización.
    expect(upsertExchangeRate).not.toHaveBeenCalled()
  })

  it('el botón queda disponible para reintentar tras el fallo', async () => {
    const user = userEvent.setup()
    getBusinessSettings.mockResolvedValue(settings('nacional'))
    fetchQuote.mockResolvedValue({
      ok: false, source: 'nacional', reason: 'unreachable', message: 'No pudimos conectarnos con Blue Nacional.',
    })

    render(<CurrencySettings />)
    await waitFor(() => expect(sourceButton('nacional')).toBeTruthy())

    const btn = screen.getByRole('button', { name: /Actualizar · Blue Nacional/i })
    await user.click(btn)
    await screen.findByTestId('currency-status')

    await waitFor(() => expect(btn).not.toBeDisabled())
    await user.click(btn)
    expect(fetchQuote).toHaveBeenCalledTimes(2)
  })
})

describe('CurrencySettings — opciones sin backend', () => {
  // La UI ofrecía EUR y GBP contra un CHECK que sólo acepta ARS/USD.
  it('no ofrece monedas que la DB rechaza', async () => {
    getBusinessSettings.mockResolvedValue(settings('nacional'))
    render(<CurrencySettings />)

    await waitFor(() => expect(sourceButton('nacional')).toBeTruthy())
    const values = [...document.querySelectorAll('option')].map(o => (o as HTMLOptionElement).value)
    expect(values).toContain('ARS')
    expect(values).toContain('USD')
    expect(values).not.toContain('EUR')
    expect(values).not.toContain('GBP')
  })

  it('ofrece exactamente las dos fuentes del catálogo', async () => {
    getBusinessSettings.mockResolvedValue(settings('nacional'))
    render(<CurrencySettings />)

    await waitFor(() => expect(sourceButton('nacional')).toBeTruthy())
    expect(document.querySelectorAll('[data-dolar-source]')).toHaveLength(2)
  })
})

describe('CurrencySettings — móvil', () => {
  // La grilla usaba minmax(400px, 1fr): a 360px forzaba 400px y desbordaba.
  it('la grilla no fuerza un ancho mayor al viewport', async () => {
    getBusinessSettings.mockResolvedValue(settings('nacional'))
    const { container } = render(<CurrencySettings />)
    await waitFor(() => expect(sourceButton('nacional')).toBeTruthy())

    const grid = [...container.querySelectorAll<HTMLElement>('div')]
      .find(d => d.style.gridTemplateColumns.includes('minmax'))
    expect(grid).toBeTruthy()
    expect(grid!.style.gridTemplateColumns).toContain('min(400px, 100%)')
  })

  it('los botones de fuente respetan el objetivo táctil mínimo', async () => {
    getBusinessSettings.mockResolvedValue(settings('cordoba'))
    render(<CurrencySettings />)
    await waitFor(() => expect(sourceButton('cordoba')).toBeTruthy())

    for (const source of ['nacional', 'cordoba'] as const) {
      expect(sourceButton(source).style.minHeight).toBe('44px')
    }
  })
})
