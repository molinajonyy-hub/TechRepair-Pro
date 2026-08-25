import {
  type DolarSource,
  type QuoteOutcome,
  type QuoteFailureReason,
  isPlausibleRate,
  quoteFailureMessage,
} from '../lib/dollar/quoteSource'

export type { DolarSource }

/** Compra y venta explícitos de InfoDolar Córdoba. */
export interface CordobaRateDetail {
  compra: number
  venta: number
  /** Siempre 'venta' — nunca promedio ni compra. */
  mode: 'venta'
  strategy: string
  fetchedAt?: string
}

// ── Helpers de parseo ─────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseArgPrice(s: string): number | null {
  const clean = s.replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.')
  const n = parseFloat(clean)
  return isFinite(n) && n >= 500 && n <= 9999 ? n : null
}

const PRICE_RE = /\b(\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\d{3,4}(?:[,]\d{1,2})?)\b/g

/**
 * Parser para infodolar.com HTML — 4 estrategias en orden de especificidad.
 * Retorna compra Y venta explícitos, nunca promedio.
 * Usado tanto en el frontend (fallback proxy) como en la Edge Function.
 */
function extractInfoDolarCordobaRates(html: string): CordobaRateDetail | null {
  // Estrategia 1: JSON embebido
  const jsonMatch = html.match(
    /"compra"\s*:\s*["']?([\d.,]+)["']?[^}]{0,100}"venta"\s*:\s*["']?([\d.,]+)/i
  )
  if (jsonMatch) {
    const compra = parseArgPrice(jsonMatch[1])
    const venta  = parseArgPrice(jsonMatch[2])
    if (compra && venta && venta > compra)
      return { compra, venta, mode: 'venta', strategy: 'json-embedded' }
  }

  // Estrategia 2: Fila de tabla HTML con "blue" o "informal"
  const tableRowRe = /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*?(?:blue|informal)(?:(?!<\/tr>)[\s\S])*?<\/tr>/gi
  let rowMatch: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((rowMatch = tableRowRe.exec(html)) !== null) {
    const row = rowMatch[0]
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(c => stripHtml(c[1]).trim())
    const prices = cells.map(c => parseArgPrice(c)).filter((p): p is number => p !== null)
    if (prices.length >= 2) {
      const sorted = [...prices].sort((a, b) => a - b)
      const compra = sorted[0], venta = sorted[sorted.length - 1]
      if (venta > compra) return { compra, venta, mode: 'venta', strategy: 'html-table-row' }
    }
  }

  // Estrategia 3: Etiquetas compra/venta en HTML crudo
  const cvMatch = html.match(
    /compra[^]*?(\$?\s*\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\$?\s*\d{3,4}(?:[,]\d{1,2})?)[^]*?venta[^]*?(\$?\s*\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\$?\s*\d{3,4}(?:[,]\d{1,2})?)/i
  )
  if (cvMatch) {
    const compra = parseArgPrice(cvMatch[1])
    const venta  = parseArgPrice(cvMatch[2])
    if (compra && venta && venta > compra)
      return { compra, venta, mode: 'venta', strategy: 'html-compra-venta-labels' }
  }

  // Estrategia 4: Texto plano — sección blue/informal
  const text = stripHtml(html)
  const blueIdx = text.search(/\b(?:blue|informal|dolar blue|dólar blue)\b/i)
  if (blueIdx !== -1) {
    const seg = text.slice(Math.max(0, blueIdx - 30), blueIdx + 600)
    const compraLabelIdx = seg.search(/compra/i)
    const ventaLabelIdx  = seg.search(/venta/i)
    if (compraLabelIdx !== -1 && ventaLabelIdx !== -1) {
      const compraM = seg.slice(compraLabelIdx, compraLabelIdx + 120).match(PRICE_RE)
      const ventaM  = seg.slice(ventaLabelIdx,  ventaLabelIdx  + 120).match(PRICE_RE)
      const compra  = compraM ? parseArgPrice(compraM[0]) : null
      const venta   = ventaM  ? parseArgPrice(ventaM[0])  : null
      if (compra && venta && venta > compra)
        return { compra, venta, mode: 'venta', strategy: 'text-explicit-labels' }
    }
    const allMatches = [...seg.matchAll(PRICE_RE)]
    const prices: number[] = []
    for (const m of allMatches) { const p = parseArgPrice(m[1]); if (p) prices.push(p) }
    const unique = [...new Set(prices)].sort((a, b) => a - b)
    if (unique.length >= 2) {
      const compra = unique[0], venta = unique[unique.length - 1]
      if (venta / compra <= 1.05)
        return { compra, venta, mode: 'venta', strategy: 'text-min-max' }
    }
  }
  return null
}

