// ─────────────────────────────────────────────────────────────────────────────
// P0-DÓLAR — Contrato de la fuente de cotización en el cliente.
//
// Cubre lo que la DB no puede cubrir: el catálogo canónico, la clasificación de
// fallos del proveedor, la clave de caché y la prohibición de sustituir la
// fuente configurada por la otra.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  DOLAR_SOURCES,
  DEFAULT_DOLAR_SOURCE,
  normalizeDolarSource,
  normalizeRateSourceTag,
  rateSourceSpellings,
  describeRateSource,
  isPlausibleRate,
} from '../../src/lib/dollar/quoteSource'

// ── Fake de Supabase, en el límite del módulo ────────────────────────────────

type TableResult = { data: unknown; error: unknown }
const tableResults: Record<string, TableResult> = {}

function makeChain(table: string) {
  const result = () => tableResults[table] ?? { data: null, error: null }
  const chain: Record<string, unknown> = {}
  const passthrough = ['select', 'eq', 'order', 'limit', 'in', 'not', 'upsert', 'insert', 'update']
  for (const m of passthrough) chain[m] = () => chain
  chain.maybeSingle = () => Promise.resolve(result())
  chain.then = (res: unknown, rej: unknown) =>
    Promise.resolve(result()).then(res as never, rej as never)
  return chain
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: (table: string) => makeChain(table) },
}))

// Import DESPUÉS del mock.
const { exchangeRateService } = await import('../../src/services/exchangeRateService')
const { refreshDollarRate, clearDollarCache } = await import('../../src/services/dollarRateService')

const BIZ = '00000000-0000-0000-0000-0000000000d1'

function setSettings(dolar_source: string | null, auto_update_rate = true) {
  tableResults['business_settings'] = { data: { dolar_source, auto_update_rate }, error: null }
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

beforeEach(() => {
  for (const k of Object.keys(tableResults)) delete tableResults[k]
  setSettings('nacional')
  // Sin cotización previa en DB: aísla el camino de red.
  tableResults['exchange_rates'] = { data: null, error: null }
  tableResults['dollar_rate_history'] = { data: null, error: null }
  clearDollarCache(BIZ)
})

afterEach(() => {
  clearDollarCache(BIZ)
})

// ─── Catálogo canónico ───────────────────────────────────────────────────────

describe('catálogo de fuentes', () => {
  it('mapea cada fuente a su proveedor y a su tag persistido', () => {
    expect(DOLAR_SOURCES.nacional.rateSourceTag).toBe('bluelytics')
    expect(DOLAR_SOURCES.cordoba.rateSourceTag).toBe('infodolar-cordoba')
    expect(DOLAR_SOURCES.nacional.label).toBe('Blue Nacional')
    expect(DOLAR_SOURCES.cordoba.label).toBe('Blue Córdoba')
  })

  it('el default canónico es el de la columna: nacional', () => {
    expect(DEFAULT_DOLAR_SOURCE).toBe('nacional')
  })

  it('normaliza las fuentes válidas', () => {
    expect(normalizeDolarSource('nacional')).toEqual({ source: 'nacional', recognized: true })
    expect(normalizeDolarSource('cordoba')).toEqual({ source: 'cordoba', recognized: true })
    expect(normalizeDolarSource('CORDOBA')).toEqual({ source: 'cordoba', recognized: true })
  })

  // GATE: lo desconocido NUNCA puede caer en Córdoba. Ése era el bug.
  it.each([null, undefined, '', 'blue_national', 'dolarapi', 42])(
    'una fuente desconocida (%p) cae en nacional, nunca en cordoba',
    (raw) => {
      const out = normalizeDolarSource(raw)
      expect(out.source).toBe('nacional')
      expect(out.source).not.toBe('cordoba')
      expect(out.recognized).toBe(false)
    },
  )
})

describe('normalización de exchange_rates.source', () => {
  it('reconoce las grafías históricas de Córdoba', () => {
    expect(normalizeRateSourceTag('infodolar-cordoba')).toBe('infodolar-cordoba')
    expect(normalizeRateSourceTag('INFODOLAR_CORDOBA')).toBe('infodolar-cordoba')
    expect(normalizeRateSourceTag('infodolar_cordoba')).toBe('infodolar-cordoba')
  })

  it('reconoce las grafías de Nacional', () => {
    expect(normalizeRateSourceTag('bluelytics')).toBe('bluelytics')
    expect(normalizeRateSourceTag('AMBITO_NACIONAL')).toBe('bluelytics')
  })

  it('no le inventa procedencia al alias legacy "api"', () => {
    expect(normalizeRateSourceTag('api')).toBe('desconocido')
    expect(describeRateSource('api')).toBe('Origen no identificado')
  })

  // GATE: sin las mayúsculas, el bloque "último valor válido" queda vacío
  // porque en producción la mayoría de las filas están en SCREAMING.
  it('rateSourceSpellings incluye la variante en mayúsculas y con guion bajo', () => {
    const spellings = rateSourceSpellings('infodolar-cordoba')
    expect(spellings).toContain('infodolar-cordoba')
    expect(spellings).toContain('INFODOLAR_CORDOBA')
  })

  it('valida el rango plausible del blue', () => {
    expect(isPlausibleRate(1565)).toBe(true)
    expect(isPlausibleRate(0)).toBe(false)
    expect(isPlausibleRate(1)).toBe(false)
    expect(isPlausibleRate(99_999)).toBe(false)
    expect(isPlausibleRate(null)).toBe(false)
  })
})

// ─── Consulta al proveedor: éxito y modos de fallo ───────────────────────────

describe('exchangeRateService.fetchNacional', () => {
  it('devuelve venta y compra cuando el payload es válido', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ blue: { value_sell: 1565, value_buy: 1532 } })))

    const out = await exchangeRateService.fetchNacional()
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.sell).toBe(1565)
    expect(out.buy).toBe(1532)
    expect(out.source).toBe('nacional')
  })

  it('clasifica el timeout y lo dice en castellano', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const e = new Error('timed out'); e.name = 'TimeoutError'; throw e
    }))

    const out = await exchangeRateService.fetchNacional()
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('timeout')
    expect(out.message).toContain('Blue Nacional')
    expect(out.message).not.toMatch(/Failed to fetch|HTTP \d|500/)
  })

  it('clasifica un HTTP no-2xx sin exponer el código', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false, 503)))

    const out = await exchangeRateService.fetchNacional()
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('http_error')
    expect(out.message).not.toContain('503')
  })

  // GATE: un payload inválido NO se acepta como cotización.
  it.each([
    ['sin la clave blue', { oficial: { value_sell: 1531 } }, 'invalid_payload'],
    ['con venta en 0', { blue: { value_sell: 0, value_buy: 0 } }, 'missing_price'],
    ['con venta null', { blue: { value_sell: null } }, 'missing_price'],
    ['con venta absurda', { blue: { value_sell: 999999 } }, 'missing_price'],
  ])('rechaza el payload %s', async (_label, body, reason) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body)))

    const out = await exchangeRateService.fetchNacional()
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe(reason)
  })

  it('ignora una compra mayor que la venta en lugar de invertir el par', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ blue: { value_sell: 1565, value_buy: 1600 } })))

    const out = await exchangeRateService.fetchNacional()
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.sell).toBe(1565)
    expect(out.buy).toBeNull()
  })
})