/** Parser original para Bluelytics (Blue Nacional) — no modificar. */
function extractBlueVenta(html: string): number | null {
  const text = stripHtml(html)
  const idx = text.search(/\bblue\b/i)
  if (idx !== -1) {
    const seg = text.slice(idx, idx + 700)
    const matches = [...seg.matchAll(PRICE_RE)]
    const prices: number[] = []
    for (const m of matches) { const p = parseArgPrice(m[1]); if (p) prices.push(p) }
    if (prices.length >= 2) return Math.max(...prices)
    if (prices.length === 1) return prices[0]
  }
  const raw = html.match(/blue[^]*?venta[^<]{0,200}?(\$?\s*[\d.]+,\d{2})/i)
  if (raw) { const p = parseArgPrice(raw[1]); if (p) return p }
  return null
}

// ── Fetch con timeout y retry ─────────────────────────────────────────────────

interface FetchRetryOptions {
  timeoutMs: number
  retries: number
  retryDelayMs: number
  requestInit?: RequestInit
}

async function fetchWithTimeoutAndRetry(url: string, opts: FetchRetryOptions): Promise<Response> {
  const { timeoutMs, retries, retryDelayMs, requestInit } = opts
  let lastError: Error = new Error('fetch failed')
  const total = retries + 1

  for (let attempt = 1; attempt <= total; attempt++) {
    const t0 = Date.now()
    try {
      console.log(`[fetchRetry] attempt ${attempt}/${total} timeout=${timeoutMs}ms`)
      const res = await fetch(url, { ...requestInit, signal: AbortSignal.timeout(timeoutMs) })
      console.log(`[fetchRetry] attempt ${attempt} OK in ${Date.now() - t0}ms status=${res.status}`)
      return res
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err))
      lastError = e
      const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError'
      const isNetwork = e.name === 'TypeError' || e.message.includes('Failed to fetch')
      console.warn(`[fetchRetry] attempt ${attempt} failed (${e.name}): ${e.message} after ${Date.now() - t0}ms`)
      if (attempt < total && (isTimeout || isNetwork)) {
        await new Promise(r => setTimeout(r, retryDelayMs))
        continue
      }
      break
    }
  }
  throw lastError
}

// ── Configuración de proveedores ─────────────────────────────────────────────

const ENV = (import.meta as { env?: Record<string, string> }).env ?? {}
const SUPABASE_ANON_KEY = ENV.VITE_SUPABASE_ANON_KEY ?? ''

// La URL del proyecto salía hardcodeada al proyecto productivo, así que un
// build local/E2E consultaba la Edge Function de PRODUCCIÓN. Ahora sale del
// entorno, como el resto del cliente Supabase.
const SUPABASE_URL = (ENV.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
const EDGE_FN_URL = `${SUPABASE_URL}/functions/v1/infodolar-cordoba`

const BLUELYTICS_URL = 'https://api.bluelytics.com.ar/v2/latest'

/** Allowlist cerrada de destinos. El cliente nunca elige una URL. */
const PROVIDER_TIMEOUT_MS = 20_000

// ── Clasificación de errores de red ──────────────────────────────────────────

function classifyNetworkError(err: unknown): QuoteFailureReason {
  const e = err instanceof Error ? err : new Error(String(err))
  if (e.name === 'TimeoutError' || e.name === 'AbortError' || /timed out/i.test(e.message)) return 'timeout'
  return 'unreachable'
}

function fail(source: DolarSource, reason: QuoteFailureReason): QuoteOutcome {
  return { ok: false, source, reason, message: quoteFailureMessage(source, reason) }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') { const n = parseArgPrice(v); return n }
  return null
}

// ── Servicio ──────────────────────────────────────────────────────────────────

export const exchangeRateService = {
  /**
   * Dólar Blue Nacional — Bluelytics API (CORS-friendly, JSON directo).
   *
   * Devuelve un QuoteOutcome: distingue timeout, host inalcanzable, HTTP no-2xx,
   * payload ilegible y precio ausente. Antes colapsaba todo a `null`, así que la
   * UI no podía decir por qué había fallado ni distinguir "falló" de "sin dato".
   */
  async fetchNacional(): Promise<QuoteOutcome> {
    const source: DolarSource = 'nacional'

    let res: Response
    try {
      res = await fetch(BLUELYTICS_URL, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })
    } catch (err) {
      return fail(source, classifyNetworkError(err))
    }

    if (!res.ok) return fail(source, 'http_error')

    let data: unknown
    try {
      data = await res.json()
    } catch {
      return fail(source, 'invalid_payload')
    }

    if (!isRecord(data) || !isRecord(data.blue)) return fail(source, 'invalid_payload')

    const sell = toNumber(data.blue.value_sell)
    const buy  = toNumber(data.blue.value_buy)

    // Validación de rango: un payload con 0, null o un valor absurdo NO se
    // acepta como cotización.
    if (!isPlausibleRate(sell)) return fail(source, 'missing_price')

    return {
      ok:        true,
      source,
      sell,
      buy:       isPlausibleRate(buy) && buy < sell ? buy : null,
      fetchedAt: new Date().toISOString(),
      strategy:  'bluelytics:v2-latest',
    }
  },

  /**
   * InfoDolar Córdoba — devuelve compra Y venta explícitos.
   *
   * Estrategia 1 (primaria): Edge Function Supabase (fetch server-side, sin proxy).
   * Estrategia 2 (fallback): allorigins.win proxy con 2 intentos y 15s timeout.
   *
   * SIEMPRE retorna venta. NUNCA usa promedio, compra ni fallback a nacional.
   * Si ambas estrategias fallan → retorna null → error visible en UI, no se actualizan precios.
   */
  async fetchCordoba(): Promise<QuoteOutcome> {
    const source: DolarSource = 'cordoba'

    // ── Transporte 1: Edge Function (server-side, confiable) ──────────────────
    // Ambos transportes consultan el MISMO proveedor (infodolar.com). No es un
    // fallback entre fuentes: nunca se sustituye Córdoba por Nacional.
    let edgeFailure: QuoteFailureReason | null = null

    if (SUPABASE_URL) {
      try {
        const res = await fetch(EDGE_FN_URL, {
          headers: {
            'apikey':        SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type':  'application/json',
          },
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        })

        let data: unknown = null
        try { data = await res.json() } catch { data = null }

        if (!res.ok || !isRecord(data) || data.error) {
          const code = isRecord(data) && typeof data.code === 'string' ? data.code : ''
          edgeFailure = code === 'timeout' ? 'timeout'
            : code === 'parse'             ? 'missing_price'
            : !res.ok                      ? 'http_error'
            :                                'invalid_payload'
        } else {
          const venta  = toNumber(data.appliedRate) ?? toNumber(data.venta)
          const compra = toNumber(data.compra)

          if (!isPlausibleRate(venta)) {
            edgeFailure = 'missing_price'
          } else {
            return {
              ok:        true,
              source,
              sell:      venta,
              buy:       isPlausibleRate(compra) && compra < venta ? compra : null,
              fetchedAt: typeof data.fetchedAt === 'string' ? data.fetchedAt : new Date().toISOString(),
              strategy:  `edge:${typeof data.strategy === 'string' ? data.strategy : 'unknown'}`,
            }
          }
        }
      } catch (err) {
        edgeFailure = classifyNetworkError(err)
      }
    }

    // ── Transporte 2: proxy allorigins.win con retry (mismo proveedor) ────────
    // URL de destino fija — el cliente nunca provee el endpoint.
    const target   = 'https://www.infodolar.com/cotizacion-dolar-provincia-cordoba.aspx'
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(target)}`

    let res: Response
    try {
      res = await fetchWithTimeoutAndRetry(proxyUrl, { timeoutMs: 15000, retries: 1, retryDelayMs: 800 })
    } catch (err) {
      return fail(source, edgeFailure ?? classifyNetworkError(err))
    }

    if (!res.ok) return fail(source, edgeFailure ?? 'http_error')

    let html = ''
    try {
      const json = await res.json()
      html = isRecord(json) && typeof json.contents === 'string' ? json.contents : ''
    } catch {
      return fail(source, 'invalid_payload')
    }

    if (!html) return fail(source, 'invalid_payload')

    const detail = extractInfoDolarCordobaRates(html)
    if (!detail || !isPlausibleRate(detail.venta)) return fail(source, 'missing_price')

    return {
      ok:        true,
      source,
      sell:      detail.venta,
      buy:       isPlausibleRate(detail.compra) && detail.compra < detail.venta ? detail.compra : null,
      fetchedAt: new Date().toISOString(),
      strategy:  `proxy:${detail.strategy}`,
    }
  },

  /**
   * Punto de entrada canónico. Resuelve la cotización de la fuente pedida.
   *
   * NUNCA sustituye la fuente: si `nacional` falla, devuelve el fallo de
   * `nacional`. La política previa consultaba la otra fuente en silencio y
   * guardaba el resultado como si fuera la configurada.
   */
  async fetchQuote(source: DolarSource): Promise<QuoteOutcome> {
    return source === 'cordoba' ? this.fetchCordoba() : this.fetchNacional()
  },

  /**
   * Compat: detalle compra/venta de Córdoba para el panel "Probar".
   * Devuelve null si la consulta falló — el motivo viaja en fetchCordoba().
   */
  async getDolarBlueCordobaDetail(): Promise<CordobaRateDetail | null> {
    const outcome = await this.fetchCordoba()
    if (!outcome.ok) return null
    return {
      compra:    outcome.buy ?? 0,
      venta:     outcome.sell,
      mode:      'venta',
      strategy:  outcome.strategy ?? 'unknown',
      fetchedAt: outcome.fetchedAt,
    }
  },

  formatLastUpdate(date: Date): string {
    return date.toLocaleString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  },

  // Exponer para tests unitarios
  _extractBlueVenta:                extractBlueVenta,
  _extractInfoDolarCordobaRates:    extractInfoDolarCordobaRates,
  _fetchWithTimeoutAndRetry:        fetchWithTimeoutAndRetry,
}