describe('exchangeRateService.fetchQuote', () => {
  // GATE: si Nacional falla, el resultado es un fallo de Nacional — jamás una
  // cotización de Córdoba disfrazada.
  it('no sustituye la fuente cuando el proveedor falla', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, false, 500))
    vi.stubGlobal('fetch', fetchMock)

    const out = await exchangeRateService.fetchQuote('nacional')
    expect(out.ok).toBe(false)
    expect(out.source).toBe('nacional')
    // Ni un solo intento contra infodolar.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('infodolar')
    }
  })
})

// ─── Caché por fuente ────────────────────────────────────────────────────────

describe('dollarRateService — caché', () => {
  // GATE: la clave de caché DEBE incluir la fuente. Sin eso, cambiar de fuente
  // servía hasta 15 minutos el valor de la anterior, rotulado con la nueva.
  it('no contamina entre fuentes al cambiar la configuración', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('infodolar')
        ? jsonResponse({ compra: 1544, venta: 1600, appliedRate: 1600, mode: 'venta' })
        : jsonResponse({ sell: 1565, buy: 1545, source: 'AMBITO_NACIONAL' }))
    vi.stubGlobal('fetch', fetchMock)

    setSettings('cordoba')
    const cordoba = await refreshDollarRate(BIZ, true)
    expect(cordoba?.sellPrice).toBe(1600)
    expect(cordoba?.source).toBe('INFODOLAR_CORDOBA')

    // El negocio cambia a Nacional. Con caché fresco (force=false) el valor de
    // Córdoba NO puede reaparecer.
    setSettings('nacional')
    const nacional = await refreshDollarRate(BIZ, false)
    expect(nacional?.sellPrice).toBe(1565)
    expect(nacional?.source).toBe('AMBITO_NACIONAL')
    expect(nacional?.sellPrice).not.toBe(1600)
  })

  it('sin fila de settings usa nacional, no cordoba', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ sell: 1565, buy: 1545, source: 'AMBITO_NACIONAL' }))
    vi.stubGlobal('fetch', fetchMock)

    tableResults['business_settings'] = { data: null, error: null }
    const out = await refreshDollarRate(BIZ, true)

    expect(out?.source).toBe('AMBITO_NACIONAL')
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('infodolar')
    }
  })

  it('no consulta la otra fuente cuando la configurada falla', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'down' }, false, 502))
    vi.stubGlobal('fetch', fetchMock)

    setSettings('nacional')
    const out = await refreshDollarRate(BIZ, true)

    // Sin valor previo en DB no hay nada honesto que mostrar.
    expect(out).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('infodolar')
  })

  it('degrada al último valor conocido marcándolo como stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'down' }, false, 502)))

    setSettings('nacional')
    tableResults['exchange_rates'] = {
      data: { rate: 1550, source: 'bluelytics', updated_at: '2026-08-25T12:00:00Z' },
      error: null,
    }

    const out = await refreshDollarRate(BIZ, true)
    expect(out?.sellPrice).toBe(1550)
    expect(out?.isStale).toBe(true)
    expect(out?.warning).toContain('última cotización válida')
    // Conserva el timestamp real del dato, no el del intento fallido.
    expect(out?.fetchedAt.toISOString()).toBe('2026-08-25T12:00:00.000Z')
  })
})
